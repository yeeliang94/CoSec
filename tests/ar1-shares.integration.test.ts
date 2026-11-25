import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDatabase, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson } from '../src/server/records/people';
import { changeProfile, readProfile } from '../src/server/records/profile';
import { changeShareEntry, listShares } from '../src/server/records/shares';
import { listCompanyRelationships } from '../src/server/records/relationships';
import { replay } from '../src/domain/ar1/shares';
import { defaultPreferences, ROLE_CAPABILITIES, type Actor } from '../src/domain/model';

const tag = randomBytes(4).toString('hex');
const companyId = `shares-${tag}`;
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
let tan = '';
let lee = '';

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
      name: 'Share Register Sdn. Bhd. (fictional)',
      registrationNumber: `SR-${tag}`,
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
    id: documentId,
    companyId,
    data: {
      id: documentId,
      companyId,
      title: 'Return of allotment (fictional)',
      originalName: 'allotment.pdf',
      mimeType: 'application/pdf',
      size: 1,
      sha256: '0'.repeat(64),
      storageKey: 'none.pdf',
      createdBy: preparer.id,
      createdAt: new Date().toISOString(),
      classification: 'General',
    },
  });
  const person = async (fullName: string) =>
    (await changePerson(preparer, { action: 'create', requestId: randomUUID(), fullName })).id;
  tan = await person(`Tan Member ${tag} (fictional)`);
  lee = await person(`Lee Member ${tag} (fictional)`);
});
afterAll(() => closeDatabase());

const fields = (overrides: Record<string, unknown>) => ({
  kind: 'allotment' as const,
  date: '2020-01-01',
  classId: 'ord',
  shares: '1000',
  from: null,
  to: { partyIds: [tan] },
  amountPayable: '1000',
  amountPaid: '1000',
  consideration: 'Cash' as const,
  sourceDocumentId: documentId,
  sourceCaseId: null,
  note: '',
  ...overrides,
});

describe('share register', () => {
  it('needs a class, an independent reviewer and no negative holdings', async () => {
    await expect(
      changeShareEntry(preparer, companyId, {
        action: 'record',
        requestId: randomUUID(),
        ...fields({}),
      }),
    ).rejects.toThrow('Choose a share class.');
    await changeProfile(preparer, companyId, {
      action: 'set_share_classes',
      expectedRevision: (await readProfile(companyId)).revision,
      requestId: randomUUID(),
      reason: 'Constitution (fictional)',
      classes: [{ id: 'ord', name: 'Ordinary shares', kind: 'Ordinary' }],
    } as never);

    const draft = await changeShareEntry(preparer, companyId, {
      action: 'record',
      requestId: randomUUID(),
      ...fields({}),
    });
    expect(draft.status).toBe('Draft');
    await expect(
      changeShareEntry(preparer, companyId, {
        action: 'post',
        requestId: randomUUID(),
        id: draft.id,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    const posted = await changeShareEntry(reviewer, companyId, {
      action: 'post',
      requestId: randomUUID(),
      id: draft.id,
      expectedRevision: 1,
    });
    expect(posted).toMatchObject({ status: 'Posted', reviewerId: reviewer.id });

    // A transfer of more than Tan holds is refused at posting.
    const tooMany = await changeShareEntry(preparer, companyId, {
      action: 'record',
      requestId: randomUUID(),
      ...fields({
        kind: 'transfer',
        date: '2021-01-01',
        shares: '1500',
        from: { partyIds: [tan] },
        to: { partyIds: [lee] },
      }),
    });
    await expect(
      changeShareEntry(reviewer, companyId, {
        action: 'post',
        requestId: randomUUID(),
        id: tooMany.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('fewer than zero shares');
    await changeShareEntry(preparer, companyId, {
      action: 'withdraw',
      requestId: randomUUID(),
      id: tooMany.id,
      expectedRevision: 1,
      reason: 'Wrong number (fictional)',
    });

    // A valid transfer makes Lee a member and ends nobody's membership.
    const transfer = await changeShareEntry(preparer, companyId, {
      action: 'record',
      requestId: randomUUID(),
      ...fields({
        kind: 'transfer',
        date: '2021-01-01',
        shares: '400',
        from: { partyIds: [tan] },
        to: { partyIds: [lee] },
      }),
    });
    await changeShareEntry(reviewer, companyId, {
      action: 'post',
      requestId: randomUUID(),
      id: transfer.id,
      expectedRevision: 1,
    });
    const { relationships } = await listCompanyRelationships(reviewer, companyId, '2022-01-01');
    const members = relationships.filter((r) => r.role === 'member');
    expect(members.map((m) => m.personId).sort()).toEqual([tan, lee].sort());
    expect(members.every((m) => m.projectedFrom && 'shareEntryIds' in m.projectedFrom)).toBe(true);

    // Correcting the allotment to 300 shares would leave Tan negative after the transfer.
    const correction = await changeShareEntry(preparer, companyId, {
      action: 'correct',
      requestId: randomUUID(),
      id: draft.id,
      voids: false,
      ...fields({ shares: '300', amountPayable: '300', amountPaid: '300' }),
    });
    await expect(
      changeShareEntry(reviewer, companyId, {
        action: 'post',
        requestId: randomUUID(),
        id: correction.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('fewer than zero shares');

    const { entries } = await listShares(reviewer, companyId);
    const holdings = replay(entries).state.holdings;
    expect(Object.fromEntries(holdings.map((h) => [h.key, h.shares]))).toEqual({
      [tan]: 600n,
      [lee]: 400n,
    });
  });
});
