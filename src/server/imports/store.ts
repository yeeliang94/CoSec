import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { getCompany, getSettings, prior, remember, requestKey } from '../repository';
import { assertCapability, assertCompany, DomainError, today } from '../../domain/access';
import type { Actor } from '../../domain/model';
import {
  emptyRun,
  fileKind,
  openQuestions,
  type ImportBatch,
  type ImportCompany,
  type ImportFile,
  type ImportTarget,
} from '../../domain/imports';
import { checkConnection, gatewayConfig, gatewayProblem, importSettingsOf } from './gateway';
import { readProfile } from '../records/profile';
import { companyRelationships } from '../records/relationships';
import { readShareEntries } from '../records/shares';
import { readCharges } from '../records/charges';
import { companyParticularsAt } from '../../domain/ar1/company';
import {
  maskIdentity,
  normaliseIdentity,
  particularsAt,
} from '../../domain/resolution/particulars';
import { assertPersonVisible, visiblePeople, visiblePersonIds } from '../records/scope';
import { personForActor } from '../records/people';
import { checkCompanyValue, correctSuggestion, isCoreKey, isDate } from './fields';
import { effectiveEntries } from '../../domain/ar1/shares';

export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FOLDERS = 300;
export const MAX_FILES_PER_COMPANY = 400;

const storageRoot = () =>
  path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_DIR || '.local/storage', 'imports');
export function importFilePath(importId: string, storageKey: string) {
  if (!/^[0-9a-f-]{36}$/.test(importId) || !/^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(storageKey))
    throw new DomainError('Import file reference is invalid.', 'STORAGE', 500);
  return path.join(/* turbopackIgnore: true */ storageRoot(), importId, storageKey);
}
export async function readImportBytes(importId: string, file: ImportFile) {
  if (!file.storageKey) throw new DomainError('This file was not kept.', 'NOT_FOUND', 404);
  // A missing or unreadable copy is a handled problem, so callers can report it, not hang on it.
  const bytes = await readFile(
    /* turbopackIgnore: true */ importFilePath(importId, file.storageKey),
  ).catch(() => {
    throw new DomainError('The stored copy of this file is missing.', 'STORAGE', 503);
  });
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new DomainError('The stored file failed its integrity check.', 'STORAGE', 503);
  return bytes;
}
/** Removes an import's stored files once nothing needs them. */
export async function removeImportFiles(importId: string) {
  if (!/^[0-9a-f-]{36}$/.test(importId)) return;
  await rm(path.join(/* turbopackIgnore: true */ storageRoot(), importId), {
    recursive: true,
    force: true,
  });
}

// ---------------------------------------------------------------- reads
async function readBatch(actor: Actor, id: string, tx?: Transaction) {
  const [row] = await (tx ?? db).select().from(s.imports).where(eq(s.imports.id, id));
  // An import belongs to the person who started it.
  if (!row || row.createdBy !== actor.id)
    throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
  return row.data;
}
export async function readRow(id: string, tx?: Transaction) {
  const [row] = await (tx ?? db)
    .select()
    .from(s.importCompanies)
    .where(eq(s.importCompanies.id, id));
  if (!row) throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
  return row.data;
}
async function batchRows(importId: string, tx?: Transaction) {
  return (
    await (tx ?? db)
      .select()
      .from(s.importCompanies)
      .where(eq(s.importCompanies.importId, importId))
  ).map((r) => r.data);
}

/** Saves a changed row: bumps its revision and keeps the status column in step. */
export async function saveRow(tx: Transaction, next: ImportCompany) {
  next.revision += 1;
  await tx
    .update(s.importCompanies)
    .set({ status: next.status, revision: next.revision, data: next })
    .where(eq(s.importCompanies.id, next.id));
  return next;
}
/** Applies `fn` to the latest copy of a row in one transaction. */
export function updateRow(id: string, fn: (row: ImportCompany) => void | ImportCompany) {
  return transaction(async (tx) => {
    const row = structuredClone(await readRow(id, tx));
    const next = fn(row) ?? row;
    return saveRow(tx, next);
  });
}

const summary = (row: ImportCompany) => ({
  id: row.id,
  folder: row.folder,
  name: row.name,
  registrationNumber: row.registrationNumber,
  target: row.target,
  status: row.status,
  files: row.files.length,
  filesRead: row.run.read.length,
  suggestions: row.suggestions.length,
  openQuestions: openQuestions(row).length,
  error: row.run.error,
  applied: row.applied,
});
export type ImportRowSummary = ReturnType<typeof summary>;

export async function listImports(actor: Actor) {
  const batches = await db.select().from(s.imports).where(eq(s.imports.createdBy, actor.id));
  const ids = batches.map((b) => b.id);
  const rows = ids.length
    ? await db
        .select({ importId: s.importCompanies.importId, status: s.importCompanies.status })
        .from(s.importCompanies)
        .where(inArray(s.importCompanies.importId, ids))
    : [];
  return {
    imports: batches
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((b) => {
        const mine = rows.filter((r) => r.importId === b.id && r.status !== 'Left out');
        return {
          ...b.data,
          companies: mine.length,
          applied: mine.filter((r) => r.status === 'Applied').length,
          waitingOnYou: mine.filter((r) => ['Needs answer', 'Ready'].includes(r.status)).length,
        };
      }),
    gatewayProblem: gatewayProblem(importSettingsOf(await getSettings())),
  };
}

export async function getImport(actor: Actor, id: string) {
  const batch = await readBatch(actor, id);
  const rows = (await batchRows(id)).map((row) => rowForActor(actor, row));
  const settings = importSettingsOf(await getSettings());
  return {
    batch,
    companies: rows.map(summary).sort((a, b) => a.name.localeCompare(b.name)),
    files: rows.flatMap((row) =>
      row.files.map((f) => ({
        ...f,
        companyRowId: row.id,
        companyName: row.name,
      })),
    ),
    reading: rows.filter((r) => r.status === 'Reading').length,
    waiting: rows.filter((r) => r.status === 'Waiting').length,
    gatewayProblem: gatewayProblem(settings),
  };
}

/** What the app holds today for an existing company, for comparison and for the agent. */
export async function currentRecord(actor: Actor, companyId: string) {
  // Also guards the background reader: a creator who lost access gets nothing to send on.
  assertCompany(actor, companyId);
  const company = await getCompany(companyId);
  const [profile, relationships, entries, charges] = await Promise.all([
    readProfile(companyId),
    companyRelationships(companyId),
    readShareEntries(companyId),
    readCharges(companyId),
  ]);
  const personIds = [...new Set(relationships.map((r) => r.personId))];
  const people = personIds.length
    ? (await db.select().from(s.people).where(inArray(s.people.id, personIds))).map((r) => r.data)
    : [];
  const unmasked = actor.capabilities.includes('view_identity');
  const asAt = today();
  return {
    company: {
      name: company.name,
      registrationNumber: company.registrationNumber,
      incorporationDate: company.incorporationDate,
      financialYearEnd: company.financialYearEnd.slice(-5),
      industry: company.industry ?? '',
      activity: company.activity,
      ...companyParticularsAt(profile.particulars, asAt),
    } as Record<string, string>,
    verification: company.verification,
    people: people.map((p) => {
      const values = particularsAt(p, asAt) as Record<string, string | null>;
      const id = typeof values.identityNumber === 'string' ? values.identityNumber : '';
      return {
        id: p.id,
        fullName: p.fullName,
        kind: p.kind ?? 'individual',
        identityType: values.identityType ?? '',
        identityNumber: id && !unmasked ? maskIdentity(id) : id,
      };
    }),
    roles: relationships.map((r) => ({
      personId: r.personId,
      personName: r.personName,
      role: r.role,
      startDate: r.startDate,
      endDate: r.endDate,
    })),
    shareClasses: profile.shareClasses ?? [],
    shareEntries: effectiveEntries(entries).length,
    shareDrafts: entries.filter((e) => e.status === 'Draft').length,
    charges: charges.map((c) => ({ registeredNumber: c.registeredNumber, chargee: c.chargee })),
    revisions: { company: company.revision, profile: profile.revision },
  };
}
export type CurrentRecord = Awaited<ReturnType<typeof currentRecord>>;

/**
 * People already in the app with this identity number, whoever can see them. The caller learns
 * a hidden match exists but none of its details.
 */
export async function findByIdentity(actor: Actor, identityType: string | null, number: string) {
  const wanted = normaliseIdentity(identityType, number).toUpperCase();
  if (!wanted || wanted.includes('*')) return [];
  const rows = await db.select().from(s.people);
  const hits = rows.filter((r) => {
    const value = particularsAt(r.data, today()).identityNumber;
    return (
      typeof value === 'string' && normaliseIdentity(identityType, value).toUpperCase() === wanted
    );
  });
  if (!hits.length) return [];
  const visible = new Set(await visiblePersonIds(actor, { ids: hits.map((h) => h.id) }));
  return hits.map((h) =>
    visible.has(h.id)
      ? { personId: h.id, visible: true as const, fullName: h.fullName }
      : { personId: null, visible: false as const, fullName: null },
  );
}

/** People this actor can see whose name matches exactly, ignoring case and spacing. */
export async function findByName(actor: Actor, fullName: string) {
  const key = fullName.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key) return [];
  const { ids } = await visiblePeople(actor, { q: fullName.trim(), limit: 50 });
  if (!ids.length) return [];
  const rows = await db
    .select({ id: s.people.id, fullName: s.people.fullName })
    .from(s.people)
    .where(inArray(s.people.id, ids));
  return rows
    .filter((r) => r.fullName.trim().replace(/\s+/g, ' ').toLowerCase() === key)
    .map((r) => ({ personId: r.id, fullName: r.fullName }));
}

export async function getImportCompany(actor: Actor, importId: string, rowId: string) {
  const batch = await readBatch(actor, importId);
  const row = await readRow(rowId);
  if (row.importId !== batch.id)
    throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
  const companyId =
    row.applied?.companyId ?? (row.target.mode === 'existing' ? row.target.companyId : null);
  if (companyId) assertCompany(actor, companyId);
  const current = companyId ? await currentRecord(actor, companyId) : null;
  // Identity matches are worked out now, so the review shows who each person is.
  const matches: Record<
    string,
    { personId: string | null; visible: boolean; fullName: string | null }[]
  > = {};
  for (const sug of row.suggestions)
    if (sug.kind === 'person' && sug.values.identityNumber)
      matches[sug.ref] = await findByIdentity(
        actor,
        sug.values.identityType ?? null,
        sug.values.identityNumber,
      );
  // Someone with the same name and no identity number to compare is a possible duplicate,
  // which the reviewer settles; it is never merged silently.
  const nameMatches: Record<string, { personId: string; fullName: string }[]> = {};
  for (const sug of row.suggestions)
    if (sug.kind === 'person' && !matches[sug.ref]?.length)
      nameMatches[sug.ref] = await findByName(actor, sug.fullName);
  // What the app holds today for each person the import would update, for comparison.
  const personValues: Record<string, Record<string, string>> = {};
  for (const sug of row.suggestions) {
    if (sug.kind !== 'person') continue;
    // The same person Apply would update: an identity match first, then the reviewer's choice.
    const personId = matches[sug.ref]?.length
      ? matches[sug.ref].find((m) => m.visible)?.personId
      : sug.linkTo;
    if (!personId) continue;
    try {
      await assertPersonVisible(actor, personId);
    } catch {
      continue;
    }
    const [person] = await db.select().from(s.people).where(eq(s.people.id, personId));
    if (!person) continue;
    const values = particularsAt(personForActor(actor, person.data), today());
    personValues[sug.ref] = Object.fromEntries(
      Object.entries(values).flatMap(([k, v]) =>
        typeof v === 'string' && v ? [[k, v]] : v === null && k in sug.values ? [[k, HIDDEN]] : [],
      ),
    );
  }
  return {
    batch,
    nameMatches,
    personValues,
    row: rowForActor(actor, row),
    current,
    matches,
    gatewayProblem: gatewayProblem(importSettingsOf(await getSettings())),
  };
}

/**
 * Free text (quotes, page text, questions) as someone without view_identity sees it: MyKad-style
 * numbers, and every identity number the row's people carry, in any format, are masked.
 */
export function maskIdentities(text: string, known: string[] = []) {
  let out = text.replace(/\b\d{6}-?\d{2}-?\d{4}\b/g, (m) => maskIdentity(m));
  for (const id of known) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(id);
    if (date) {
      out = out.replace(datePattern(date[1], date[2], date[3]), HIDDEN);
      continue;
    }
    if (id.length < 5) continue;
    // Match the number with or without the separators documents put in it.
    const pattern = id
      .replace(/[\s-]/g, '')
      .split('')
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s-]?');
    out = out.replace(new RegExp(pattern, 'gi'), (m) => maskIdentity(m));
  }
  return out;
}
/** Identity numbers, and birth and passport expiry dates of individuals, that the row's people carry. */
export const knownIdentities = (row: ImportCompany) =>
  row.suggestions.flatMap((s) =>
    s.kind !== 'person'
      ? []
      : [
          s.values.identityNumber,
          ...(s.personKind === 'organisation'
            ? []
            : [s.values.dateOfBirth, s.values.passportExpiry]),
        ].filter((v): v is string => Boolean(v)),
  );
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A date written as documents write it: 1980-03-12, 12/03/1980, 12.3.80, 12 March 1980, 12 Mar 1980. */
function datePattern(y: string, m: string, d: string) {
  const dd = `0?${Number(d)}`;
  const mm = `0?${Number(m)}`;
  const yy = `(?:${y}|${y.slice(2)})`;
  const mon = `${MONTHS[Number(m) - 1]}[a-z]*\\.?`;
  return new RegExp(
    `\\b(?:${y}[-/.]${mm}[-/.]${dd}|${dd}[-/.]${mm}[-/.]${yy}|${dd}(?:st|nd|rd|th)?\\s+${mon},?\\s+${y}|${mon}\\s+${dd},?\\s+${y})\\b`,
    'gi',
  );
}
/** What a hidden particular shows as. */
export const HIDDEN = 'Hidden';
/** A row as someone without view_identity sees it. */
export function maskRow(row: ImportCompany): ImportCompany {
  const known = knownIdentities(row);
  const copy = structuredClone(row);
  for (const sug of copy.suggestions) {
    if (sug.kind === 'person' && sug.values.identityNumber)
      sug.values.identityNumber = maskIdentity(sug.values.identityNumber);
    // The same particulars the People pages hide from someone without view_identity.
    if (sug.kind === 'person' && sug.personKind !== 'organisation')
      for (const key of ['dateOfBirth', 'passportExpiry'])
        if (sug.values[key]) sug.values[key] = HIDDEN;
    sug.source.quote = maskIdentities(sug.source.quote, known);
    // The agent's earlier version is only for matching on a re-read; it may hold identity numbers.
    delete sug.original;
  }
  for (const q of copy.questions) {
    q.text = maskIdentities(q.text, known);
    for (const c of q.choices) {
      c.label = maskIdentities(c.label, known);
      if (c.source) c.source.quote = maskIdentities(c.source.quote, known);
    }
  }
  // The agent writes these in its own words, so they may repeat a number it read.
  for (const f of copy.files) {
    f.readAs = maskIdentities(f.readAs, known);
    f.note = maskIdentities(f.note, known);
    if (f.otherCompany) f.otherCompany = maskIdentities(f.otherCompany, known);
  }
  copy.run.summary = maskIdentities(copy.run.summary, known);
  copy.run.notFound = copy.run.notFound.map((n) => maskIdentities(n, known));
  if (copy.run.error) copy.run.error = maskIdentities(copy.run.error, known);
  return copy;
}
export const rowForActor = (actor: Actor, row: ImportCompany) =>
  actor.capabilities.includes('view_identity') ? row : maskRow(row);

export async function readImportFile(actor: Actor, importId: string, fileId: string) {
  await readBatch(actor, importId);
  const rows = await batchRows(importId);
  for (const row of rows) {
    const file = row.files.find((f) => f.id === fileId);
    if (!file) continue;
    if (row.target.mode === 'existing') assertCompany(actor, row.target.companyId);
    return { file, row, bytes: await readImportBytes(importId, file) };
  }
  throw new DomainError('File not found.', 'NOT_FOUND', 404);
}

// ---------------------------------------------------------------- writes
const targetInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), companyId: z.string().min(1).max(64) }),
  z.object({ mode: z.literal('new') }),
  z.object({ mode: z.literal('leave_out') }),
]);
export const createImportInput = z.object({
  requestId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  looseFiles: z.number().int().min(0).max(100_000),
  folders: z
    .array(z.object({ folder: z.string().trim().min(1).max(255), target: targetInput }))
    .min(1, 'Choose a folder with at least one company folder inside.')
    .max(MAX_FOLDERS, `Import up to ${MAX_FOLDERS} company folders at a time.`),
});

export async function createImport(actor: Actor, input: z.infer<typeof createImportInput>) {
  assertCapability(actor, 'prepare_job');
  const problem = gatewayProblem(importSettingsOf(await getSettings()));
  if (problem) throw new DomainError(problem, 'IMPORT_OFF', 409);
  const seen = new Set<string>();
  for (const f of input.folders) {
    if (seen.has(f.folder)) throw new DomainError(`The folder "${f.folder}" is listed twice.`);
    seen.add(f.folder);
    if (f.target.mode === 'existing') assertCompany(actor, f.target.companyId);
  }
  const used = input.folders.flatMap((f) =>
    f.target.mode === 'existing' ? [f.target.companyId] : [],
  );
  if (new Set(used).size !== used.length)
    throw new DomainError('Two folders point to the same company. Choose one, or leave one out.');
  const key = requestKey(actor, 'import:create', input.requestId);
  return transaction(async (tx) => {
    const old = await prior(tx, key);
    if (old) return readBatch(actor, old.id, tx);
    const now = new Date();
    const batch: ImportBatch = {
      id: randomUUID(),
      name: input.name,
      createdBy: actor.id,
      createdAt: now.toISOString(),
      status: 'Uploading',
      looseFiles: input.looseFiles,
      revision: 1,
    };
    await tx.insert(s.imports).values({
      id: batch.id,
      createdBy: actor.id,
      status: batch.status,
      revision: 1,
      createdAt: now,
      data: batch,
    });
    for (const f of input.folders) {
      const existing =
        f.target.mode === 'existing' ? await getCompany(f.target.companyId, tx) : null;
      const row: ImportCompany = {
        id: randomUUID(),
        importId: batch.id,
        folder: f.folder,
        target: f.target as ImportTarget,
        name: existing?.name ?? f.folder,
        registrationNumber: existing?.registrationNumber ?? '',
        status: f.target.mode === 'leave_out' ? 'Left out' : 'Uploading',
        files: [],
        suggestions: [],
        questions: [],
        run: emptyRun(),
        applied: null,
        revision: 1,
      };
      await tx.insert(s.importCompanies).values({
        id: row.id,
        importId: batch.id,
        status: row.status,
        revision: 1,
        data: row,
      });
    }
    await remember(tx, key, { id: batch.id, revision: 1 });
    return batch;
  });
}

/** Stores one uploaded file in its company folder. Unreadable types are listed, not kept. */
export async function addImportFile(
  actor: Actor,
  importId: string,
  input: { rowId: string; path: string; size: number; file: File | null },
) {
  assertCapability(actor, 'prepare_job');
  const batch = await readBatch(actor, importId);
  if (batch.status !== 'Uploading') throw new DomainError('This import has already started.');
  const row = await readRow(input.rowId);
  if (row.importId !== importId || row.status !== 'Uploading')
    throw new DomainError('This company folder is not taking files.');
  const relative = input.path.replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 500);
  const name =
    path.posix
      .basename(relative)
      .replace(/[\r\n\x00-\x1f]/g, '')
      .slice(0, 200) || 'file';
  // A retried upload whose first reply was lost is answered with the file already kept.
  const earlier = row.files.find((f) => f.path === relative);
  if (earlier) return { id: earlier.id, result: earlier.result };
  if (row.files.length >= MAX_FILES_PER_COMPANY)
    throw new DomainError(`A company folder can hold up to ${MAX_FILES_PER_COMPANY} files.`);
  const kind = fileKind(name);
  const file: ImportFile = {
    id: randomUUID(),
    path: relative,
    name,
    size: input.file?.size ?? input.size,
    sha256: '',
    storageKey: '',
    kind,
    pages: null,
    readAs: '',
    result: 'Waiting',
    note: '',
  };
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    file.result = 'Could not read';
    file.note = 'over 50 MB';
  } else if (kind === 'other') {
    file.result = 'Could not read';
    file.note = /\.(xls|doc)$/i.test(name)
      ? 'old Office format; save it as .xlsx or .docx'
      : 'this file type is not read';
  } else if (!input.file) {
    throw new DomainError('Choose a file.');
  } else {
    const bytes = Buffer.from(await input.file.arrayBuffer());
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.storageKey = `${randomUUID()}.${
      name
        .split('.')
        .pop()!
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 5) || 'bin'
    }`;
    const destination = importFilePath(importId, file.storageKey);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  let kept: ImportFile = file;
  try {
    await updateRow(row.id, (r) => {
      if (r.status !== 'Uploading')
        throw new DomainError('This company folder is not taking files.');
      const twin = r.files.find((f) => f.path === file.path);
      if (twin) kept = twin;
      else r.files.push(file);
    });
  } catch (error) {
    if (file.storageKey) await rm(importFilePath(importId, file.storageKey), { force: true });
    throw error;
  }
  if (kept !== file && file.storageKey)
    await rm(importFilePath(importId, file.storageKey), { force: true });
  return { id: kept.id, result: kept.result };
}

export const batchActionInput = z.object({
  action: z.enum(['start', 'pause', 'resume', 'discard']),
});
export async function changeImport(
  actor: Actor,
  id: string,
  input: z.infer<typeof batchActionInput>,
) {
  assertCapability(actor, 'prepare_job');
  if (input.action === 'discard') return discardImport(actor, id);
  return transaction(async (tx) => {
    const batch = structuredClone(await readBatch(actor, id, tx));
    if (input.action === 'start') {
      if (batch.status !== 'Uploading') return batch;
      batch.status = 'Running';
      for (const row of await batchRows(id, tx))
        if (row.status === 'Uploading')
          await saveRow(tx, {
            ...structuredClone(row),
            status: row.files.length ? 'Waiting' : 'Ready',
          });
    } else if (input.action === 'pause') {
      if (batch.status !== 'Running') throw new DomainError('This import is not running.');
      batch.status = 'Paused';
    } else {
      if (batch.status !== 'Paused') throw new DomainError('This import is not paused.');
      batch.status = 'Running';
    }
    batch.revision += 1;
    await tx
      .update(s.imports)
      .set({ status: batch.status, revision: batch.revision, data: batch })
      .where(eq(s.imports.id, id));
    return batch;
  });
}

/** Removes an import whose upload was cancelled before it started; nothing was read from it. */
async function discardImport(actor: Actor, id: string) {
  const batch = await transaction(async (tx) => {
    const found = await readBatch(actor, id, tx);
    if (found.status !== 'Uploading')
      throw new DomainError('Only an import that has not started can be discarded.');
    await tx.delete(s.importCompanies).where(eq(s.importCompanies.importId, id));
    await tx.delete(s.imports).where(eq(s.imports.id, id));
    return found;
  });
  await removeImportFiles(id);
  return batch;
}

export const rowActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_use'),
    expectedRevision: z.number().int(),
    suggestionIds: z.array(z.string().max(64)).min(1).max(2000),
    use: z.boolean(),
  }),
  z.object({
    action: z.literal('answer'),
    expectedRevision: z.number().int(),
    questionId: z.string().max(64),
    choice: z.number().int().min(0).max(20).nullable(),
    text: z.string().trim().max(2000).default(''),
  }),
  z.object({
    action: z.literal('move_file'),
    fileId: z.string().max(64),
    toRowId: z.string().max(64).nullable(),
  }),
  z.object({ action: z.literal('leave_out'), expectedRevision: z.number().int() }),
  z.object({ action: z.literal('run_again'), expectedRevision: z.number().int() }),
  z.object({
    action: z.literal('set_value'),
    expectedRevision: z.number().int(),
    key: z.string().min(1).max(60),
    value: z.string().trim().min(1).max(2000),
    effectiveDate: z.string().max(10).nullable().default(null),
  }),
  z.object({
    action: z.literal('correct'),
    expectedRevision: z.number().int(),
    suggestionId: z.string().max(64),
    fields: z.record(z.string().max(60), z.string().max(2000).nullable()),
  }),
  z.object({
    action: z.literal('set_link'),
    expectedRevision: z.number().int(),
    suggestionId: z.string().max(64),
    personId: z.string().max(64).nullable(),
  }),
]);

const REVIEWABLE = ['Needs answer', 'Ready'];
export async function changeImportRow(
  actor: Actor,
  importId: string,
  rowId: string,
  input: z.infer<typeof rowActionInput>,
) {
  assertCapability(actor, 'prepare_job');
  const batch = await readBatch(actor, importId);
  // A person picked as "same as" must be someone this reviewer can see.
  if (input.action === 'set_link' && input.personId)
    await assertPersonVisible(actor, input.personId);
  return transaction(async (tx) => {
    const row = structuredClone(await readRow(rowId, tx));
    if (row.importId !== importId)
      throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
    if (row.target.mode === 'existing') assertCompany(actor, row.target.companyId);
    if ('expectedRevision' in input && input.expectedRevision !== row.revision)
      throw new DomainError(
        'This company changed while you were looking. Refresh and try again.',
        'STALE',
        409,
      );
    if (row.status === 'Applied') throw new DomainError('This company has already been applied.');
    if (input.action === 'set_use') {
      if (!REVIEWABLE.includes(row.status))
        throw new DomainError('This company is still being read.');
      const ids = new Set(input.suggestionIds);
      for (const sug of row.suggestions) if (ids.has(sug.id)) sug.use = input.use;
    } else if (input.action === 'answer') {
      if (!REVIEWABLE.includes(row.status))
        throw new DomainError('This company is still being read.');
      const question = row.questions.find((q) => q.id === input.questionId);
      if (!question) throw new DomainError('Question not found.', 'NOT_FOUND', 404);
      if (input.choice === null && !input.text)
        throw new DomainError('Choose an answer or write one.');
      if (input.choice !== null && !question.choices[input.choice])
        throw new DomainError('Choose one of the listed answers.');
      question.answer = {
        choice: input.choice,
        text: input.text,
        by: actor.id,
        at: new Date().toISOString(),
      };
      question.settled = false;
      // Once every question has an answer, the agent reads the answers and updates its suggestions.
      if (!openQuestions(row).length) row.status = 'Waiting';
    } else if (input.action === 'move_file') {
      const file = row.files.find((f) => f.id === input.fileId);
      if (!file) throw new DomainError('File not found.', 'NOT_FOUND', 404);
      if (row.status === 'Reading')
        throw new DomainError(`${row.name} is being read. Try again when it has finished.`);
      // Values taken from a file that leaves this company no longer belong to it.
      if (input.toRowId !== row.id)
        row.suggestions = row.suggestions.filter((s) => s.source.fileId !== file.id);
      if (input.toRowId === null) {
        file.result = 'Not used';
        file.note = 'left out by you';
        file.leftOut = true;
      } else {
        delete file.leftOut;
        if (input.toRowId === row.id) {
          file.result = 'Waiting';
          file.note = '';
          delete file.otherCompany;
          if (!['Reading', 'Waiting'].includes(row.status)) row.status = 'Waiting';
        } else {
          const target = structuredClone(await readRow(input.toRowId, tx));
          if (target.importId !== importId)
            throw new DomainError('Choose a company in this import.');
          if (target.status === 'Applied' || target.status === 'Left out')
            throw new DomainError(
              'That company is already applied or left out; it cannot take more files.',
            );
          if (target.status === 'Reading')
            throw new DomainError(`${target.name} is being read. Try again when it has finished.`);
          if (target.target.mode === 'existing') assertCompany(actor, target.target.companyId);
          row.files = row.files.filter((f) => f.id !== file.id);
          target.files.push({
            ...file,
            result: 'Waiting',
            note: '',
            movedFrom: row.folder,
            otherCompany: undefined,
          });
          // The receiving company is read again for the new file.
          if (!['Reading', 'Uploading'].includes(target.status)) target.status = 'Waiting';
          await saveRow(tx, target);
        }
      }
    } else if (input.action === 'leave_out') {
      if (row.status === 'Reading')
        throw new DomainError('Pause the import before leaving this company out.');
      row.status = 'Left out';
    } else if (input.action === 'set_value') {
      if (!REVIEWABLE.includes(row.status))
        throw new DomainError('This company is still being read.');
      if (row.target.mode === 'existing' && isCoreKey(input.key))
        throw new DomainError('An import does not change this field on an existing company.');
      const checked = checkCompanyValue(input.key, input.value);
      if (checked.error) throw new DomainError(checked.error);
      if (input.effectiveDate && !isDate(input.effectiveDate))
        throw new DomainError('Enter the date as YYYY-MM-DD.');
      const before = row.suggestions.find((s) => s.kind === 'company' && s.key === input.key);
      row.suggestions = row.suggestions.filter(
        (s) => !(s.kind === 'company' && s.key === input.key),
      );
      row.suggestions.push({
        id: before?.id ?? 'S' + randomUUID().slice(0, 8),
        kind: 'company',
        key: input.key,
        value: checked.value,
        effectiveDate:
          input.effectiveDate ?? (before?.kind === 'company' ? before.effectiveDate : null),
        source: { fileId: '', page: null, quote: `Entered by ${actor.name}` },
        use: true,
      });
    } else if (input.action === 'correct') {
      if (!REVIEWABLE.includes(row.status))
        throw new DomainError('This company is still being read.');
      const sug = row.suggestions.find((s) => s.id === input.suggestionId);
      if (!sug) throw new DomainError('Suggestion not found.', 'NOT_FOUND', 404);
      if (sug.kind === 'company')
        throw new DomainError('Correct a company value with the form under its table.');
      const { next, errors } = correctSuggestion(
        sug,
        input.fields,
        actor.capabilities.includes('view_identity'),
      );
      if (errors.length) throw new DomainError(errors.join(' '));
      if (next.kind === 'person' && sug.kind === 'person') {
        const id = next.values.identityNumber;
        const twin = row.suggestions.find(
          (s) => s.kind === 'person' && s.id !== sug.id && id && s.values.identityNumber === id,
        );
        if (twin?.kind === 'person')
          throw new DomainError(`${twin.fullName} already has this identity number.`);
        // A changed name or identity number needs the "same person" choice made again.
        if (
          next.fullName !== sug.fullName ||
          next.values.identityType !== sug.values.identityType ||
          id !== sug.values.identityNumber
        )
          delete next.linkTo;
      }
      const { id: _id, use: _use, source: _source, original, correctedBy: _by, ...was } = sug;
      row.suggestions = row.suggestions.map((s) =>
        s.id === sug.id
          ? {
              ...next,
              use: sug.use,
              error: undefined,
              correctedBy: actor.name,
              original: original ?? was,
            }
          : s,
      );
    } else if (input.action === 'set_link') {
      if (!REVIEWABLE.includes(row.status))
        throw new DomainError('This company is still being read.');
      const person = row.suggestions.find((s) => s.id === input.suggestionId);
      if (person?.kind !== 'person') throw new DomainError('Person not found.', 'NOT_FOUND', 404);
      person.linkTo = input.personId;
    } else {
      if (batch.status === 'Finished')
        throw new DomainError(
          'This import has finished and its files are removed. Start a new import.',
        );
      if (!['Could not finish', 'Ready', 'Needs answer', 'Left out'].includes(row.status))
        throw new DomainError('This company is already waiting or being read.');
      row.status = 'Waiting';
      row.run = {
        ...row.run,
        error: null,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        turns: 0,
      };
    }
    return rowForActor(actor, await saveRow(tx, row));
  });
}

export async function checkGateway(actor: Actor) {
  assertCapability(actor, 'manage_catalogue');
  const settings = await getSettings();
  const problem = gatewayProblem(importSettingsOf(settings));
  if (problem) throw new DomainError(problem, 'IMPORT_OFF', 409);
  try {
    return await checkConnection(gatewayConfig(settings)!);
  } catch (error) {
    throw new DomainError(
      error instanceof Error ? error.message : 'The gateway check failed.',
      'GATEWAY',
      502,
    );
  }
}

/** Rows a runner may pick up: waiting, or reading with a stale claim (a stopped process). */
export async function claimRows(owner: string, limit: number, staleBefore: Date) {
  if (limit <= 0) return [];
  return transaction(async (tx) => {
    const running = (
      await tx.select({ id: s.imports.id }).from(s.imports).where(eq(s.imports.status, 'Running'))
    ).map((r) => r.id);
    if (!running.length) return [];
    const candidates = await tx
      .select()
      .from(s.importCompanies)
      .where(
        and(
          inArray(s.importCompanies.importId, running),
          inArray(s.importCompanies.status, ['Waiting', 'Reading']),
        ),
      );
    const fresh = candidates.filter(
      (c) => c.status === 'Reading' && c.claimedAt && c.claimedAt >= staleBefore,
    ).length;
    const room = Math.max(0, limit - fresh);
    const picked = candidates
      .filter((c) => c.status === 'Waiting' || !c.claimedAt || c.claimedAt < staleBefore)
      .slice(0, room);
    const now = new Date();
    for (const c of picked) {
      const next = structuredClone(c.data);
      next.status = 'Reading';
      if (!next.run.startedAt) next.run.startedAt = now.toISOString();
      next.revision += 1;
      await tx
        .update(s.importCompanies)
        .set({
          status: 'Reading',
          claimedBy: owner,
          claimedAt: now,
          revision: next.revision,
          data: next,
        })
        .where(eq(s.importCompanies.id, c.id));
    }
    return picked.map((c) => c.id);
  });
}
export async function heartbeat(id: string, owner: string) {
  await transaction((tx) =>
    tx
      .update(s.importCompanies)
      .set({ claimedAt: new Date() })
      .where(and(eq(s.importCompanies.id, id), eq(s.importCompanies.claimedBy, owner))),
  );
}
export async function releaseClaim(id: string, owner: string, tx: Transaction) {
  await tx
    .update(s.importCompanies)
    .set({ claimedBy: null, claimedAt: null })
    .where(and(eq(s.importCompanies.id, id), eq(s.importCompanies.claimedBy, owner)));
}
export async function batchStatus(importId: string, tx?: Transaction) {
  const [row] = await (tx ?? db)
    .select({ status: s.imports.status })
    .from(s.imports)
    .where(eq(s.imports.id, importId));
  return row?.status ?? null;
}
/** Tokens used today across all imports, for the daily limit. */
export async function tokensUsedToday() {
  const rows = await db.select({ data: s.importCompanies.data }).from(s.importCompanies);
  const day = today();
  return rows.reduce((sum, r) => sum + (r.data.run.usageByDay?.[day] ?? 0), 0);
}
