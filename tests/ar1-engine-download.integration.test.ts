import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson } from '../src/server/records/people';
import { changeProfile, readProfile } from '../src/server/records/profile';
import { changeShareEntry } from '../src/server/records/shares';
import { changeRelationship } from '../src/server/records/relationships';
import { startReturn, updateReturn } from '../src/server/ar1/returns';
import { createDownload, uploadBlank } from '../src/server/ar1/download';
import { reconcilePendingGenerations } from '../src/server/resolution/generation';
import { emptyAnswers } from '../src/domain/ar1/returns';
import { defaultPreferences, ROLE_CAPABILITIES, type Actor } from '../src/domain/model';

// Matches the fixture blank: Test Sdn Bhd, 012345678910, first return made up to 1 Nov 2025.
const tag = randomBytes(4).toString('hex');
const companyId = `ar1-dl-${tag}`;
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
/** Can see the company but may not prepare work or generate documents. */
const viewer: Actor = { ...actor('Viewer'), capabilities: ['view_audit'] };
let storage = '';
const previousStorage = process.env.STORAGE_DIR;
const rid = () => randomUUID();
const blankFile = async () =>
  new File(
    [new Uint8Array(await readFile('tests/fixtures/ar1/blank-first-return.xlsx'))],
    'AR1.xlsx',
  );
const workbooks = async () => (await readdir(storage)).filter((n) => n.endsWith('.xlsx')).sort();
const address = (prefix: string) => ({
  [`${prefix}Line1`]: '1 Jalan Contoh',
  [`${prefix}Postcode`]: '50450',
  [`${prefix}Town`]: 'Kuala Lumpur',
  [`${prefix}State`]: 'W.P. KUALA LUMPUR',
  [`${prefix}Country`]: 'MALAYSIA',
});
const particulars = (companyType: string) => ({
  origin: 'Incorporated in Malaysia',
  status: 'Private company',
  companyType,
  ...address('registered'),
  membersRegisterAtRegistered: 'Yes',
  financialRecordsAtRegistered: 'Yes',
  ...address('principal'),
  msic1: '62010',
  natureOfBusiness: 'Software (fictional)',
});

beforeAll(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'cosec-ar1-dl-'));
  process.env.STORAGE_DIR = storage;
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
      name: 'Test Sdn Bhd',
      registrationNumber: '012345678910',
      incorporationDate: '2024-11-01',
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
      title: 'Allotment resolution (fictional)',
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
});
afterAll(async () => {
  closeDatabase();
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  await rm(storage, { recursive: true, force: true });
});

async function setUpRecords() {
  let profile = await readProfile(companyId);
  await changeProfile(preparer, companyId, {
    action: 'set_particulars',
    expectedRevision: profile.revision,
    requestId: rid(),
    reason: 'Fictional',
    effectiveDate: '2024-11-01',
    values: particulars('Company limited by shares'),
  } as never);
  profile = await readProfile(companyId);
  await changeProfile(preparer, companyId, {
    action: 'set_share_classes',
    expectedRevision: profile.revision,
    requestId: rid(),
    reason: 'Fictional',
    classes: [{ id: 'ord', name: 'Ordinary shares', kind: 'Ordinary' }],
  } as never);
  const p = await changePerson(preparer, {
    action: 'create',
    requestId: rid(),
    fullName: `Director ${tag} (fictional)`,
  });
  await changePerson(preparer, {
    action: 'set_particulars',
    id: p.id,
    expectedRevision: p.revision,
    requestId: rid(),
    reason: 'Fictional',
    effectiveDate: '2000-01-01',
    values: {
      identityType: 'MyKad',
      identityNumber: '880516145888',
      dateOfBirth: '1988-05-16',
      nationality: 'MALAYSIA',
      race: 'CHINESE',
      gender: 'Female',
      ...address('residential'),
      serviceSameAsResidential: 'Yes',
      occupation: 'COMPANY DIRECTOR',
    },
  } as never);
  const added = await changeRelationship(preparer, companyId, {
    action: 'add',
    requestId: rid(),
    personId: p.id,
    role: 'director',
    capacity: '',
    startDate: '2024-11-01',
    evidenceIds: [],
  });
  await changeRelationship(preparer, companyId, {
    action: 'set_appointment',
    id: added.id,
    expectedRevision: added.revision,
    requestId: rid(),
    designation: 'Director',
    alternateTo: null,
    nominee: false,
    reason: 'Fictional',
  });
  const entry = await changeShareEntry(preparer, companyId, {
    action: 'record',
    requestId: rid(),
    kind: 'allotment',
    date: '2024-11-01',
    classId: 'ord',
    shares: '100000',
    from: null,
    to: { partyIds: [p.id] },
    amountPayable: '100000',
    amountPaid: '100000',
    consideration: 'Cash',
    sourceDocumentId: documentId,
    sourceCaseId: null,
    note: '',
  });
  await changeShareEntry(reviewer, companyId, {
    action: 'post',
    requestId: rid(),
    id: entry.id,
    expectedRevision: 1,
  });
}

describe('annual return workbook download', () => {
  it('checks permission, repeats requests safely, reuses unchanged versions and refuses blockers', async () => {
    await setUpRecords();
    const started = await startReturn(preparer, {
      requestId: rid(),
      companyId,
      calendarYear: 2025,
      application: 'Ordinary filing',
      rectificationDeclaration: '',
      courtOrderReference: '',
    });
    const answers = emptyAnswers();
    answers.certificate = {
      unclaimedMoneys: 'Yes',
      noPublicInvitation: 'Yes',
      overFifty: 'Yes',
      overFiveHundred: null,
      boStatus: 'Company has beneficial owner(s)',
      boExemptCategory: null,
      nomineeStatus: null,
    };
    const answered = await updateReturn(preparer, started.id, {
      requestId: rid(),
      expectedRevision: started.revision,
      answers,
    });

    // No permission: refused before the workbook is read or stored.
    await expect(
      uploadBlank(viewer, started.id, {
        requestId: rid(),
        expectedRevision: answered.revision,
        file: await blankFile(),
      }),
    ).rejects.toThrow('permission');
    expect(await workbooks()).toEqual([]);

    // A retried upload returns the return as it is and leaves no second file.
    const uploadId = rid();
    const uploaded = await uploadBlank(preparer, started.id, {
      requestId: uploadId,
      expectedRevision: answered.revision,
      file: await blankFile(),
    });
    const retriedUpload = await uploadBlank(preparer, started.id, {
      requestId: uploadId,
      expectedRevision: answered.revision,
      file: await blankFile(),
    });
    expect(retriedUpload.revision).toBe(uploaded.revision);
    expect(await workbooks()).toHaveLength(1);

    // A retried download gets the first result, not a stale-revision refusal.
    const downloadId = rid();
    const first = await createDownload(preparer, started.id, {
      requestId: downloadId,
      expectedRevision: uploaded.revision,
    });
    expect(first.download.version).toBe(1);
    // Missing particulars (no secretary) do not stop the download; they are recorded.
    expect(first.download.missing.length).toBeGreaterThan(0);
    const retried = await createDownload(preparer, started.id, {
      requestId: downloadId,
      expectedRevision: uploaded.revision,
    });
    expect(retried.download).toEqual(first.download);
    expect(await workbooks()).toHaveLength(2);

    // Nothing changed: the latest version is returned and no new file is stored.
    const reuseId = rid();
    const same = await createDownload(preparer, started.id, {
      requestId: reuseId,
      expectedRevision: first.record.revision,
    });
    expect(same.download).toEqual(first.download);
    expect(same.record.downloads).toHaveLength(1);
    expect(await workbooks()).toHaveLength(2);

    // A change to the return's own answers makes a new version.
    const changed = emptyAnswers();
    changed.certificate = { ...answers.certificate, overFifty: 'No' };
    const reanswered = await updateReturn(preparer, started.id, {
      requestId: rid(),
      expectedRevision: first.record.revision,
      answers: changed,
    });
    const second = await createDownload(preparer, started.id, {
      requestId: rid(),
      expectedRevision: reanswered.revision,
    });
    expect(second.download.version).toBe(2);
    expect(await workbooks()).toHaveLength(3);
    // Retrying the request that reused version 1 still gets version 1, though the return changed.
    const reusedAgain = await createDownload(preparer, started.id, {
      requestId: reuseId,
      expectedRevision: first.record.revision,
    });
    expect(reusedAgain.download.version).toBe(1);
    expect(await workbooks()).toHaveLength(3);

    // Orphan workbooks are removed by the reconciler; referenced ones stay, however old.
    const old = new Date(Date.now() - 11 * 60_000);
    const referenced = await workbooks();
    for (const name of referenced) await utimes(path.join(storage, name), old, old);
    const orphan = `${randomUUID()}.xlsx`;
    await writeFile(path.join(storage, orphan), 'PK');
    await utimes(path.join(storage, orphan), old, old);
    await reconcilePendingGenerations();
    expect(await workbooks()).toEqual(referenced);

    // Figures that disagree (here: a company not limited by shares) stop the download.
    const profile = await readProfile(companyId);
    await changeProfile(preparer, companyId, {
      action: 'set_particulars',
      expectedRevision: profile.revision,
      requestId: rid(),
      reason: 'Fictional',
      effectiveDate: '2025-01-01',
      values: { companyType: 'Company limited by guarantee' },
    } as never);
    await expect(
      createDownload(preparer, started.id, {
        requestId: rid(),
        expectedRevision: second.record.revision,
      }),
    ).rejects.toThrow(
      'The workbook cannot be made until this is fixed: The AR1 template is for companies limited by shares.',
    );
    expect(await workbooks()).toEqual(referenced);

    // Records reach the caller filtered: a source from a company the actor cannot see (put into
    // the stored record here) is left out, on the retry paths too.
    const [row] = await writerDb
      .select()
      .from(s.annualReturns)
      .where(eq(s.annualReturns.id, started.id));
    const stored = structuredClone(row.data);
    const hiddenId = `hidden-${tag}`;
    stored.downloads[0].sources.push({ kind: 'company', id: hiddenId, revision: 1 });
    await writerDb
      .update(s.annualReturns)
      .set({ data: stored })
      .where(eq(s.annualReturns.id, started.id));
    const hidden = (sources: { id: string }[]) => sources.some((x) => x.id === hiddenId);
    const again = await createDownload(preparer, started.id, {
      requestId: downloadId,
      expectedRevision: uploaded.revision,
    });
    expect(again.download.version).toBe(1);
    expect(hidden(again.download.sources)).toBe(false);
    expect(again.record.downloads.some((d) => hidden(d.sources))).toBe(false);
    const uploadAgain = await uploadBlank(preparer, started.id, {
      requestId: uploadId,
      expectedRevision: answered.revision,
      file: await blankFile(),
    });
    expect(uploadAgain.downloads.some((d) => hidden(d.sources))).toBe(false);
  });
});
