import 'dotenv/config';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { upgradeParticulars } from './upgrade-particulars';

/**
 * Data steps run once, straight after the SQL migration they follow, and are recorded in
 * `schema_migrations` under their own name like a migration. Each must be idempotent, so a
 * database where the step was already run by hand is unaffected. Bump `version` only to re-run.
 */
const DATA_STEPS: {
  name: string;
  after: string;
  version: string;
  run: (db: Database.Database) => void;
}[] = [
  {
    name: 'data:0002-upgrade-particulars',
    after: '0002_annual_return.sql',
    version: '1',
    run: (db) => {
      const changed = upgradeParticulars(db);
      if (changed) console.log(`Converted the particulars of ${changed} people.`);
    },
  },
];

// Applies checksum-tracked SQL files in order. Each file runs in one IMMEDIATE transaction, so a
// failed migration leaves no partial schema, and a second migrator waits rather than racing.
export async function migrate(path = resolve(process.env.DATABASE_PATH ?? '.local/cosec.db')) {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: 20000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    /** Runs `apply` under the write lock unless `name` is recorded; refuses a changed checksum. */
    const once = (name: string, checksum: string, apply: () => void) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-checked under the write lock in case another migrator applied it meanwhile.
        const old = db.prepare('SELECT checksum FROM schema_migrations WHERE name=?').get(name) as
          { checksum: string } | undefined;
        if (old) {
          if (old.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
          db.exec('COMMIT');
          return;
        }
        apply();
        db.prepare('INSERT INTO schema_migrations(name,checksum) VALUES(?,?)').run(name, checksum);
        db.exec('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    };
    for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(`migrations/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      once(name, checksum, () => {
        for (const statement of sql
          .split('--> statement-breakpoint')
          .map((t) => t.trim())
          .filter(Boolean))
          db.exec(statement);
      });
      for (const step of DATA_STEPS.filter((d) => d.after === name))
        once(step.name, `data-step-v${step.version}`, () => step.run(db));
    }
    const problems = db.pragma('foreign_key_check') as unknown[];
    if (problems.length) throw new Error(`Foreign key check failed: ${problems.length} rows`);
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await migrate();
