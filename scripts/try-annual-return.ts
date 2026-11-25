/**
 * Local evaluation only: sets up a fictional company that matches the fictional blank AR1
 * workbook in tests/fixtures/ar1 (Test Sdn Bhd, 012345678910, first return made up to
 * 1 November 2025), with officers, members, a charge and a return, uploads that blank, and writes
 * the filled workbook to .local/annual-return/. Run after `npm run db:migrate` and
 * `npm run db:seed`. Safe to re-run: it reuses what an earlier run created.
 *
 * Pass a path to use another blank, for example one made in mTool on this PC:
 *   npx tsx scripts/try-annual-return.ts "C:\path\to\blank.xlsx"
 * The blank's FilingInfo must still match Test Sdn Bhd's return.
 *
 * It writes fictional records into whatever DATABASE_PATH names, so it refuses to run unless that
 * file's name contains "check", "test" or "try" (for example .local/ar1check.db), or
 * `--local-eval` is passed to use another local database on purpose.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../src/domain/model';

const args = process.argv.slice(2);
const databaseFile = path.basename(process.env.DATABASE_PATH ?? '.local/cosec.db');
if (!args.includes('--local-eval') && !/check|test|try/i.test(databaseFile)) {
  console.error(
    `Not run: DATABASE_PATH points at ${databaseFile}, and this script writes fictional records into it.\n` +
      'Use a throwaway database whose file name contains "check", "test" or "try" (for example\n' +
      'DATABASE_PATH=.local/ar1check.db), or pass --local-eval to use this database anyway.',
  );
  process.exit(1);
}
// Imported only after the check: opening the database module connects to DATABASE_PATH.
const { eq } = await import('drizzle-orm');
const { closeDatabase, db, writerDb } = await import('../src/server/db');
const { getActorById } = await import('../src/server/repository');
const s = await import('../src/server/schema');
const { changePerson, listPeople } = await import('../src/server/records/people');
const { changeProfile, readProfile } = await import('../src/server/records/profile');
const { changeShareEntry, readShareEntries } = await import('../src/server/records/shares');
const { changeCharge, readCharges } = await import('../src/server/records/charges');
const { changeRelationship } = await import('../src/server/records/relationships');
const { getReturn, startReturn, updateReturn } = await import('../src/server/ar1/returns');
const { createDownload, downloadVersion, uploadBlank } = await import('../src/server/ar1/download');
const { defaultPreferences, ROLE_CAPABILITIES } = await import('../src/domain/model');
const { emptyAnswers } = await import('../src/domain/ar1/returns');

const rid = () => randomUUID();
const blankPath =
  args.find((a) => !a.startsWith('--')) ?? 'tests/fixtures/ar1/blank-first-return.xlsx';
const companyId = 'fictional-test-sdn-bhd';
const out = '.local/annual-return';

const [owner] = await db
  .select({ id: s.user.id })
  .from(s.user)
  .where(eq(s.user.email, 'owner@cosec.local'));
if (!owner) throw new Error('Run npm run db:seed first.');

// The company, and the owner's access to it.
if (!(await db.select().from(s.companies).where(eq(s.companies.id, companyId))).length)
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
      activity: 'Software (fictional)',
      verification: 'Unverified',
      sourceEvidenceId: null,
      revision: 1,
    },
  });
const [user] = await db.select().from(s.user).where(eq(s.user.id, owner.id));
if (!user.companyIds.includes(companyId))
  await writerDb
    .update(s.user)
    .set({ companyIds: [...user.companyIds, companyId] })
    .where(eq(s.user.id, owner.id));
const actor = (await getActorById(owner.id))!;
// Share entries need a second person to post them; this one exists only for the local run. Its
// user row is kept inactive, so it can never sign in: posting checks the actor passed here, not
// the user row.
const reviewer: Actor = {
  id: 'fictional-reviewer',
  name: 'Fictional Reviewer',
  email: 'reviewer@example.invalid',
  capabilities: [...ROLE_CAPABILITIES.user],
  companyIds: [companyId],
  preferences: defaultPreferences,
};
if (!(await db.select().from(s.user).where(eq(s.user.id, reviewer.id))).length)
  await writerDb.insert(s.user).values({
    id: reviewer.id,
    name: reviewer.name,
    email: reviewer.email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    capabilities: reviewer.capabilities,
    companyIds: reviewer.companyIds,
    preferences: reviewer.preferences,
    active: false,
  });
// Made inactive also where an earlier run left it active.
else await writerDb.update(s.user).set({ active: false }).where(eq(s.user.id, reviewer.id));

const address = (prefix: string, line1: string) => ({
  [`${prefix}Line1`]: line1,
  [`${prefix}Postcode`]: '50450',
  [`${prefix}Town`]: 'Kuala Lumpur',
  [`${prefix}State`]: 'W.P. KUALA LUMPUR',
  [`${prefix}Country`]: 'MALAYSIA',
});

let profile = await readProfile(companyId);
if (!profile.particulars?.status) {
  await changeProfile(actor, companyId, {
    action: 'set_particulars',
    expectedRevision: profile.revision,
    requestId: rid(),
    reason: 'Fictional particulars for a local test',
    effectiveDate: '2024-11-01',
    values: {
      origin: 'Incorporated in Malaysia',
      status: 'Private company',
      companyType: 'Company limited by shares',
      ...address('registered', 'Level 5, Menara Contoh (fictional)'),
      membersRegisterAtRegistered: 'Yes',
      financialRecordsAtRegistered: 'Yes',
      ...address('principal', 'Level 5, Menara Contoh (fictional)'),
      phone: '03-0000 0000',
      email: 'office@example.invalid',
      natureOfBusiness: 'Software development (fictional)',
      msic1: '62010',
      msic2: '70209',
    },
  } as never);
  profile = await readProfile(companyId);
}
if (!profile.shareClasses?.length) {
  await changeProfile(actor, companyId, {
    action: 'set_share_classes',
    expectedRevision: profile.revision,
    requestId: rid(),
    reason: 'Fictional constitution',
    classes: [{ id: 'ordinary', name: 'Ordinary shares', kind: 'Ordinary' }],
  } as never);
}

async function person(name: string, values: Record<string, string>, kind?: 'organisation') {
  const found = (await listPeople(actor, { q: name })).people.find((p) => p.fullName === name);
  if (found) return found.id;
  const created = await changePerson(actor, {
    action: 'create',
    requestId: rid(),
    fullName: name,
    kind,
  });
  await changePerson(actor, {
    action: 'set_particulars',
    id: created.id,
    expectedRevision: created.revision,
    requestId: rid(),
    reason: 'Fictional particulars for a local test',
    effectiveDate: '2000-01-01',
    values,
  } as never);
  return created.id;
}
const individual = (id: string, dob: string, race: string, extra: Record<string, string> = {}) => ({
  identityType: 'MyKad',
  identityNumber: id,
  dateOfBirth: dob,
  nationality: 'MALAYSIA',
  race,
  gender: 'Female',
  ...address('residential', '3 Jalan Contoh (fictional)'),
  serviceSameAsResidential: 'Yes',
  occupation: 'COMPANY DIRECTOR',
  ...extra,
});
const tan = await person(
  'Tan Mei Ling (fictional)',
  individual('880516145888', '1988-05-16', 'CHINESE'),
);
const aminah = await person(
  'Aminah binti Yusof (fictional)',
  individual('900101140002', '1990-01-01', 'MALAY'),
);
const lim = await person(
  'Lim Pei Ling (fictional secretary)',
  individual('850505105555', '1985-05-05', 'CHINESE', {
    secretaryBody: 'Malaysian Institute of Chartered Secretaries and Administrators (MAICSA)',
    secretaryLicence: 'MAICSA 0000000',
    practisingCertificate: '202000000000',
  }),
);
const holdings = await person(
  'Contoh Holdings Sdn. Bhd. (fictional)',
  {
    identityType: 'Company Registration No.',
    identityNumber: '201901000001',
    placeOfIncorporation: 'MALAYSIA',
    analysis: 'Bodies corporate controlled by citizens who are non-Malays and non-natives',
    ...address('registered', '8 Jalan Induk (fictional)'),
  },
  'organisation',
);

const relationships = (
  await db
    .select()
    .from(s.companyRelationships)
    .where(eq(s.companyRelationships.companyId, companyId))
).map((r) => r.data);
for (const [personId, role] of [
  [tan, 'director'],
  [aminah, 'director'],
  [lim, 'secretary'],
] as const) {
  if (relationships.some((r) => r.personId === personId && r.role === role)) continue;
  const added = await changeRelationship(actor, companyId, {
    action: 'add',
    requestId: rid(),
    personId,
    role,
    capacity: '',
    startDate: '2024-11-01',
    evidenceIds: [],
  });
  if (role === 'director')
    await changeRelationship(actor, companyId, {
      action: 'set_appointment',
      id: added.id,
      expectedRevision: added.revision,
      requestId: rid(),
      designation: 'Director',
      alternateTo: null,
      nominee: false,
      reason: 'Fictional',
    });
}

// A source document for the share entries (a tiny fictional PDF record, no file needed to post).
const sourceId = 'fictional-allotment-source';
if (!(await db.select().from(s.documents).where(eq(s.documents.id, sourceId))).length)
  await writerDb.insert(s.documents).values({
    id: sourceId,
    companyId,
    data: {
      id: sourceId,
      companyId,
      title: 'First allotment resolution (fictional)',
      originalName: 'allotment.pdf',
      mimeType: 'application/pdf',
      size: 1,
      sha256: '0'.repeat(64),
      storageKey: '00000000-0000-0000-0000-000000000000.pdf',
      createdBy: actor.id,
      createdAt: new Date().toISOString(),
      classification: 'General',
    },
  });
if (!(await readShareEntries(companyId)).length) {
  const allot = async (to: string[], shares: string) => {
    const draft = await changeShareEntry(actor, companyId, {
      action: 'record',
      requestId: rid(),
      kind: 'allotment',
      date: '2024-11-01',
      classId: 'ordinary',
      shares,
      from: null,
      to: { partyIds: to },
      amountPayable: shares,
      amountPaid: shares,
      consideration: 'Cash',
      sourceDocumentId: sourceId,
      sourceCaseId: null,
      note: '',
    });
    await changeShareEntry(reviewer, companyId, {
      action: 'post',
      requestId: rid(),
      id: draft.id,
      expectedRevision: draft.revision,
    });
  };
  await allot([tan], '60000');
  await allot([aminah], '25000');
  await allot([holdings], '10000');
  await allot([tan, aminah], '5000');
}
if (!(await readCharges(companyId)).length)
  await changeCharge(actor, companyId, {
    action: 'record',
    requestId: rid(),
    registeredNumber: 'CC2025011500001',
    registeredOn: '2025-01-15',
    nature: 'Fixed and floating charge',
    chargee: 'FICTIONAL BANK BERHAD',
    amount: '1500000.00',
    dischargedOn: null,
    note: '',
  });

// The 2025 return: start it, answer the certificate, upload the blank and download.
const [existing] = await db
  .select()
  .from(s.annualReturns)
  .where(eq(s.annualReturns.companyId, companyId));
let record =
  existing?.data ??
  (await startReturn(actor, {
    requestId: rid(),
    companyId,
    calendarYear: 2025,
    application: 'Ordinary filing',
    rectificationDeclaration: '',
    courtOrderReference: '',
  }));
if (!record.answers.certificate.boStatus) {
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
  record = await updateReturn(actor, record.id, {
    requestId: rid(),
    expectedRevision: record.revision,
    answers,
  });
}
const blank = await readFile(blankPath);
record = await uploadBlank(actor, record.id, {
  requestId: rid(),
  expectedRevision: record.revision,
  file: new File([new Uint8Array(blank)], blankPath.split(/[\\/]/).pop()!),
});
const view = await getReturn(actor, record.id);
if (view.filingCheck?.length) {
  console.log('The blank does not match the return:', view.filingCheck);
  process.exitCode = 1;
} else {
  const { download } = await createDownload(actor, record.id, {
    requestId: rid(),
    expectedRevision: record.revision,
  });
  const file = await downloadVersion(actor, record.id, download.version);
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/${file.fileName}`, file.bytes);
  console.log(
    `ready ${out}/${file.fileName} (${download.rowsAdded} rows added, ${download.cellsWritten} cells written, ${download.missing.length} items missing)`,
  );
  for (const m of download.missing) console.log(`  missing: ${m}`);
  console.log(`Open it in the app: http://127.0.0.1:4300/annual-returns/${record.id}`);
}
closeDatabase();
