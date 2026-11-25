import { afterAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../scripts/migrate';

// A throwaway database of its own, so the shared test database is not touched.
const path = resolve(`.local/test/migrate-${process.pid}-${Date.now()}.db`);
const remove = () =>
  Promise.all(['', '-wal', '-shm'].map((suffix) => rm(path + suffix, { force: true })));
afterAll(remove);

const dated = (value: string) => ({
  value,
  effectiveDate: '2020-01-01',
  recordedAt: '2026-11-01T00:00:00Z',
  actorId: 'someone',
  reason: 'Entered (fictional)',
});

describe('db:migrate', () => {
  it('upgrades first-shape particulars once, as a recorded data step after 0002', async () => {
    await migrate(path);
    let db = new Database(path);
    const step = () =>
      db
        .prepare("SELECT name FROM schema_migrations WHERE name LIKE 'data:%'")
        .all()
        .map((r) => (r as { name: string }).name);
    expect(step()).toEqual(['data:0002-upgrade-particulars']);
    // Make the database look like one migrated before the data step existed, holding a person
    // saved in the first director-forms shape.
    db.prepare("DELETE FROM schema_migrations WHERE name = 'data:0002-upgrade-particulars'").run();
    const person = {
      id: 'legacy-person',
      fullName: 'Legacy Person (fictional)',
      nameHistory: [],
      email: null,
      notes: '',
      customValues: {},
      createdBy: 'someone',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      revision: 1,
      particulars: {
        identityType: [dated('NRIC')],
        identityNumber: [dated('880516-14-5888')],
        gender: [dated('FEMALE')],
        residentialAddress: [dated('3 Jalan Contoh\nTaman Rekaan\n47000 Sungai Buloh')],
      },
    };
    db.prepare('INSERT INTO people (id, full_name, revision, data) VALUES (?, ?, 1, ?)').run(
      person.id,
      person.fullName,
      JSON.stringify(person),
    );
    db.close();

    await migrate(path);
    db = new Database(path);
    const read = () =>
      db.prepare('SELECT revision, data FROM people WHERE id = ?').get(person.id) as {
        revision: number;
        data: string;
      };
    const upgraded = read();
    expect(upgraded.revision).toBe(2);
    const particulars = JSON.parse(upgraded.data).particulars;
    expect(particulars.identityType[0].value).toBe('MyKad');
    expect(particulars.identityNumber[0].value).toBe('880516145888');
    expect(particulars.gender[0].value).toBe('Female');
    expect(particulars.residentialLine1[0].value).toBe('3 Jalan Contoh');
    expect(particulars.residentialAddress).toBeUndefined();
    expect(step()).toEqual(['data:0002-upgrade-particulars']);
    const audit = db
      .prepare("SELECT detail FROM audit_events WHERE action = 'person.particulars_upgraded'")
      .all() as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).not.toContain('880516');
    db.close();

    // Recorded, so a second run changes nothing.
    await migrate(path);
    db = new Database(path);
    expect(read().revision).toBe(2);
    db.close();
  });
});
