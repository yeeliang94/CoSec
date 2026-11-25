import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import { changePerson } from '../src/server/records/people';
import { changeProfile, readProfile } from '../src/server/records/profile';
import { changeShareEntry } from '../src/server/records/shares';
import { changeCharge } from '../src/server/records/charges';
import { changeRelationship, listCompanyRelationships } from '../src/server/records/relationships';
import { appointmentAt } from '../src/domain/resolution/model';
import { getReturn, listReturns, startReturn, updateReturn } from '../src/server/ar1/returns';
import { createDownload, downloadVersion, uploadBlank } from '../src/server/ar1/download';
import { readPackage, readText } from '../src/server/ar1/zip';
import { cells, cellText, sharedStrings, sheetParts } from '../src/server/ar1/sheet';
import { emptyAnswers } from '../src/domain/ar1/returns';
import { defaultPreferences, ROLE_CAPABILITIES, type Actor } from '../src/domain/model';

// Matches the fixture blank: Test Sdn Bhd, 012345678910, first return made up to 1 Nov 2025.
const tag = randomBytes(4).toString('hex');
const companyId = `ar1-${tag}`;
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
let storage = '';
const previousStorage = process.env.STORAGE_DIR;
const rid = () => randomUUID();
const fixture = (name: string) => readFile(`tests/fixtures/ar1/${name}`);
const asFile = (bytes: Buffer, name: string) => new File([new Uint8Array(bytes)], name);

const address = (prefix: string) => ({
  [`${prefix}Line1`]: '1 Jalan Contoh',
  [`${prefix}Postcode`]: '50450',
  [`${prefix}Town`]: 'Kuala Lumpur',
  [`${prefix}State`]: 'W.P. KUALA LUMPUR',
  [`${prefix}Country`]: 'MALAYSIA',
});

beforeAll(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'cosec-ar1-'));
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
    values: {
      origin: 'Incorporated in Malaysia',
      status: 'Private company',
      companyType: 'Company limited by shares',
      ...address('registered'),
      membersRegisterAtRegistered: 'Yes',
      financialRecordsAtRegistered: 'Yes',
      ...address('principal'),
      msic1: '62010',
      natureOfBusiness: 'Software (fictional)',
    },
  } as never);
  profile = await readProfile(companyId);
  await changeProfile(preparer, companyId, {
    action: 'set_share_classes',
    expectedRevision: profile.revision,
    requestId: rid(),
    reason: 'Fictional',
    classes: [{ id: 'ord', name: 'Ordinary shares', kind: 'Ordinary' }],
  } as never);
  const person = async (name: string, values: Record<string, string>) => {
    const p = await changePerson(preparer, { action: 'create', requestId: rid(), fullName: name });
    await changePerson(preparer, {
      action: 'set_particulars',
      id: p.id,
      expectedRevision: p.revision,
      requestId: rid(),
      reason: 'Fictional',
      effectiveDate: '2000-01-01',
      values: {
        identityType: 'MyKad',
        nationality: 'MALAYSIA',
        race: 'CHINESE',
        gender: 'Female',
        ...address('residential'),
        serviceSameAsResidential: 'Yes',
        occupation: 'COMPANY DIRECTOR',
        ...values,
      },
    } as never);
    return p.id;
  };
  const director = await person(`Director ${tag} (fictional)`, {
    identityNumber: '880516145888',
    dateOfBirth: '1988-05-16',
  });
  const secretary = await person(`Secretary ${tag} (fictional)`, {
    identityNumber: '850505105555',
    dateOfBirth: '1985-05-05',
    secretaryBody: 'Malaysian Association of Company Secretaries (MACS)',
    secretaryLicence: 'MACS 00000',
    practisingCertificate: '202000000000',
  });
  const added = await changeRelationship(preparer, companyId, {
    action: 'add',
    requestId: rid(),
    personId: director,
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
  await changeRelationship(preparer, companyId, {
    action: 'add',
    requestId: rid(),
    personId: secretary,
    role: 'secretary',
    capacity: '',
    startDate: '2024-11-01',
    evidenceIds: [],
  });
  const entry = await changeShareEntry(preparer, companyId, {
    action: 'record',
    requestId: rid(),
    kind: 'allotment',
    date: '2024-11-01',
    classId: 'ord',
    shares: '100000',
    from: null,
    to: { partyIds: [director] },
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
  await changeCharge(preparer, companyId, {
    action: 'record',
    requestId: rid(),
    registeredNumber: 'CC0001',
    registeredOn: '2025-01-15',
    nature: 'Fixed charge',
    chargee: 'FICTIONAL BANK BERHAD',
    amount: '500000',
    dischargedOn: null,
    note: '',
  });
  return { director };
}

let returnId = '';
let directorId = '';
const startRequest = randomUUID();

/** The stored version's sources, before `returnForActor` strips companies the caller cannot see. */
async function storedSources(returnId: string, version: number) {
  const [row] = await writerDb
    .select()
    .from(s.annualReturns)
    .where(eq(s.annualReturns.id, returnId));
  return row.data.downloads.find((d) => d.version === version)!.sources;
}

describe('annual return', () => {
  it('starts, checks the blank, fills it and keeps each version frozen', async () => {
    const { director } = await setUpRecords();
    directorId = director;
    const listed = await listReturns(preparer, companyId);
    // As at today (16 Nov 2026 or later) the next return due is 2026's.
    expect(listed.returns.at(-1)).toMatchObject({ status: 'Not started', calendarYear: 2026 });

    const record = await startReturn(preparer, {
      requestId: startRequest,
      companyId,
      calendarYear: 2025,
      application: 'Ordinary filing',
      rectificationDeclaration: '',
      courtOrderReference: '',
    });
    expect(record).toMatchObject({ firstReturn: true, dueDate: '2025-12-01' });
    returnId = record.id;

    // Before the certificate is answered, those answers are listed as missing.
    let view = await getReturn(preparer, record.id);
    expect(view.issues.map((i) => i.section)).toContain('G');
    expect(view.data.d.directors).toHaveLength(1);
    expect(view.data.e.members[0]).toMatchObject({
      shares: '100000',
      analysis: 'Citizens who are non-Malays and non-natives',
    });
    expect(view.data.a.msic[0].description).toBe('COMPUTER PROGRAMMING ACTIVITIES');

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
    const saved = await updateReturn(preparer, record.id, {
      requestId: rid(),
      expectedRevision: record.revision,
      answers,
    });
    view = await getReturn(preparer, record.id);
    expect(view.issues).toEqual([]);

    // A blank for another company is refused at download.
    const wrong = await uploadBlank(preparer, record.id, {
      requestId: rid(),
      expectedRevision: saved.revision,
      file: asFile(await fixture('blank-second.xlsx'), 'blank-second.xlsx'),
    });
    expect((await getReturn(preparer, record.id)).filingCheck?.length).toBeGreaterThan(0);
    await expect(
      createDownload(preparer, record.id, { requestId: rid(), expectedRevision: wrong.revision }),
    ).rejects.toThrow('does not match');

    const right = await uploadBlank(preparer, record.id, {
      requestId: rid(),
      expectedRevision: wrong.revision,
      file: asFile(await fixture('blank-first-return.xlsx'), 'AR1-blank.xlsx'),
    });
    expect((await getReturn(preparer, record.id)).filingCheck).toEqual([]);
    const first = await createDownload(preparer, record.id, {
      requestId: rid(),
      expectedRevision: right.revision,
    });
    expect(first.download).toMatchObject({
      version: 1,
      fileName: 'AR1_012345678910_20251101_v1.xlsx',
      missing: [],
    });
    expect(first.record.status).toBe('Downloaded');
    const v1 = await downloadVersion(preparer, record.id, 1);
    const pkg = readPackage(v1.bytes);
    const strings = sharedStrings(pkg);
    const d = cells(readText(pkg, sheetParts(pkg).get('SectionD')!));
    expect(
      cellText(
        d.find((c) => c.ref === 'F12'),
        strings,
      ),
    ).toBe(`Director ${tag} (fictional)`);
    expect(
      cellText(
        d.find((c) => c.ref === 'J12'),
        strings,
      ),
    ).toBe('880516145888');

    // A later change to a record does not alter version 1; a new download is version 2.
    const { relationships } = await listCompanyRelationships(preparer, companyId, '2025-11-01');
    expect(relationships.some((r) => r.personId === director && r.role === 'member')).toBe(true);
    await changePerson(preparer, {
      action: 'update',
      id: director,
      expectedRevision: (await writerDb.select().from(s.people)).find((p) => p.id === director)!
        .revision,
      requestId: rid(),
      fullName: `Director Renamed ${tag} (fictional)`,
      reason: 'Fictional correction',
    });
    const again = await downloadVersion(preparer, record.id, 1);
    expect(again.bytes.equals(v1.bytes)).toBe(true);
    const second = await createDownload(preparer, record.id, {
      requestId: rid(),
      expectedRevision: first.record.revision,
    });
    expect(second.download.version).toBe(2);
    expect(second.download.sha256).not.toBe(first.download.sha256);
  });

  it('shows only the people this return names, masked for staff without view_identity', async () => {
    // Another company's person, named only in a withdrawn draft entry of this company.
    const stranger = randomUUID();
    const now = new Date().toISOString();
    await writerDb.insert(s.people).values({
      id: stranger,
      fullName: `Stranger ${tag} (fictional)`,
      revision: 1,
      data: {
        id: stranger,
        fullName: `Stranger ${tag} (fictional)`,
        nameHistory: [],
        email: null,
        notes: '',
        customValues: {},
        createdBy: preparer.id,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      },
    });
    for (const status of ['Withdrawn', 'Draft'] as const) {
      const id = randomUUID();
      await writerDb.insert(s.shareEntries).values({
        id,
        companyId,
        status,
        revision: 2,
        data: {
          id,
          companyId,
          kind: 'allotment',
          date: '2025-01-01',
          classId: 'ord',
          shares: '5',
          from: null,
          to: { partyIds: [stranger] },
          amountPayable: '5',
          amountPaid: '5',
          consideration: 'Cash',
          sourceDocumentId: documentId,
          sourceCaseId: null,
          note: '',
          status,
          predecessorId: null,
          voids: false,
          preparedBy: preparer.id,
          preparedAt: now,
          reviewerId: null,
          postedAt: null,
          revision: 2,
        },
      });
    }
    // The director also sits on the board of a company this preparer cannot open.
    const other = `${companyId}-other`;
    await writerDb.insert(s.companies).values({
      id: other,
      data: {
        id: other,
        name: 'Other Holdings Sdn Bhd (fictional)',
        registrationNumber: '202001000001',
        incorporationDate: '2020-01-01',
        financialYearEnd: '12-31',
        legalStatus: 'Existing',
        engagementStatus: 'Active',
        address: 'Fictional',
        activity: '',
        verification: 'Unverified',
        sourceEvidenceId: null,
        revision: 3,
      },
    });
    const elsewhere = randomUUID();
    await writerDb.insert(s.companyRelationships).values({
      id: elsewhere,
      companyId: other,
      personId: directorId,
      role: 'director',
      revision: 1,
      data: {
        id: elsewhere,
        companyId: other,
        personId: directorId,
        role: 'director',
        capacity: '',
        startDate: '2020-01-01',
        endDate: null,
        projectedFrom: null,
        evidenceIds: [],
        createdBy: preparer.id,
        createdAt: now,
        revision: 1,
      },
    });

    const view = await getReturn(preparer, returnId);
    expect(view.people.map((p) => p.id)).not.toContain(stranger);
    expect(view.people.map((p) => p.id)).toContain(directorId);
    expect(view.data.d.directors[0]).toMatchObject({
      personId: directorId,
      idNumber: '880516145888',
      otherDirectorships: '[202001000001] OTHER HOLDINGS SDN BHD (FICTIONAL)',
    });

    // The same view for someone without view_identity, and other directorships are the same.
    const viewer: Actor = {
      ...actor('Viewer'),
      capabilities: ROLE_CAPABILITIES.user.filter((c) => c !== 'view_identity'),
    };
    const masked = await getReturn(viewer, returnId);
    expect(masked.data.d.directors[0]).toMatchObject({
      idNumber: '880516-**-****',
      dateOfBirth: '**/**/****',
      passportExpiry: '',
      otherDirectorships: view.data.d.directors[0].otherDirectorships,
    });
    expect(masked.data.d.secretaries[0].idNumber).toBe('850505-**-****');
    expect(masked.data.e.members[0]).toMatchObject({
      partyIds: [directorId],
      idNumber: '880516-**-****',
      dateOfBirth: '**/**/****',
    });
    expect(JSON.stringify(masked)).not.toContain('880516145888');
    expect(JSON.stringify(masked)).not.toContain('1988-05-16');

    // The stored download records the other company's relationship as a source.
    const third = await createDownload(preparer, returnId, {
      requestId: rid(),
      expectedRevision: view.record.revision,
    });
    const stored = await storedSources(returnId, third.download.version);
    expect(stored).toContainEqual({
      kind: 'relationship',
      id: elsewhere,
      revision: 1,
    });
    expect(stored).toContainEqual({ kind: 'company', id: other, revision: 3 });
    expect(stored).not.toContainEqual(expect.objectContaining({ kind: 'person', id: stranger }));

    // The preparer sees only this company: its sources stay, the other company's are stripped.
    const shown = (await getReturn(preparer, returnId)).record.downloads.at(-1)!.sources;
    expect(shown).toContainEqual({ kind: 'company', id: companyId, revision: 1 });
    expect(shown.some((x) => x.kind === 'relationship')).toBe(true);
    expect(shown).not.toContainEqual(expect.objectContaining({ id: elsewhere }));
    expect(shown).not.toContainEqual(expect.objectContaining({ id: other }));
    const saved = await updateReturn(preparer, returnId, {
      requestId: rid(),
      expectedRevision: third.record.revision,
      answers: { ...third.record.answers, notesOnIndebtedness: 'Fictional note' },
    });
    expect(JSON.stringify(saved.downloads)).not.toContain(elsewhere);
    // Someone who can open the other company sees them.
    const both = { ...preparer, companyIds: [companyId, other] };
    expect((await getReturn(both, returnId)).record.downloads.at(-1)!.sources).toContainEqual({
      kind: 'relationship',
      id: elsewhere,
      revision: 1,
    });
  });

  it('versions a hand-entered directorship by the firm company it matched', async () => {
    const matched = `${companyId}-matched`;
    const company = (registrationNumber: string, revision: number) => ({
      id: matched,
      name: `Matched ${tag} Bhd (fictional)`,
      registrationNumber,
      incorporationDate: '2020-01-01',
      financialYearEnd: '12-31',
      legalStatus: 'Existing',
      engagementStatus: 'Active',
      address: 'Fictional',
      activity: '',
      verification: 'Unverified' as const,
      sourceEvidenceId: null,
      revision,
    });
    await writerDb.insert(s.companies).values({ id: matched, data: company('202002000002', 1) });
    const [row] = await writerDb.select().from(s.people).where(eq(s.people.id, directorId));
    await writerDb
      .update(s.people)
      .set({
        data: {
          ...row.data,
          otherDirectorships: [
            {
              id: randomUUID(),
              companyName: `matched ${tag} bhd (fictional)`,
              appointedOn: '2021-01-01',
              ceasedOn: null,
            },
          ],
        },
      })
      .where(eq(s.people.id, directorId));

    const view = await getReturn(preparer, returnId);
    expect(view.data.d.directors[0].otherDirectorships).toContain(
      `[202002000002] MATCHED ${tag.toUpperCase()} BHD (FICTIONAL)`,
    );
    const first = await createDownload(preparer, returnId, {
      requestId: rid(),
      expectedRevision: view.record.revision,
    });
    expect(await storedSources(returnId, first.download.version)).toContainEqual({
      kind: 'company',
      id: matched,
      revision: 1,
    });

    // A new registration number there changes the workbook, so it is a new version.
    await writerDb
      .update(s.companies)
      .set({ data: company('202002000099', 2) })
      .where(eq(s.companies.id, matched));
    const again = await getReturn(preparer, returnId);
    expect(again.data.d.directors[0].otherDirectorships).toContain('[202002000099]');
    const second = await createDownload(preparer, returnId, {
      requestId: rid(),
      expectedRevision: again.record.revision,
    });
    expect(second.download.version).toBe(first.download.version + 1);
    expect(await storedSources(returnId, second.download.version)).toContainEqual({
      kind: 'company',
      id: matched,
      revision: 2,
    });
    // The preparer, who cannot open that company, is not shown its id.
    expect(second.download.sources).not.toContainEqual(expect.objectContaining({ id: matched }));
    // Repeating the request that started the return does not show it either.
    const replayed = await startReturn(preparer, {
      requestId: startRequest,
      companyId,
      calendarYear: 2025,
      application: 'Ordinary filing',
      rectificationDeclaration: '',
      courtOrderReference: '',
    });
    expect(replayed.id).toBe(returnId);
    expect(replayed.downloads.flatMap((d) => d.sources)).not.toContainEqual(
      expect.objectContaining({ id: matched }),
    );
  });
  it('keeps the designation in force on each return date when it changes', async () => {
    const find = async () =>
      (await listCompanyRelationships(preparer, companyId, '2025-11-01')).relationships.find(
        (r) => r.role === 'director' && r.personId === directorId,
      )!;
    const before = await find();
    const change = (effectiveDate: string | null, nominee: boolean, revision: number) =>
      changeRelationship(preparer, companyId, {
        action: 'set_appointment',
        id: before.id,
        expectedRevision: revision,
        requestId: rid(),
        designation: 'Director',
        alternateTo: null,
        nominee,
        effectiveDate,
        reason: 'Fictional',
      });
    // A recorded value is not overwritten without the date the change applies from.
    await expect(change(null, true, before.revision)).rejects.toThrow(
      'Enter the date the change applies from.',
    );
    const changed = await change('2026-06-01', true, before.revision);
    expect(changed.appointmentHistory).toEqual([
      { designation: 'Director', alternateTo: null, nominee: false, from: null },
      { designation: 'Director', alternateTo: null, nominee: true, from: '2026-06-01' },
    ]);
    expect(appointmentAt(changed, '2025-11-01')?.nominee).toBe(false);
    expect(appointmentAt(changed, '2026-06-01')?.nominee).toBe(true);
    // The 2025 return still reads the value in force on its own return date.
    const view = await getReturn(preparer, returnId);
    expect(view.data.d.directors[0].designation).toBe('Director');
    // A date on or before the appointment corrects the value from the start.
    const corrected = await change('2024-11-01', false, changed.revision);
    expect(corrected.appointmentHistory).toEqual([
      { designation: 'Director', alternateTo: null, nominee: false, from: null },
    ]);
  });
});
