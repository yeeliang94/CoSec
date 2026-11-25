import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson, listPeople } from '../src/server/records/people';
import { changeProfile, readProfile } from '../src/server/records/profile';
import { changeShareEntry, listShares } from '../src/server/records/shares';
import { changeRelationship, listCompanyRelationships } from '../src/server/records/relationships';
import { TRUSTEE_TYPES } from '../src/domain/ar1/mtool-lists';
import { defaultPreferences, ROLE_CAPABILITIES, type Actor } from '../src/domain/model';

// Fictional companies and people only.
const tag = randomBytes(4).toString('hex');
const companyA = `fixa-${tag}`;
const companyB = `fixb-${tag}`;
const docA = randomUUID();
const docB = randomUUID();
const actor = (name: string, capabilities = [...ROLE_CAPABILITIES.user]): Actor => ({
  id: randomUUID(),
  name,
  email: `${name.toLowerCase()}-${tag}@example.invalid`,
  capabilities,
  companyIds: [companyA, companyB],
  preferences: defaultPreferences,
});
const preparer = actor('Preparer');
const reviewer = actor('Reviewer');
const noIdentity = actor(
  'Viewer',
  ROLE_CAPABILITIES.user.filter((c) => c !== 'view_identity'),
);
const people: Record<string, string> = {};
const ID_NUMBER = '880516145888';

const fields = (overrides: Record<string, unknown>) => ({
  kind: 'opening' as const,
  date: '2024-01-01',
  classId: 'ord',
  shares: '100',
  from: null,
  to: { partyIds: [people.tan] },
  amountPayable: '100',
  amountPaid: '100',
  consideration: 'Cash' as const,
  sourceDocumentId: docA,
  sourceCaseId: null,
  note: '',
  ...overrides,
});
const record = (overrides: Record<string, unknown>, by = preparer) =>
  changeShareEntry(by, companyA, {
    action: 'record',
    requestId: randomUUID(),
    ...fields(overrides),
  });
const post = (id: string, expectedRevision = 1) =>
  changeShareEntry(reviewer, companyA, {
    action: 'post',
    requestId: randomUUID(),
    id,
    expectedRevision,
  });
const members = async (asAt: string) =>
  (await listCompanyRelationships(reviewer, companyA, asAt)).relationships.filter(
    // In effect on the date: the end date is the first day a row no longer applies.
    (r) =>
      r.role === 'member' &&
      (!r.startDate || r.startDate <= asAt) &&
      (!r.endDate || r.endDate > asAt),
  );

beforeAll(async () => {
  for (const a of [preparer, reviewer, noIdentity])
    await writerDb.insert(s.user).values({
      id: a.id,
      name: a.name,
      email: a.email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      capabilities: a.capabilities,
      companyIds: a.companyIds,
      preferences: a.preferences,
      active: true,
    });
  for (const [id, doc] of [
    [companyA, docA],
    [companyB, docB],
  ]) {
    await writerDb.insert(s.companies).values({
      id,
      data: {
        id,
        name: `Fix ${id} Sdn. Bhd. (fictional)`,
        registrationNumber: `FX-${id}`,
        incorporationDate: '2020-01-01',
        financialYearEnd: '12-31',
        legalStatus: 'Existing',
        engagementStatus: 'Active',
        address: 'Fictional',
        activity: '',
        verification: 'Unverified',
        sourceEvidenceId: null,
        revision: 1,
      },
    });
    await writerDb.insert(s.documents).values({
      id: doc,
      companyId: id,
      data: {
        id: doc,
        companyId: id,
        title: 'Resolution (fictional)',
        originalName: 'resolution.pdf',
        mimeType: 'application/pdf',
        size: 1,
        sha256: '0'.repeat(64),
        storageKey: 'none.pdf',
        createdBy: preparer.id,
        createdAt: new Date().toISOString(),
        classification: 'General',
      },
    });
  }
  for (const name of ['tan', 'lee', 'manual', 'bOnly', 'trustee'])
    people[name] = (
      await changePerson(preparer, {
        action: 'create',
        requestId: randomUUID(),
        fullName: `${name} ${tag} (fictional)`,
      })
    ).id;
  const org = await changePerson(preparer, {
    action: 'create',
    requestId: randomUUID(),
    kind: 'organisation',
    fullName: `Holdco ${tag} Bhd (fictional)`,
  });
  people.org = org.id;
  await changeRelationship(preparer, companyB, {
    action: 'add',
    requestId: randomUUID(),
    personId: people.bOnly,
    role: 'member',
    capacity: '',
    startDate: '2020-01-01',
    evidenceIds: [],
  });
  // A member entered by hand before the register existed.
  await changeRelationship(preparer, companyA, {
    action: 'add',
    requestId: randomUUID(),
    personId: people.manual,
    role: 'member',
    capacity: '',
    startDate: '2020-01-01',
    evidenceIds: [],
  });
  await changeProfile(preparer, companyA, {
    action: 'set_share_classes',
    expectedRevision: (await readProfile(companyA)).revision,
    requestId: randomUUID(),
    reason: 'Constitution (fictional)',
    classes: [{ id: 'ord', name: 'Ordinary shares', kind: 'Ordinary' }],
  } as never);
});
afterAll(() => closeDatabase());

describe('share register fixes', () => {
  it('names a person from another company, and shows readers of this one only the id', async () => {
    // The preparer sees both companies, so a B-only person can join A by an entry.
    const draft = await record({ to: { partyIds: [people.bOnly] } });
    expect(draft.status).toBe('Draft');
    await changeShareEntry(preparer, companyA, {
      action: 'withdraw',
      requestId: randomUUID(),
      id: draft.id,
      expectedRevision: 1,
      reason: 'Test (fictional)',
    });
    // Someone who sees only A gets the party id and nothing else about that person.
    const aOnly: Actor = { ...reviewer, id: randomUUID(), companyIds: [companyA] };
    const listed = (await listShares(aOnly, companyA)).entries.find((e) => e.id === draft.id)!;
    expect(listed.to).toEqual({ partyIds: [people.bOnly] });
    expect(JSON.stringify(listed)).not.toContain('bOnly ' + tag);
    expect((await listPeople(aOnly, { ids: [people.bOnly] })).people).toEqual([]);
    // A person the actor cannot see at all is still refused.
    const outsider: Actor = { ...preparer, id: randomUUID(), companyIds: [companyA] };
    await expect(
      changeShareEntry(outsider, companyA, {
        action: 'record',
        requestId: randomUUID(),
        ...fields({ to: { partyIds: [people.bOnly] } }),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ends hand-entered members when the register starts and projects from entries', async () => {
    expect((await members('2023-06-01')).map((m) => m.personId)).toEqual([people.manual]);
    const opening = await record({ to: { partyIds: [people.tan] } });
    await post(opening.id);
    const manualRow = (
      await listCompanyRelationships(reviewer, companyA, '2023-06-01')
    ).relationships.find((r) => r.personId === people.manual)!;
    expect(manualRow).toMatchObject({ endDate: '2024-01-01', projectedFrom: null });
    const ended = await writerDb
      .select({ reason: s.auditEvents.reason })
      .from(s.auditEvents)
      .where(eq(s.auditEvents.subjectId, manualRow.id));
    expect(ended.map((r) => r.reason)).toContain('Superseded by the share register');
    const onStart = await members('2024-01-01');
    expect(onStart.map((m) => m.personId)).toEqual([people.tan]);
    expect(onStart[0].projectedFrom).toEqual({ shareEntryIds: [opening.id] });

    const transfer = await record({
      kind: 'transfer',
      date: '2024-06-01',
      from: { partyIds: [people.tan] },
      to: { partyIds: [people.lee] },
      amountPayable: null,
      amountPaid: null,
      consideration: null,
    });
    await post(transfer.id);
    expect((await members('2024-06-01')).map((m) => m.personId)).toEqual([people.lee]);
    const all = (await listCompanyRelationships(reviewer, companyA, '2024-01-01')).relationships;
    const tanRow = all.find((r) => r.personId === people.tan)!;
    expect(tanRow).toMatchObject({
      endDate: '2024-06-01',
      projectedFrom: { shareEntryIds: [opening.id, transfer.id] },
    });
    const leeRow = (await members('2024-06-01'))[0];
    expect(leeRow.projectedFrom).toEqual({ shareEntryIds: [transfer.id] });

    // A hand-entered member can no longer be added while the register is in use.
    await expect(
      changeRelationship(preparer, companyA, {
        action: 'add',
        requestId: randomUUID(),
        personId: people.manual,
        role: 'member',
        capacity: '',
        startDate: '2025-01-01',
        evidenceIds: [],
      }),
    ).rejects.toThrow('share register');
  });

  it('checks the sources of a void correction', async () => {
    const { entries } = await listShares(reviewer, companyA);
    const transfer = entries.find((e) => e.kind === 'transfer' && e.status === 'Posted')!;
    await expect(
      changeShareEntry(preparer, companyA, {
        action: 'correct',
        requestId: randomUUID(),
        id: transfer.id,
        voids: true,
        ...fields({ sourceDocumentId: docB }),
      }),
    ).rejects.toThrow('Evidence must be General documents from this company.');
    await expect(
      changeShareEntry(preparer, companyA, {
        action: 'correct',
        requestId: randomUUID(),
        id: transfer.id,
        voids: true,
        ...fields({ sourceDocumentId: null, sourceCaseId: randomUUID() }),
      }),
    ).rejects.toThrow('The source resolution must belong to this company.');
  });

  it('redacts and masks the trust subject ID number', async () => {
    const entry = await record({
      kind: 'allotment',
      date: '2024-07-01',
      to: {
        partyIds: [people.trustee],
        trustee: {
          type: TRUSTEE_TYPES[2],
          subjectName: 'Minor Child (fictional)',
          subjectIdType: 'MyKad',
          subjectIdNumber: ID_NUMBER,
          subjectNationality: 'Malaysia',
        },
      },
    });
    expect(entry.to?.trustee?.subjectIdNumber).toBe(ID_NUMBER);
    await post(entry.id);
    const rows = await writerDb
      .select({ detail: s.auditEvents.detail })
      .from(s.auditEvents)
      .where(inArray(s.auditEvents.subjectId, [entry.id]));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(JSON.stringify(row.detail)).not.toContain(ID_NUMBER);

    const seen = async (who: Actor) =>
      (await listShares(who, companyA)).entries.find((e) => e.id === entry.id)!.to!.trustee!
        .subjectIdNumber;
    expect(await seen(reviewer)).toBe(ID_NUMBER);
    expect(await seen(noIdentity)).toBe('880516-**-****');

    // A correction sending back the masked number keeps the stored one; another masked one is refused.
    const masked = (await listShares(noIdentity, companyA)).entries.find((e) => e.id === entry.id)!;
    const correction = await changeShareEntry(noIdentity, companyA, {
      action: 'correct',
      requestId: randomUUID(),
      id: entry.id,
      voids: false,
      ...fields({ kind: 'allotment', date: '2024-07-01', shares: '50', to: masked.to }),
    });
    const [stored] = await writerDb
      .select()
      .from(s.shareEntries)
      .where(eq(s.shareEntries.id, correction.id));
    expect(stored.data.to?.trustee?.subjectIdNumber).toBe(ID_NUMBER);
    await expect(
      changeShareEntry(noIdentity, companyA, {
        action: 'correct',
        requestId: randomUUID(),
        id: entry.id,
        voids: false,
        ...fields({
          kind: 'allotment',
          date: '2024-07-01',
          to: {
            ...masked.to!,
            trustee: { ...masked.to!.trustee!, subjectIdNumber: '990101-**-****' },
          },
        }),
      }),
    ).rejects.toThrow('masked');
  });
});

describe('people listing', () => {
  it('filters by kind and returns exactly the requested ids', async () => {
    const orgs = await listPeople(preparer, { kind: 'organisation' });
    expect(orgs.people.every((p) => p.kind === 'organisation')).toBe(true);
    expect(orgs.people.map((p) => p.id)).toContain(people.org);
    const individuals = await listPeople(preparer, { kind: 'individual' });
    expect(individuals.people.map((p) => p.id)).not.toContain(people.org);
    expect(individuals.people.map((p) => p.id)).toContain(people.tan);

    const wanted = [people.tan, people.lee, people.org, randomUUID()];
    const byIds = await listPeople(preparer, { ids: wanted });
    expect(byIds.people.map((p) => p.id).sort()).toEqual(wanted.slice(0, 3).sort());
    expect(byIds.truncated).toBe(false);
    // Someone else cannot see people related to companies outside their access.
    const outsider: Actor = { ...preparer, id: randomUUID(), companyIds: [] };
    expect((await listPeople(outsider, { ids: [people.tan] })).people).toEqual([]);
    await expect(
      listPeople(preparer, { ids: Array.from({ length: 501 }, () => randomUUID()) }),
    ).rejects.toThrow('up to 500');
  });
});
