import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { inArray, lt } from 'drizzle-orm';
import { db, transaction } from '../db';
import * as s from '../schema';
import { getSettings } from '../repository';
import { gatewayCaller, gatewayConfig, type ModelCaller } from './gateway';
import { runCompany } from './agent';
import { claimRows, removeImportFiles, saveRow, tokensUsedToday } from './store';

/**
 * Picks up waiting company folders a few at a time ("Companies read at a time" on Settings) and
 * resumes any whose process stopped mid-read, for example after a restart. Several processes may
 * run this; a claim with a heartbeat keeps each company with one reader.
 */
const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const STALE_MS = 15 * 60_000;
const TICK_MS = 15_000;
const RETENTION_DAYS = 90;
const running = new Map<string, Promise<unknown>>();

export async function tickImports(call?: ModelCaller) {
  const settings = await getSettings();
  const config = gatewayConfig(settings);
  if (!config) return 0;
  // Nothing is picked up once today's token budget is spent; reading resumes tomorrow.
  if ((await tokensUsedToday()) >= config.dailyTokenLimit) return 0;
  const ids = await claimRows(OWNER, config.companiesAtOnce, new Date(Date.now() - STALE_MS));
  const caller = call ?? gatewayCaller(config);
  for (const id of ids) {
    if (running.has(id)) continue;
    const run = runCompany(id, { call: caller, config, owner: OWNER })
      .catch((error) =>
        console.error('Import reader stopped', error instanceof Error ? error.name : 'Unknown'),
      )
      .finally(() => running.delete(id));
    running.set(id, run);
  }
  return ids.length;
}
/** Waits for this process's readers; for tests and orderly shutdown. */
export async function settleImports() {
  while (running.size) await Promise.all([...running.values()]);
}

/**
 * Import data holds identity numbers and page quotes. Applied companies drop theirs at apply
 * time; anything older than 90 days is removed here with its stored files.
 */
export async function purgeOldImports(now = Date.now()) {
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const old = await db.select().from(s.imports).where(lt(s.imports.createdAt, cutoff));
  for (const batch of old) {
    if (batch.data.purgedAt) continue;
    await transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(s.importCompanies)
        .where(inArray(s.importCompanies.importId, [batch.id]));
      for (const r of rows) {
        const row = structuredClone(r.data);
        if (row.status !== 'Applied') row.status = 'Left out';
        row.suggestions = [];
        row.questions = [];
        row.files = row.files.map((f) => ({ ...f, storageKey: '' }));
        await saveRow(tx, row);
      }
      const data = {
        ...batch.data,
        status: 'Finished' as const,
        purgedAt: new Date(now).toISOString(),
        revision: batch.revision + 1,
      };
      await tx
        .update(s.imports)
        .set({ status: 'Finished', revision: data.revision, data })
        .where(inArray(s.imports.id, [batch.id]));
    });
    await removeImportFiles(batch.id);
  }
}

let started = false;
export function startImportRunner() {
  const global = globalThis as unknown as { cosecImportRunner?: boolean };
  if (started || global.cosecImportRunner) return;
  started = global.cosecImportRunner = true;
  let lastPurge = 0;
  const tick = async () => {
    try {
      await tickImports();
      if (Date.now() - lastPurge > 6 * 60 * 60_000) {
        lastPurge = Date.now();
        await purgeOldImports();
      }
    } catch (error) {
      console.error(
        'Import runner tick failed',
        error instanceof Error ? error.message : 'Unknown',
      );
    }
    setTimeout(() => void tick(), TICK_MS).unref();
  };
  setTimeout(() => void tick(), 5_000).unref();
}
