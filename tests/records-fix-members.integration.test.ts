import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDatabase, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson } from '../src/server/records/people';
import { changeProfile, readProfile } from '../src/server/records/profile';
import { changeShareEntry } from '../src/server/records/shares';
import { changeRelationship, listCompanyRelationships } from '../src/server/records/relationships';
import { defaultPreferences, ROLE_CAPABILITIES, type Actor } from '../src/domain/model';
import type { CompanyRelationship } from '../src/domain/resolution/model';

// Fictional company and people only.
const tag = randomBytes(4).toString('hex');
const companyId = `fixm-${tag}`;
const documentId = randomUUID();
const actor = (name: string): Actor => ({
  id: randomUUID(),
  name,
  email: `${name.toLowerCase()}-${tag}@example.invalid`,
  capabilities: [...ROLE_CAPABILITIES.user],
  companyIds: [companyId],
  preferences: defaultPreferences,
});
const preparer = actor('Preparer');
const reviewer = actor('Reviewer');
const people: Record<string, string> = {};
const rows: Record<string, string> = {};

const opening = (date: string) => ({
  kind: 'opening' as const,
  date,
  classId: 'ord',
  shares: '100',
  from: null,
  to: { partyIds: [people.tan] },
  amountPayable: '100',
  amountPaid: '100',
  consideration: 'Cash' as const,
  sourceDocumentId: documentId,
  sourceCaseId: null,
  note: '',
});
const post = (id: string) =>
  changeShareEntry(reviewer, companyId, {
    action: 'post',
    requestId: randomUUID(),
    id,
    expectedRevision: 1,
  });
const correct = async (id: string, date: string, voids = false) => {
  const draft = await changeShareEntry(preparer, companyId, {
    action: 'correct',
    requestId: randomUUID(),
    id,
    voids,
    ...opening(date),
  });
  await post(draft.id);
  return draft;
};
const all = async () =>
  (await listCompanyRelationships(reviewer, companyId, '2030-01-01')).relationships;
const row = async (id: string) => (await all()).find((r) => r.id === id) as CompanyRelationship;
const membersAt = async (asAt: string) =>
  (await all())
    .filter(
      (r) =>
        r.role === 'member' &&
        (!r.startDate || r.startDate <= asAt) &&
        (!r.endDate || r.endDate > asAt),
    )
    .map((r) => r.personId)
    .sort();

beforeAll(async () => {
  for (const a of [preparer, reviewer])
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
  await writerDb.insert(s.companies).values({
    id: companyId,
    data: {
      id: companyId,
      name: 'Member Drift Sdn. Bhd. (fictional)',
      registrationNumber: `FM-${tag}`,
      incorporationDate: '2018-01-01',
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
    id: documentId,
    companyId,
    data: {
      id: documentId,
      companyId,
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
  for (const name of ['tan', 'manual', 'former'])
    people[name] = (
      await changePerson(preparer, {
        action: 'create',
        requestId: randomUUID(),
        fullName: `${name} ${tag} (fictional)`,
      })
    ).id;
  for (const name of ['manual', 'former'])
    rows[name] = (
      await changeRelationship(preparer, companyId, {
        action: 'add',
        requestId: randomUUID(),
        personId: people[name],
        role: 'member',
        capacity: '',
        startDate: '2018-01-01',
        evidenceIds: [],
      })
    ).id;
  // A member who really left before the register starts.
  await changeRelationship(preparer, companyId, {
    action: 'end',
    id: rows.former,
    expectedRevision: 1,
    requestId: randomUUID(),
    endDate: '2019-03-01',
    reason: 'Transferred out (fictional)',
  });
  await changeProfile(preparer, companyId, {
    action: 'set_share_classes',
    expectedRevision: (await readProfile(companyId)).revision,
    requestId: randomUUID(),
    reason: 'Constitution (fictional)',
    classes: [{ id: 'ord', name: 'Ordinary shares', kind: 'Ordinary' }],
  } as never);
});
afterAll(() => closeDatabase());

describe('hand-entered members follow the register start', () => {
  it('re-ends on a moved start and restores when the register no longer covers them', async () => {
    const first = await changeShareEntry(preparer, companyId, {
      action: 'record',
      requestId: randomUUID(),
      ...opening('2020-01-01'),
    });
    await post(first.id);
    expect(await row(rows.manual)).toMatchObject({
      endDate: '2020-01-01',
      supersededByRegister: { originalEndDate: null },
    });
    expect(await membersAt('2019-06-01')).toEqual([people.manual]);

    // (A) The opening balance is corrected to a year later: the hand row now runs to 2021.
    const later = await correct(first.id, '2021-01-01');
    expect((await row(rows.manual)).endDate).toBe('2021-01-01');
    expect(await membersAt('2020-06-01')).toEqual([people.manual]);
    expect(await membersAt('2021-06-01')).toEqual([people.tan]);

    // Moving the start earlier still works.
    const earlier = await correct(later.id, '2019-06-01');
    expect((await row(rows.manual)).endDate).toBe('2019-06-01');

    // (B) The only entry is voided: projected rows go and the hand row gets its own end back.
    await correct(earlier.id, '2019-06-01', true);
    const restored = await row(rows.manual);
    expect(restored.endDate).toBeNull();
    expect(restored.supersededByRegister).toBeUndefined();
    expect(await membersAt('2025-01-01')).toEqual([people.manual]);
    expect((await all()).filter((r) => r.projectedFrom)).toEqual([]);

    // The member who left before the register was never touched.
    expect(await row(rows.former)).toMatchObject({ endDate: '2019-03-01', revision: 2 });
    expect((await row(rows.former)).supersededByRegister).toBeUndefined();

    const reasons = (
      await writerDb
        .select({ reason: s.auditEvents.reason, subjectId: s.auditEvents.subjectId })
        .from(s.auditEvents)
    )
      .filter((r) => r.subjectId === rows.manual)
      .map((r) => r.reason);
    expect(reasons).toContain('Superseded by the share register');
    expect(reasons).toContain('Share register no longer covers this member');
  });
});
