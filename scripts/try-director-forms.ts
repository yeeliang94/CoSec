/**
 * Local evaluation only: prepares a fictional director appointment set and an annual return
 * resolution in the local database and writes the generated Word files to .local/director-forms/.
 * Run after `npm run db:seed` and `npx tsx scripts/seed-resolution-samples.ts`.
 *
 * It changes the firm settings and writes fictional records into whatever DATABASE_PATH names,
 * so it refuses to run unless that file's name contains "check", "test" or "try", or
 * `--local-eval` is passed to use another local database on purpose. It creates no extra user.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolutionCase } from '../src/domain/resolution/model';

const databaseFile = path.basename(process.env.DATABASE_PATH ?? '.local/cosec.db');
if (!process.argv.slice(2).includes('--local-eval') && !/check|test|try/i.test(databaseFile)) {
  console.error(
    `Not run: DATABASE_PATH points at ${databaseFile}, and this script writes fictional records into it.\n` +
      'Use a throwaway database whose file name contains "check", "test" or "try", or pass\n' +
      '--local-eval to use this database anyway.',
  );
  process.exit(1);
}
// Imported only after the check: opening the database module connects to DATABASE_PATH.
const { eq } = await import('drizzle-orm');
const { closeDatabase, db } = await import('../src/server/db');
const { getActorById, getSettings } = await import('../src/server/repository');
const s = await import('../src/server/schema');
const { changePerson, listPeople } = await import('../src/server/records/people');
const { changeRelationship } = await import('../src/server/records/relationships');
const { createCase } = await import('../src/server/records/cases');
const { applySettingsAction } = await import('../src/server/support');
const { applyClauseAction, getCaseClauses } = await import('../src/server/resolution/selection');
const { generateDocument } = await import('../src/server/resolution/generation');
const { downloadGeneration, getGeneration } =
  await import('../src/server/resolution/generation-records');
const { readCase } = await import('../src/server/resolution/shared');

const today = new Date().toISOString().slice(0, 10);
const rid = () => randomUUID();
const [owner] = await db
  .select({ id: s.user.id })
  .from(s.user)
  .where(eq(s.user.email, 'owner@cosec.local'));
const actor = (await getActorById(owner.id))!;
const companies = (await db.select().from(s.companies)).map((r) => r.data);
const company = companies.find((c) => c.name.startsWith('Cedar Field'))!;
const out = '.local/director-forms';
await mkdir(out, { recursive: true });

// Firm lodger details (fictional).
const settings = await getSettings();
await applySettingsAction(actor, {
  action: 'defaults',
  expectedRevision: (await db.select().from(s.settings))[0].revision,
  requestId: rid(),
  firmName: settings.firmName,
  firmRegistrationNumber: '201901000001 (fictional)',
  firmAddress: '2 Example Avenue, 50000 Kuala Lumpur (fictional)',
  firmPhone: '03-0000 0000',
  firmEmail: 'secretarial@example.invalid',
});

// The proposed director (particulars entered on the People screen) and a fictional secretary.
const appointee = (await listPeople(actor, { q: 'Adrian Lee' })).people[0];
if (!appointee.particulars?.identityNumber)
  await changePerson(actor, {
    action: 'set_particulars',
    id: appointee.id,
    expectedRevision: appointee.revision,
    requestId: rid(),
    effectiveDate: '2020-01-01',
    reason: 'Fictional particulars for a local test',
    values: {
      identityType: 'MyKad',
      identityNumber: '880516-14-5888',
      dateOfBirth: '1988-05-16',
      gender: 'Male',
      race: 'CHINESE',
      nationality: 'MALAYSIA',
      occupation: 'DIRECTOR',
      residentialLine1: 'Valencia (fictional)',
      residentialPostcode: '47000',
      residentialTown: 'Sungai Buloh',
      residentialState: 'SELANGOR',
      residentialCountry: 'MALAYSIA',
      serviceSameAsResidential: 'Yes',
    },
  } as never);
let secretary = (await listPeople(actor, { q: 'Lim Pei Ling' })).people[0];
if (!secretary) {
  const created = await changePerson(actor, {
    action: 'create',
    requestId: rid(),
    fullName: 'Lim Pei Ling (fictional)',
  });
  await changePerson(actor, {
    action: 'set_particulars',
    id: created.id,
    expectedRevision: created.revision,
    requestId: rid(),
    effectiveDate: '2020-01-01',
    reason: 'Fictional secretary for a local test',
    values: {
      identityType: 'MyKad',
      identityNumber: '840719-10-0000',
      secretaryBody: 'Malaysian Institute of Chartered Secretaries and Administrators (MAICSA)',
      secretaryLicence: 'MAICSA 0000000',
      practisingCertificate: '202000000000',
    },
  } as never);
  await changeRelationship(actor, company.id, {
    action: 'add',
    requestId: rid(),
    personId: created.id,
    role: 'secretary',
    capacity: 'Secretary',
    startDate: '2020-01-01',
    evidenceIds: [],
  } as never);
  secretary = (await listPeople(actor, { q: 'Lim Pei Ling' })).people[0];
}

async function prepare(rc: ResolutionCase, assemblyVersionId: string, first: boolean) {
  rc = await applyClauseAction(
    actor,
    rc.id,
    first
      ? {
          action: 'set_selection',
          expectedRevision: rc.revision,
          requestId: rid(),
          outputTypeId: (await getCaseClauses(actor, rc.id)).documentSet!.find(
            (d) => d.assemblyVersionId === assemblyVersionId,
          )!.outputTypeId,
          assemblyVersionId,
          clauses: [],
        }
      : {
          action: 'switch_document',
          expectedRevision: rc.revision,
          requestId: rid(),
          assemblyVersionId,
        },
  );
  return rc;
}
async function answerAndGenerate(
  rc: ResolutionCase,
  shared: Record<string, unknown>,
  name: string,
) {
  const model = await getCaseClauses(actor, rc.id);
  const directors = model.formInput!.ctx.directors.map((d) => d.id);
  const clauses = Object.fromEntries(
    (model.form?.clauses ?? []).map((c) => [c.key, rc.answers.clauses[c.key] ?? {}]),
  );
  rc = await applyClauseAction(actor, rc.id, {
    action: 'save_answers',
    expectedRevision: rc.revision,
    requestId: rid(),
    selectionRevision: rc.selection!.revision,
    shared: { ...rc.answers.shared, ...shared },
    clauses,
    signers: {
      directors,
      members: [],
      certifiers: [directors[0], secretary.id],
      subject: [appointee.id],
    },
  });
  const generation = await generateDocument(actor, {
    requestId: rid(),
    caseId: rc.id,
    expectedCaseRevision: rc.revision,
    selectionRevision: rc.selection!.revision,
  });
  const ready = await getGeneration(actor, generation.id);
  if (ready.status !== 'Ready') throw new Error(`${name}: ${ready.status} ${ready.failure ?? ''}`);
  const { bytes } = await downloadGeneration(actor, generation.id);
  const file = `${out}/${name}.docx`;
  await writeFile(file, bytes);
  console.info(`ready    ${file}`);
  return readCase(actor, rc.id);
}

let rc = await createCase(actor, {
  requestId: rid(),
  companyId: company.id,
  kind: 'director_appointment',
  title: 'Appointment of Adrian Lee (fictional)',
  resolutionDate: today,
} as never);
const set = (await getCaseClauses(actor, rc.id)).documentSet!;
console.info(`set      ${set.map((d) => d.name).join(' | ')}`);
const shared = {
  appointee: appointee.id,
  appointment_date: today,
  resolution_date: today,
  lodger: secretary.id,
  leave_paragraph: 'none',
  declarant_capacity: 'director',
  director_status: 'new',
  notice_particulars: true,
  notice_interests: true,
  notice_contracts: true,
};
for (const [i, doc] of set.entries()) {
  rc = await prepare(rc, doc.assemblyVersionId, i === 0);
  rc = await answerAndGenerate(rc, shared, doc.name.replace(/[^A-Za-z0-9]+/g, '-'));
}

// The annual return resolution as an ordinary board case.
let board = await createCase(actor, {
  requestId: rid(),
  companyId: company.id,
  kind: 'board',
  title: 'Annual return 2026 (fictional)',
  resolutionDate: today,
} as never);
const ar = (await getCaseClauses(actor, board.id)).available.assemblies.find(
  (a) => a.name === 'Annual return resolution',
)!;
board = await applyClauseAction(actor, board.id, {
  action: 'set_selection',
  expectedRevision: board.revision,
  requestId: rid(),
  outputTypeId: ar.outputTypeId,
  assemblyVersionId: ar.assemblyVersionId,
  clauses: [],
});
const arKey = board.selection!.clauses[0].key;
board.answers.clauses[arKey] = { return_year: '2026', made_up_to: today, include_extension: true };
await answerAndGenerate(board, { resolution_date: today }, 'Annual-return-resolution');
closeDatabase();
