import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closeDatabase, db, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson, getPerson, listPeople } from '../src/server/records/people';
import { queryAudit } from '../src/server/records/audit';
import { particularsAt } from '../src/domain/resolution/particulars';
import { defaultPreferences, type Actor } from '../src/domain/model';

const tag = randomBytes(4).toString('hex');
const manager: Actor = {
  id: randomUUID(),
  name: 'Particulars manager (test)',
  email: `pp-manager-${tag}@example.invalid`,
  capabilities: ['prepare_job', 'manage_people', 'view_identity', 'view_audit'],
  companyIds: [],
  preferences: defaultPreferences,
};
// The same account without view_identity, so it still sees the unlinked person it created.
const masked: Actor = {
  ...manager,
  capabilities: ['prepare_job', 'manage_people', 'view_audit'],
};
const NRIC = '880516-14-5888'; // fictional, as typed
const STORED = '880516145888'; // as stored, without dashes like mTool
const DOB = '1988-05-16';

beforeAll(async () => {
  await writerDb.insert(s.user).values({
    id: manager.id,
    name: manager.name,
    email: manager.email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    capabilities: manager.capabilities,
    companyIds: manager.companyIds,
    preferences: manager.preferences,
    active: true,
  });
});
afterAll(() => closeDatabase());

describe('person particulars', () => {
  it('records dated particulars, audits without identity values and masks for others', async () => {
    const person = await changePerson(manager, {
      action: 'create',
      requestId: randomUUID(),
      fullName: `Particulars Person ${tag} (fictional)`,
    });
    expect(person.particulars).toBeUndefined();
    const first = await changePerson(manager, {
      action: 'set_particulars',
      id: person.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      values: {
        identityType: 'MyKad',
        identityNumber: NRIC,
        dateOfBirth: DOB,
        occupation: 'ENGINEER',
        residentialLine1: '1 Fictional Road',
        residentialPostcode: '50450',
        residentialTown: 'Kuala Lumpur',
        residentialState: 'W.P. KUALA LUMPUR',
        residentialCountry: 'MALAYSIA',
        gender: '',
      },
      effectiveDate: '2024-01-01',
      reason: 'From the fictional consent form',
    });
    expect(first.revision).toBe(2);
    // The empty gender is not a change, so it gets no dated value.
    expect(Object.keys(first.particulars ?? {}).sort()).toEqual(
      [
        'dateOfBirth',
        'identityNumber',
        'identityType',
        'occupation',
        'residentialLine1',
        'residentialPostcode',
        'residentialTown',
        'residentialState',
        'residentialCountry',
      ].sort(),
    );
    const second = await changePerson(manager, {
      action: 'set_particulars',
      id: person.id,
      expectedRevision: 2,
      requestId: randomUUID(),
      // Unchanged NRIC is skipped; only the occupation gets a new dated value.
      values: { identityNumber: NRIC, occupation: 'COMPANY DIRECTOR' },
      effectiveDate: '2026-03-01',
      reason: 'Promoted',
    });
    expect(second.particulars?.identityNumber).toHaveLength(1);
    expect(second.particulars?.occupation?.map((v) => v.value)).toEqual([
      'ENGINEER',
      'COMPANY DIRECTOR',
    ]);
    expect(particularsAt(second, '2025-12-31').occupation).toBe('ENGINEER');
    expect(particularsAt(second, '2026-03-01').occupation).toBe('COMPANY DIRECTOR');

    // Audit: the identity paths are recorded as changed, never with their values.
    const audit = await queryAudit(manager, {
      entityId: person.id,
      action: 'person.particulars_set',
    });
    expect(audit.entries).toHaveLength(2);
    const text = JSON.stringify(audit.entries);
    expect(text).not.toContain(STORED);
    expect(text).not.toContain('880516');
    expect(text).not.toContain(DOB);
    expect(text).toContain('ENGINEER');
    expect(
      audit.entries.some((e) =>
        e.changes.some((c) => c.path.startsWith('particulars.identityNumber')),
      ),
    ).toBe(true);
    const rows = await db
      .select({ detail: s.auditEvents.detail })
      .from(s.auditEvents)
      .where(eq(s.auditEvents.subjectId, person.id));
    expect(JSON.stringify(rows)).not.toContain(STORED);
    expect(JSON.stringify(rows)).not.toContain(DOB);

    // Reads: full for view_identity, masked and blanked without it.
    expect(particularsAt((await getPerson(manager, person.id)).person, '2026-12-31')).toMatchObject(
      {
        identityNumber: STORED,
        dateOfBirth: DOB,
      },
    );
    const hidden = (await getPerson(masked, person.id)).person;
    expect(JSON.stringify(hidden)).not.toContain(STORED);
    expect(JSON.stringify(hidden)).not.toContain(DOB);
    expect(particularsAt(hidden, '2026-12-31')).toMatchObject({
      identityNumber: '880516-**-****',
      occupation: 'COMPANY DIRECTOR',
    });
    expect(particularsAt(hidden, '2026-12-31').dateOfBirth).toBeUndefined();
    const listed = (await listPeople(masked, { q: `Particulars Person ${tag}` })).people;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(STORED);

    // A write by an actor without view_identity returns the masked view and cannot store a mask.
    const third = await changePerson(masked, {
      action: 'set_particulars',
      id: person.id,
      expectedRevision: 3,
      requestId: randomUUID(),
      values: { gender: 'Male' },
      effectiveDate: '2026-03-01',
      reason: 'Recorded',
    });
    expect(JSON.stringify(third)).not.toContain(STORED);
    await expect(
      changePerson(masked, {
        action: 'set_particulars',
        id: person.id,
        expectedRevision: 4,
        requestId: randomUUID(),
        values: { identityNumber: '880516-**-****' },
        effectiveDate: '2026-03-01',
        reason: 'Echoed mask',
      }),
    ).rejects.toThrow('masked');

    // Validation blocks a bad NRIC; a mismatched date of birth is only a warning.
    await expect(
      changePerson(manager, {
        action: 'set_particulars',
        id: person.id,
        expectedRevision: 4,
        requestId: randomUUID(),
        values: { identityNumber: '8805161458' },
        effectiveDate: '2026-03-01',
        reason: 'Bad number',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const warned = await changePerson(manager, {
      action: 'set_particulars',
      id: person.id,
      expectedRevision: 4,
      requestId: randomUUID(),
      values: { dateOfBirth: '1988-05-17' },
      effectiveDate: '2026-03-01',
      reason: 'Date from a different document',
    });
    expect(warned.revision).toBe(5);

    // Revision conflict.
    await expect(
      changePerson(manager, {
        action: 'set_particulars',
        id: person.id,
        expectedRevision: 4,
        requestId: randomUUID(),
        values: { occupation: 'STALE' },
        effectiveDate: '2026-03-01',
        reason: 'Stale',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE' });
  });

  it('saves other directorships with ids, a limit and an audit entry', async () => {
    const person = await changePerson(manager, {
      action: 'create',
      requestId: randomUUID(),
      fullName: `Directorships Person ${tag} (fictional)`,
    });
    const saved = await changePerson(manager, {
      action: 'set_other_directorships',
      id: person.id,
      expectedRevision: 1,
      requestId: randomUUID(),
      directorships: [
        { companyName: ' Fictional Holdings Berhad ', appointedOn: '2019-01-01', ceasedOn: null },
      ],
      reason: 'Declared by the director',
    });
    expect(saved.otherDirectorships).toEqual([
      {
        id: expect.any(String),
        companyName: 'Fictional Holdings Berhad',
        appointedOn: '2019-01-01',
        ceasedOn: null,
      },
    ]);
    await expect(
      changePerson(manager, {
        action: 'set_other_directorships',
        id: person.id,
        expectedRevision: 2,
        requestId: randomUUID(),
        directorships: [
          { companyName: 'Backwards Berhad', appointedOn: '2020-01-01', ceasedOn: '2019-01-01' },
        ],
        reason: 'Test',
      }),
    ).rejects.toThrow('before the appointment');
    await expect(
      changePerson(manager, {
        action: 'set_other_directorships',
        id: person.id,
        expectedRevision: 2,
        requestId: randomUUID(),
        directorships: Array.from({ length: 51 }, (_, i) => ({
          companyName: `Company ${i}`,
          appointedOn: null,
          ceasedOn: null,
        })),
        reason: 'Test',
      }),
    ).rejects.toThrow('up to 50');
    const audit = await queryAudit(manager, {
      entityId: person.id,
      action: 'person.other_directorships_set',
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].reason).toBe('Declared by the director');
  });
});
