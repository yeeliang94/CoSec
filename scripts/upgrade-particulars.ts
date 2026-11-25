/**
 * Converts person particulars recorded in the first director-forms shape (16 Nov 2026) to mTool's
 * wording and structured addresses: NRIC becomes MyKad, MALE and FEMALE become Male and Female,
 * and a free-text address is split into lines 1 to 3. Postcode, town, state and country are not
 * guessed, so converted addresses show as incomplete until someone enters them.
 *
 * `npm run db:migrate` runs this once, as a recorded data step after 0002 (see scripts/migrate.ts).
 * It is safe to re-run by hand with `npm run db:upgrade-particulars`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { IDENTITY_KEYS, upgradeLegacyParticulars } from '../src/domain/resolution/particulars';
import type { Person } from '../src/domain/resolution/model';

const IDENTITY = new Set<string>(IDENTITY_KEYS);

/**
 * Upgrades every person whose particulars are in the first shape, one person per row update, with
 * an audit entry for each. Identity particulars are recorded as changed without their values. The
 * caller owns the transaction. Returns how many people changed.
 */
export function upgradeParticulars(db: Database.Database): number {
  const rows = db.prepare('SELECT id, revision, data FROM people').all() as {
    id: string;
    revision: number;
    data: string;
  }[];
  const update = db.prepare('UPDATE people SET revision = ?, data = ? WHERE id = ?');
  const audit = db.prepare(
    `INSERT INTO audit_events
      (id, actor_id, company_id, action, subject_id, detail, created_at, entity_type, request_id, reason, sensitivity, scope_company_ids)
      VALUES (?, 'system', NULL, 'person.particulars_upgraded', ?, ?, ?, 'person', NULL, ?, 'General', '[]')`,
  );
  let changed = 0;
  for (const row of rows) {
    const person = JSON.parse(row.data) as Person;
    const upgraded = upgradeLegacyParticulars(person.particulars);
    if (!upgraded) continue;
    const next: Person = {
      ...person,
      particulars: upgraded,
      revision: row.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    update.run(next.revision, JSON.stringify(next), row.id);
    const before = (person.particulars ?? {}) as Record<string, unknown>;
    const after = upgraded as Record<string, unknown>;
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) =>
        IDENTITY.has(key)
          ? { path: `particulars.${key}`, before: '[redacted]', after: '[redacted]' }
          : { path: `particulars.${key}`, before: before[key] ?? null, after: after[key] ?? null },
      );
    audit.run(
      randomUUID(),
      row.id,
      JSON.stringify({ changes, fromRevision: row.revision, toRevision: next.revision }),
      Date.now(),
      'Particulars converted to mTool wording and structured addresses',
    );
    changed++;
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new Database(resolve(process.env.DATABASE_PATH ?? '.local/cosec.db'), {
    timeout: 20000,
  });
  try {
    const changed = db.transaction(() => upgradeParticulars(db)).immediate();
    console.log(
      changed ? `Converted the particulars of ${changed} people.` : 'No particulars to convert.',
    );
  } finally {
    db.close();
  }
}
