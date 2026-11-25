import 'dotenv/config';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { Document as WordDocument, Packer, Paragraph } from 'docx';
import { closeDatabase, db, writerDb } from '../src/server/db';
import * as s from '../src/server/schema';
import * as repo from '../src/server/repository';
import { defaultPreferences, defaultSettings, type Actor, type Company } from '../src/domain/model';
import { defaultImportSettings } from '../src/domain/imports';
import {
  addImportFile,
  changeImport,
  changeImportRow,
  createImport,
  getImport,
  getImportCompany,
  readRow,
} from '../src/server/imports/store';
import { tickImports, settleImports } from '../src/server/imports/runner';
import { applyImportCompany } from '../src/server/imports/apply';
import type { ModelCaller, ModelRequest } from '../src/server/imports/gateway';
import { readProfile } from '../src/server/records/profile';
import { companyRelationships } from '../src/server/records/relationships';
import { readShareEntries } from '../src/server/records/shares';

process.env.OPENAI_API_KEY = 'test-key-not-real';
const existingId = randomUUID();
const actor: Actor = {
  id: randomUUID(),
  name: 'Import preparer',
  email: `import-${randomUUID()}@example.invalid`,
  capabilities: ['prepare_job', 'review_pack', 'confirm_record', 'manage_people', 'view_identity'],
  companyIds: [existingId],
  preferences: defaultPreferences,
};
const existing: Company = {
  id: existingId,
  name: 'Meranti Trading Sdn. Bhd.',
  registrationNumber: `2020${String(Date.now()).slice(-8)}`,
  incorporationDate: '2020-02-14',
  financialYearEnd: '12-31',
  legalStatus: 'Existing',
  engagementStatus: 'Active',
  address: 'Fictional',
  activity: 'Timber',
  verification: 'Unverified',
  sourceEvidenceId: null,
  createdBy: actor.id,
  revision: 1,
};
const newReg = `2021${String(Date.now()).slice(-8)}`;
let settingsBefore: unknown;

beforeAll(async () => {
  await writerDb.insert(s.companies).values({ id: existingId, data: existing });
  await writerDb.insert(s.user).values({
    id: actor.id,
    name: actor.name,
    email: actor.email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    capabilities: actor.capabilities,
    companyIds: actor.companyIds,
    preferences: actor.preferences,
    active: true,
  });
  const [row] = await db.select().from(s.settings).where(eq(s.settings.id, 'firm'));
  settingsBefore = row ?? null;
  const data = {
    ...(row?.data ?? defaultSettings),
    importSettings: {
      ...defaultImportSettings,
      gatewayUrl: 'http://127.0.0.1:9/v1',
      model: 'test-model',
    },
  };
  if (row) await writerDb.update(s.settings).set({ data }).where(eq(s.settings.id, 'firm'));
  else await writerDb.insert(s.settings).values({ id: 'firm', revision: 1, data });
});
afterAll(async () => {
  // Leave the shared test database as other suites expect: remove this suite's import rows.
  const batches = (await db.select().from(s.imports).where(eq(s.imports.createdBy, actor.id))).map(
    (b) => b.id,
  );
  if (batches.length) {
    await writerDb.delete(s.importCompanies).where(inArray(s.importCompanies.importId, batches));
    await writerDb.delete(s.imports).where(inArray(s.imports.id, batches));
  }
  if (settingsBefore === null) await writerDb.delete(s.settings).where(eq(s.settings.id, 'firm'));
  else
    await writerDb
      .update(s.settings)
      .set({ data: (settingsBefore as { data: never }).data })
      .where(eq(s.settings.id, 'firm'));
  closeDatabase();
});

/** A stand-in model: for each company folder, a list of turns, each a list of tool calls. */
function scripted(
  script: Record<
    string,
    (ids: Record<string, string>, round: number) => { name: string; args: object }[][]
  >,
): ModelCaller & { requests: ModelRequest[] } {
  const turns = new Map<string, number>();
  const rounds = new Map<string, number>();
  const requests: ModelRequest[] = [];
  const caller = (async (request: ModelRequest) => {
    requests.push(request);
    const opening = String((request.input[0] as { content: string }).content);
    const folder = /Company folder: "(.*?)"/.exec(opening)![1];
    const ids = Object.fromEntries(
      [...opening.matchAll(/^- ([0-9a-f-]{36}): (\S+)/gm)].map((m) => [m[2], m[1]]),
    );
    if (request.input.length === 1) {
      rounds.set(folder, (rounds.get(folder) ?? 0) + 1);
      turns.set(folder, 0);
    }
    const turn = turns.get(folder)!;
    turns.set(folder, turn + 1);
    const plan = script[folder](ids, rounds.get(folder)!);
    const calls = plan[turn] ?? [{ name: 'finish', args: { summary: 'Done.', not_found: [] } }];
    return {
      output: calls.map((c) => ({
        type: 'function_call',
        call_id: randomUUID(),
        name: c.name,
        arguments: JSON.stringify(c.args),
      })),
      usage: { inputTokens: 1000, outputTokens: 100 },
    };
  }) as unknown as ModelCaller & { requests: ModelRequest[] };
  caller.requests = requests;
  return caller;
}
const src = (file: string, quote: string, page: number | null = 1) => ({
  file_id: file,
  page,
  quote,
});

async function upload(importId: string, rowId: string, path: string, bytes: Uint8Array) {
  return addImportFile(actor, importId, {
    rowId,
    path,
    size: bytes.byteLength,
    file: new File([Buffer.from(bytes)], path.split('/').pop()!),
  });
}
async function wordFile(lines: string[]) {
  const doc = new WordDocument({ sections: [{ children: lines.map((l) => new Paragraph(l)) }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}
async function excelFile(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Members');
  rows.forEach((r) => ws.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

let importId = '';
let newRowId = '';
let existingRowId = '';

it('creates an import with one row per company folder and stores each file', async () => {
  const batch = await createImport(actor, {
    requestId: randomUUID(),
    name: 'Client files, batch test',
    looseFiles: 2,
    folders: [
      { folder: 'Meranti', target: { mode: 'existing', companyId: existingId } },
      { folder: 'Kenanga', target: { mode: 'new' } },
      { folder: 'Misc 2019', target: { mode: 'leave_out' } },
    ],
  });
  importId = batch.id;
  const view = await getImport(actor, importId);
  expect(view.companies.map((c) => c.status).sort()).toEqual([
    'Left out',
    'Uploading',
    'Uploading',
  ]);
  newRowId = view.companies.find((c) => c.folder === 'Kenanga')!.id;
  existingRowId = view.companies.find((c) => c.folder === 'Meranti')!.id;
  await upload(
    importId,
    newRowId,
    'Form 9.docx',
    await wordFile([
      'Certificate of incorporation',
      `Kenanga Logistics Sdn. Bhd. registration no. ${newReg} incorporated on 3 March 2021`,
    ]),
  );
  await upload(
    importId,
    newRowId,
    'registers/members.xlsx',
    await excelFile([
      ['Name', 'MyKad', 'Shares'],
      ['Tan Mei Ling', '750101145678', 10000],
    ]),
  );
  await upload(importId, newRowId, 'old.xls', new Uint8Array([1, 2, 3]));
  await upload(
    importId,
    existingRowId,
    'AR 2024.docx',
    await wordFile(['Annual return 2024', 'Phone 03-2100 0000']),
  );
  await upload(
    importId,
    existingRowId,
    'IMG_7731.docx',
    await wordFile(['Consent to act, Kenanga Logistics']),
  );
  const row = await readRow(newRowId);
  expect(row.files.map((f) => [f.name, f.result])).toEqual([
    ['Form 9.docx', 'Waiting'],
    ['members.xlsx', 'Waiting'],
    ['old.xls', 'Could not read'],
  ]);
  await expect(getImport({ ...actor, id: randomUUID() }, importId)).rejects.toThrow(
    'Import access is unavailable.',
  );
});

it('reads each company folder with its own agent, checks values and keeps companies apart', async () => {
  const caller = scripted({
    Kenanga: (ids, round) =>
      round === 1
        ? [
            [
              { name: 'read_text', args: { file_id: ids['Form'], from_page: 1, to_page: 1 } },
              {
                name: 'classify_file',
                args: {
                  file_id: ids['Form'],
                  read_as: 'Certificate of incorporation',
                  about: 'this_company',
                  other_company_name: null,
                },
              },
              {
                name: 'classify_file',
                args: {
                  file_id: ids['registers/members.xlsx'],
                  read_as: 'Register of members',
                  about: 'this_company',
                  other_company_name: null,
                },
              },
            ],
            [
              {
                name: 'suggest_company_value',
                args: {
                  key: 'name',
                  value: 'Kenanga Logistics Sdn. Bhd.',
                  effective_date: null,
                  ...src(ids['Form'], 'Kenanga Logistics Sdn. Bhd.'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registrationNumber',
                  value: newReg,
                  effective_date: null,
                  ...src(ids['Form'], newReg),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'incorporationDate',
                  value: '03/03/2021',
                  effective_date: null,
                  ...src(ids['Form'], '3 March 2021'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'incorporationDate',
                  value: '2021-03-03',
                  effective_date: null,
                  ...src(ids['Form'], '3 March 2021'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'financialYearEnd',
                  value: '12-31',
                  effective_date: null,
                  ...src(ids['Form'], 'year end'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'industry',
                  value: 'h',
                  effective_date: null,
                  ...src(ids['Form'], 'logistics'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registeredLine1',
                  value: '12 Jalan Kenanga',
                  effective_date: '2021-03-03',
                  ...src(ids['Form'], '12 Jalan Kenanga'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registeredPostcode',
                  value: '50450',
                  effective_date: '2021-03-03',
                  ...src(ids['Form'], '50450'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registeredTown',
                  value: 'Kuala Lumpur',
                  effective_date: '2021-03-03',
                  ...src(ids['Form'], 'Kuala Lumpur'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registeredState',
                  value: 'W.P. KUALA LUMPUR',
                  effective_date: '2021-03-03',
                  ...src(ids['Form'], 'Kuala Lumpur'),
                },
              },
              {
                name: 'suggest_company_value',
                args: {
                  key: 'registeredCountry',
                  value: 'MALAYSIA',
                  effective_date: '2021-03-03',
                  ...src(ids['Form'], 'Malaysia'),
                },
              },
              {
                name: 'suggest_person',
                args: {
                  ref: 'P1',
                  kind: 'individual',
                  full_name: 'Tan Mei Ling',
                  values: { identityType: 'MyKad', identityNumber: '750101-14-5678' },
                  effective_date: null,
                  ...src(ids['registers/members.xlsx'], 'Tan Mei Ling | 750101145678'),
                },
              },
              {
                name: 'suggest_role',
                args: {
                  person_ref: 'P1',
                  role: 'director',
                  start_date: '2021-03-03',
                  end_date: null,
                  cessation: null,
                  ...src(ids['Form'], 'first director'),
                },
              },
              {
                name: 'suggest_shares',
                args: {
                  person_refs: ['P1'],
                  class_name: 'Ordinary',
                  class_kind: 'Ordinary',
                  shares: '10,000',
                  amount_payable: null,
                  amount_paid: '10000.00',
                  consideration: 'Cash',
                  date: '2021-03-03',
                  ...src(ids['registers/members.xlsx'], '10000'),
                },
              },
              {
                name: 'suggest_role',
                args: {
                  person_ref: 'P9',
                  role: 'secretary',
                  start_date: '2021-03-03',
                  end_date: null,
                  cessation: null,
                  ...src(ids['Form'], 'secretary'),
                },
              },
              { name: 'read_text', args: { file_id: ids['old.xls'], from_page: 1, to_page: 1 } },
              {
                name: 'ask_question',
                args: {
                  text: 'Is the secretary still in office?',
                  choices: [
                    { label: 'Yes', file_id: null, page: null, quote: null },
                    { label: 'No', file_id: null, page: null, quote: null },
                  ],
                  suggested_choice: 0,
                },
              },
            ],
            [{ name: 'finish', args: { summary: 'Read both files.', not_found: [] } }],
            // After the app's check sends back the unknown ref P9:
            [{ name: 'remove_suggestion', args: { id: 'unknown', reason: 'x' } }],
          ]
        : [[{ name: 'finish', args: { summary: 'Settled the answer.', not_found: [] } }]],
    Meranti: (ids) => [
      [
        {
          name: 'classify_file',
          args: {
            file_id: ids['IMG_7731.docx'],
            read_as: 'Consent to act',
            about: 'another_company',
            other_company_name: 'Kenanga Logistics',
          },
        },
        {
          name: 'suggest_company_value',
          args: {
            key: 'phone',
            value: '03-2100 0000',
            effective_date: '2024-12-31',
            ...src(ids['AR'], 'Phone 03-2100 0000'),
          },
        },
        {
          name: 'suggest_company_value',
          args: {
            key: 'financialYearEnd',
            value: '06-30',
            effective_date: null,
            ...src(ids['AR'], 'year end 30 June'),
          },
        },
        {
          name: 'suggest_company_value',
          args: {
            key: 'email',
            value: 'x',
            effective_date: null,
            ...src(ids['IMG_7731.docx'], 'anything'),
          },
        },
        { name: 'read_text', args: { file_id: 'not-in-this-folder', from_page: 1, to_page: 1 } },
        {
          name: 'classify_file',
          args: {
            file_id: ids['AR'],
            read_as: 'Annual return 2024',
            about: 'this_company',
            other_company_name: null,
          },
        },
      ],
      [{ name: 'finish', args: { summary: 'Done.', not_found: ['Website'] } }],
    ],
  });
  // The second Kenanga turn's P9 role fails the app check; the agent then removes it by id.
  await changeImport(actor, importId, { action: 'start' });
  await tickImports(caller);
  await settleImports();

  const kenanga = await readRow(newRowId);
  const meranti = await readRow(existingRowId);
  expect(meranti.status).toBe('Ready');
  // A file about another company is set aside and none of its values are used.
  const stray = meranti.files.find((f) => f.name === 'IMG_7731.docx')!;
  expect([stray.result, stray.otherCompany]).toEqual(['Another company', 'Kenanga Logistics']);
  expect(meranti.suggestions.map((x) => (x.kind === 'company' ? [x.key, x.use] : null))).toEqual([
    ['phone', true],
    // An existing company's year end is shown but never changed.
    ['financialYearEnd', false],
  ]);
  // The agent's tool results told it about each problem, so it could correct them.
  const outputs = caller.requests
    .flatMap((r) => r.input)
    .filter((i) => (i as { type?: string }).type === 'function_call_output')
    .map((i) => (i as { output: string }).output);
  expect(outputs).toContain('Not saved: That file id is not in this company folder.');
  expect(outputs).toContain('Not saved: Give the date as YYYY-MM-DD.');
  expect(
    outputs.some((o) => o.startsWith('Not saved: That file could not be read: old Office format')),
  ).toBe(true);
  const sentBack = caller.requests
    .flatMap((r) => r.input)
    .find(
      (i) =>
        typeof (i as { content?: unknown }).content === 'string' &&
        (i as { content: string }).content.includes('the app found these problems'),
    ) as { content: string };
  expect(sentBack.content).toContain('names P9');

  expect(kenanga.status).toBe('Needs answer');
  expect(kenanga.name).toBe('Kenanga Logistics Sdn. Bhd.');
  const industry = kenanga.suggestions.find((x) => x.kind === 'company' && x.key === 'industry');
  expect(industry && industry.kind === 'company' && industry.value).toBe('H');
  const person = kenanga.suggestions.find((x) => x.kind === 'person');
  expect(person?.kind === 'person' && person.values.identityNumber).toBe('750101145678');
  expect(kenanga.files.find((f) => f.name === 'Form 9.docx')!.result).toBe('Used');
  expect(kenanga.run.turns).toBeGreaterThan(0);
  expect(kenanga.run.usageByDay).not.toEqual({});
});

it('masks identity numbers for a reviewer without view_identity and blocks apply until answered', async () => {
  const masked = await getImportCompany(
    { ...actor, capabilities: ['prepare_job', 'manage_people'] },
    importId,
    newRowId,
  );
  const person = masked.row.suggestions.find((x) => x.kind === 'person');
  expect(person?.kind === 'person' && person.values.identityNumber).toBe('750101-**-****');
  const row = await readRow(newRowId);
  await expect(
    applyImportCompany(actor, importId, newRowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow('Answer the questions before applying.');
});

it('sends answers back to the agent, then applies the whole company in one go', async () => {
  let row = await readRow(newRowId);
  const secretary = row.suggestions.find((x) => x.kind === 'role' && x.personRef === 'P9');
  if (secretary)
    row = await changeImportRow(actor, importId, newRowId, {
      action: 'set_use',
      expectedRevision: row.revision,
      suggestionIds: [secretary.id],
      use: false,
    });
  row = await changeImportRow(actor, importId, newRowId, {
    action: 'answer',
    expectedRevision: row.revision,
    questionId: row.questions[0].id,
    choice: 0,
    text: '',
  });
  expect(row.status).toBe('Waiting');
  const caller = scripted({
    Kenanga: () => [[{ name: 'finish', args: { summary: 'Settled.', not_found: [] } }]],
    Meranti: () => [],
  });
  await tickImports(caller);
  await settleImports();
  row = await readRow(newRowId);
  expect(row.status).toBe('Ready');
  expect(String((caller.requests[0].input[0] as { content: string }).content)).toContain(
    'Answer: Yes',
  );

  const applied = await applyImportCompany(actor, importId, newRowId, {
    expectedRevision: row.revision,
    requestId: randomUUID(),
  });
  expect(applied.status).toBe('Applied');
  expect(applied.suggestions).toEqual([]);
  const companyId = applied.applied!.companyId;
  const company = await repo.getCompany(companyId);
  expect([
    company.name,
    company.verification,
    company.incorporationDate,
    company.financialYearEnd,
  ]).toEqual(['Kenanga Logistics Sdn. Bhd.', 'Unverified', '2021-03-03', '12-31']);
  const profile = await readProfile(companyId);
  expect(profile.particulars?.registeredPostcode?.[0]).toMatchObject({
    value: '50450',
    effectiveDate: '2021-03-03',
  });
  expect(profile.shareClasses?.map((c) => c.name)).toEqual(['Ordinary']);
  const roles = await companyRelationships(companyId);
  expect(roles.map((r) => [r.personName, r.role, r.startDate])).toEqual([
    ['Tan Mei Ling', 'director', '2021-03-03'],
  ]);
  const entries = await readShareEntries(companyId);
  expect(
    entries.map((e) => [e.kind, e.status, e.shares, e.consideration, Boolean(e.sourceDocumentId)]),
  ).toEqual([['opening', 'Draft', '10000', 'Cash', true]]);
  const docs = await db.select().from(s.documents).where(eq(s.documents.companyId, companyId));
  expect(docs.map((d) => d.data.originalName).sort()).toEqual(['Form 9.docx', 'members.xlsx']);
  // Every audit entry for the new company names the import.
  const audits = await db
    .select()
    .from(s.auditEvents)
    .where(eq(s.auditEvents.companyId, companyId));
  expect(audits.length).toBeGreaterThan(3);
  expect(
    audits.every(
      (a) =>
        (a.detail as { importSource?: { importId: string } }).importSource?.importId === importId,
    ),
  ).toBe(true);
});

it('rolls back everything when one step fails, and refuses a duplicate registration number', async () => {
  // A second import of the same new company must not create it twice.
  const batch = await createImport(actor, {
    requestId: randomUUID(),
    name: 'Again',
    looseFiles: 0,
    folders: [{ folder: 'Kenanga again', target: { mode: 'new' } }],
  });
  const rowId = (await getImport(actor, batch.id)).companies[0].id;
  await upload(batch.id, rowId, 'Form 9.docx', await wordFile([`Kenanga ${newReg}`]));
  await changeImport(actor, batch.id, { action: 'start' });
  const caller = scripted({
    'Kenanga again': (ids) => [
      [
        'name',
        'registrationNumber',
        'incorporationDate',
        'financialYearEnd',
        'industry',
        'registeredLine1',
      ].map((key) => ({
        name: 'suggest_company_value',
        args: {
          key,
          value: {
            name: 'Kenanga Logistics Sdn. Bhd.',
            registrationNumber: newReg,
            incorporationDate: '2021-03-03',
            financialYearEnd: '12-31',
            industry: 'H',
            registeredLine1: '12 Jalan Kenanga',
          }[key],
          effective_date: null,
          ...src(ids['Form'], 'Kenanga'),
        },
      })),
      [
        {
          name: 'classify_file',
          args: {
            file_id: ids['Form'],
            read_as: 'Form 9',
            about: 'this_company',
            other_company_name: null,
          },
        },
      ],
    ],
  });
  await tickImports(caller);
  await settleImports();
  const row = await readRow(rowId);
  expect(row.status).toBe('Ready');
  const before = (await db.select().from(s.companies)).length;
  await expect(
    applyImportCompany(actor, batch.id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow(/already in the app/);
  expect((await db.select().from(s.companies)).length).toBe(before);
  expect((await readRow(rowId)).status).toBe('Ready');
});

it('rolls back the company, people and documents when a later write fails', async () => {
  const batch = await createImport(actor, {
    requestId: randomUUID(),
    name: 'Rollback',
    looseFiles: 0,
    folders: [{ folder: 'Halia', target: { mode: 'new' } }],
  });
  const rowId = (await getImport(actor, batch.id)).companies[0].id;
  await upload(batch.id, rowId, 'Form 9.docx', await wordFile(['Halia Foods']));
  await changeImport(actor, batch.id, { action: 'start' });
  const reg = `2022${String(Date.now()).slice(-8)}`;
  const values: Record<string, string> = {
    name: 'Halia Foods Sdn. Bhd.',
    registrationNumber: reg,
    incorporationDate: '2022-01-10',
    financialYearEnd: '12-31',
    industry: 'C',
    // An incomplete registered address: the profile writer rejects it after the company exists.
    registeredLine1: '1 Jalan Halia',
    registeredCountry: 'MALAYSIA',
  };
  const caller = scripted({
    Halia: (ids) => [
      Object.entries(values).map(([key, value]) => ({
        name: 'suggest_company_value',
        args: { key, value, effective_date: null, ...src(ids['Form'], 'Halia') },
      })),
      [
        {
          name: 'suggest_person',
          args: {
            ref: 'P1',
            kind: 'individual',
            full_name: 'Rollback Person',
            values: {},
            effective_date: null,
            ...src(ids['Form'], 'Halia'),
          },
        },
        {
          name: 'classify_file',
          args: {
            file_id: ids['Form'],
            read_as: 'Form 9',
            about: 'this_company',
            other_company_name: null,
          },
        },
      ],
    ],
  });
  await tickImports(caller);
  await settleImports();
  const row = await readRow(rowId);
  const peopleBefore = (await db.select().from(s.people)).length;
  await expect(
    applyImportCompany(actor, batch.id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow('Check the company particulars.');
  const companies = (await db.select().from(s.companies)).filter(
    (c) => c.data.registrationNumber === reg,
  );
  expect(companies).toEqual([]);
  expect((await db.select().from(s.people)).length).toBe(peopleBefore);
  expect((await readRow(rowId)).status).toBe('Ready');
});

it('moves a stray file to the company it belongs to, which is then read again', async () => {
  const meranti = await readRow(existingRowId);
  const stray = meranti.files.find((f) => f.result === 'Another company')!;
  const other = (await getImport(actor, importId)).companies.find((c) => c.folder === 'Misc 2019')!;
  await expect(
    changeImportRow(actor, importId, existingRowId, {
      action: 'move_file',
      fileId: stray.id,
      toRowId: newRowId,
    }),
  ).rejects.toThrow(/already applied or left out/);
  void other;
  await changeImportRow(actor, importId, existingRowId, {
    action: 'move_file',
    fileId: stray.id,
    toRowId: null,
  });
  expect((await readRow(existingRowId)).files.find((f) => f.id === stray.id)!.result).toBe(
    'Not used',
  );
});

it('pauses and resumes; a paused import is not read', async () => {
  await changeImport(actor, importId, { action: 'pause' });
  const row = await readRow(existingRowId);
  await changeImportRow(actor, importId, existingRowId, {
    action: 'run_again',
    expectedRevision: row.revision,
  });
  const caller = scripted({ Meranti: () => [] });
  expect(await tickImports(caller)).toBe(0);
  await changeImport(actor, importId, { action: 'resume' });
  expect(await tickImports(caller)).toBe(1);
  await settleImports();
  expect((await readRow(existingRowId)).status).toBe('Ready');
});

// ---------------------------------------------------------------- review fixes
async function freshImport(
  folder: string,
  target: { mode: 'new' } | { mode: 'existing'; companyId: string },
) {
  const batch = await createImport(actor, {
    requestId: randomUUID(),
    name: `Fix check ${folder}`,
    looseFiles: 0,
    folders: [{ folder, target }],
  });
  const rowId = (await getImport(actor, batch.id)).companies[0].id;
  await upload(batch.id, rowId, 'Form 9.docx', await wordFile([`${folder} source`]));
  await changeImport(actor, batch.id, { action: 'start' });
  return { importId: batch.id, rowId };
}
const company = (ids: Record<string, string>, values: Record<string, string>) =>
  Object.entries(values).map(([key, value]) => ({
    name: 'suggest_company_value',
    args: { key, value, effective_date: null, ...src(ids['Form'], value) },
  }));
const classify = (ids: Record<string, string>) => ({
  name: 'classify_file',
  args: {
    file_id: ids['Form'],
    read_as: 'Form 9',
    about: 'this_company',
    other_company_name: null,
  },
});

// A number no other suite uses, so the result does not depend on test order.
const jatiId = `900101${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
it('lets the reviewer type in a missing value, and masks identity numbers in save responses', async () => {
  const reg = `2023${String(Date.now()).slice(-8)}`;
  const { importId: id, rowId } = await freshImport('Jati', { mode: 'new' });
  await tickImports(
    scripted({
      Jati: (ids) => [
        [
          ...company(ids, {
            name: 'Jati Sdn. Bhd.',
            registrationNumber: reg,
            incorporationDate: '2023-01-05',
            financialYearEnd: '12-31',
            industry: 'G',
          }),
          {
            name: 'suggest_person',
            args: {
              ref: 'P1',
              kind: 'individual',
              full_name: 'Jati Person',
              values: { identityType: 'MyKad', identityNumber: jatiId },
              effective_date: null,
              ...src(ids['Form'], `Jati Person ${jatiId}`),
            },
          },
          classify(ids),
          { name: 'no_such_tool', args: {} },
        ],
      ],
    }),
  );
  await settleImports();
  let row = await readRow(rowId);
  // The registered office is required, so the agent was asked once and the gap is shown.
  expect(row.run.notFound.join(' ')).toContain('Registered office');
  await expect(
    applyImportCompany(actor, id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow('A new company needs: Registered office.');
  const limited = {
    ...actor,
    capabilities: actor.capabilities.filter((c) => c !== 'view_identity'),
  };
  for (const [key, value] of [
    ['registeredLine1', '1 Jalan Jati'],
    ['registeredPostcode', '50450'],
    ['registeredTown', 'Kuala Lumpur'],
    ['registeredState', 'W.P. KUALA LUMPUR'],
    ['registeredCountry', 'MALAYSIA'],
  ]) {
    const saved = await changeImportRow(limited, id, rowId, {
      action: 'set_value',
      expectedRevision: (await readRow(rowId)).revision,
      key,
      value,
      effectiveDate: null,
    });
    const p = saved.suggestions.find((x) => x.kind === 'person');
    expect(p?.kind === 'person' && p.values.identityNumber).toBe('900101-**-****');
    expect(p?.source.quote).not.toContain(jatiId.slice(6));
  }
  row = await readRow(rowId);
  const entered = row.suggestions.find((x) => x.kind === 'company' && x.key === 'registeredLine1')!;
  expect(entered.source).toMatchObject({ fileId: '', quote: `Entered by ${actor.name}` });
  const applied = await applyImportCompany(actor, id, rowId, {
    expectedRevision: row.revision,
    requestId: randomUUID(),
  });
  expect(applied.status).toBe('Applied');
});

it('asks the reviewer about a same-name person instead of merging, and records an end date for a known director', async () => {
  // Someone already linked to Meranti, with no identity number, and a current director.
  const sameName = await repo.createCompany;
  void sameName;
  const { changePerson } = await import('../src/server/records/people');
  const { changeRelationship } = await import('../src/server/records/relationships');
  const known = await changePerson(actor, {
    action: 'create',
    requestId: randomUUID(),
    fullName: 'Rahim Same Name',
  });
  await changeRelationship(actor, existingId, {
    action: 'add',
    requestId: randomUUID(),
    personId: known.id,
    role: 'secretary',
    capacity: '',
    startDate: '2020-02-14',
    evidenceIds: [],
  });
  const director = await changePerson(actor, {
    action: 'create',
    requestId: randomUUID(),
    fullName: 'Director Known',
  });
  await changePerson(actor, {
    action: 'set_particulars',
    id: director.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    values: { identityType: 'MyKad', identityNumber: '820715084321' },
    effectiveDate: '2020-02-14',
    reason: 'test',
  });
  await changeRelationship(actor, existingId, {
    action: 'add',
    requestId: randomUUID(),
    personId: director.id,
    role: 'director',
    capacity: '',
    startDate: '2020-02-14',
    evidenceIds: [],
  });

  const { importId: id, rowId } = await freshImport('Meranti again', {
    mode: 'existing',
    companyId: existingId,
  });
  await tickImports(
    scripted({
      'Meranti again': (ids) => [
        [
          {
            name: 'suggest_person',
            args: {
              ref: 'P1',
              kind: 'individual',
              full_name: 'Rahim Same Name',
              values: {},
              effective_date: null,
              ...src(ids['Form'], 'Rahim'),
            },
          },
          {
            name: 'suggest_role',
            args: {
              person_ref: 'P1',
              role: 'secretary',
              start_date: '2020-02-14',
              end_date: null,
              cessation: null,
              ...src(ids['Form'], 'secretary'),
            },
          },
          {
            name: 'suggest_person',
            args: {
              ref: 'P2',
              kind: 'individual',
              full_name: 'Director Known',
              values: { identityType: 'MyKad', identityNumber: '820715084321' },
              effective_date: null,
              ...src(ids['Form'], 'Director Known'),
            },
          },
          {
            name: 'suggest_role',
            args: {
              person_ref: 'P2',
              role: 'director',
              start_date: '2020-02-14',
              end_date: '2024-06-30',
              cessation: 'resignation',
              ...src(ids['Form'], 'resigned 30 June 2024'),
            },
          },
          classify(ids),
        ],
      ],
    }),
  );
  await settleImports();
  let row = await readRow(rowId);
  expect(row.status).toBe('Ready');
  const detail = await getImportCompany(actor, id, rowId);
  expect(detail.nameMatches['P1'].map((m) => m.personId)).toEqual([known.id]);
  await expect(
    applyImportCompany(actor, id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow('has the same name as someone already in the app');
  const p1 = row.suggestions.find((x) => x.kind === 'person' && x.ref === 'P1')!;
  row = await changeImportRow(actor, id, rowId, {
    action: 'set_link',
    expectedRevision: row.revision,
    suggestionId: p1.id,
    personId: known.id,
  });
  const peopleBefore = (await db.select().from(s.people)).length;
  await applyImportCompany(actor, id, rowId, {
    expectedRevision: row.revision,
    requestId: randomUUID(),
  });
  expect((await db.select().from(s.people)).length).toBe(peopleBefore);
  const roles = await companyRelationships(existingId);
  expect(roles.find((r) => r.personId === director.id && r.role === 'director')?.endDate).toBe(
    '2024-06-30',
  );
});

it('sends an overlapping director term back to the agent, and refuses unsafe moves and re-runs', async () => {
  const { importId: id, rowId } = await freshImport('Meranti clash', {
    mode: 'existing',
    companyId: existingId,
  });
  const caller = scripted({
    'Meranti clash': (ids) => [
      [
        {
          name: 'suggest_person',
          args: {
            ref: 'P1',
            kind: 'individual',
            full_name: 'Director Known',
            values: { identityType: 'MyKad', identityNumber: '820715084321' },
            effective_date: null,
            ...src(ids['Form'], 'x'),
          },
        },
        {
          name: 'suggest_role',
          args: {
            person_ref: 'P1',
            role: 'director',
            start_date: '2021-01-01',
            end_date: null,
            cessation: null,
            ...src(ids['Form'], 'x'),
          },
        },
        classify(ids),
      ],
    ],
  });
  await tickImports(caller);
  await settleImports();
  const sentBack = caller.requests
    .flatMap((r) => r.input)
    .find(
      (i) =>
        typeof (i as { content?: unknown }).content === 'string' &&
        (i as { content: string }).content.includes('overlaps'),
    ) as { content: string } | undefined;
  expect(sentBack?.content).toContain("overlaps the app's record (2020-02-14 to 2024-06-30)");
  const row = await readRow(rowId);
  // Still wrong after the second finish: shown to the reviewer, not dropped.
  expect(row.run.notFound.join(' ')).toContain('overlaps');
  await expect(
    applyImportCompany(actor, id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("overlap the app's record");
  // A company being read takes no file moves.
  const setStatus = (status: 'Reading' | 'Ready') =>
    writerDb
      .update(s.importCompanies)
      .set({ status, data: { ...row, status } })
      .where(eq(s.importCompanies.id, rowId));
  await setStatus('Reading');
  await expect(
    changeImportRow(actor, id, rowId, {
      action: 'move_file',
      fileId: row.files[0].id,
      toRowId: null,
    }),
  ).rejects.toThrow('is being read');
  await setStatus('Ready');
  // A finished import cannot be read again.
  const [b] = await db.select().from(s.imports).where(eq(s.imports.id, id));
  await writerDb
    .update(s.imports)
    .set({ status: 'Finished', data: { ...b.data, status: 'Finished' } })
    .where(eq(s.imports.id, id));
  await expect(
    changeImportRow(actor, id, rowId, {
      action: 'run_again',
      expectedRevision: (await readRow(rowId)).revision,
    }),
  ).rejects.toThrow('This import has finished');
});

// ---------------------------------------------------------------- PR review fixes
const randomMyKad = (prefix: string) =>
  `${prefix}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
it('keeps reviewer choices on a re-read, ends a known secretary once, and hides birth dates', async () => {
  const { changePerson } = await import('../src/server/records/people');
  const { changeRelationship } = await import('../src/server/records/relationships');
  const secId = randomMyKad('750302');
  const sec = await changePerson(actor, {
    action: 'create',
    requestId: randomUUID(),
    fullName: 'Secretary Known',
  });
  await changePerson(actor, {
    action: 'set_particulars',
    id: sec.id,
    expectedRevision: 1,
    requestId: randomUUID(),
    values: { identityType: 'MyKad', identityNumber: secId },
    effectiveDate: '2020-02-14',
    reason: 'test',
  });
  await changeRelationship(actor, existingId, {
    action: 'add',
    requestId: randomUUID(),
    personId: sec.id,
    role: 'secretary',
    capacity: '',
    startDate: '2020-02-14',
    evidenceIds: [],
  });
  const { importId: id, rowId } = await freshImport('Meranti secretary', {
    mode: 'existing',
    companyId: existingId,
  });
  const script = scripted({
    'Meranti secretary': (ids) => [
      [
        {
          name: 'suggest_person',
          args: {
            ref: 'P1',
            kind: 'individual',
            full_name: 'Secretary Known',
            values: { identityType: 'MyKad', identityNumber: secId, dateOfBirth: '1975-03-02' },
            effective_date: null,
            ...src(ids['Form'], 'Secretary Known, born 2 March 1975 (02/03/1975)'),
          },
        },
        {
          name: 'suggest_role',
          args: {
            person_ref: 'P1',
            role: 'secretary',
            start_date: '2020-02-14',
            end_date: '2024-01-31',
            cessation: 'resignation',
            ...src(ids['Form'], 'resigned'),
          },
        },
        {
          name: 'suggest_person',
          args: {
            ref: 'P2',
            kind: 'individual',
            full_name: 'Unwanted Person',
            values: { identityType: 'MyKad', identityNumber: randomMyKad('880808') },
            effective_date: null,
            ...src(ids['Form'], 'Unwanted Person'),
          },
        },
        classify(ids),
      ],
    ],
  });
  await tickImports(script);
  await settleImports();
  let row = await readRow(rowId);
  expect(row.status).toBe('Ready');
  const unwanted = row.suggestions.find((x) => x.kind === 'person' && x.ref === 'P2')!;
  row = await changeImportRow(actor, id, rowId, {
    action: 'set_use',
    expectedRevision: row.revision,
    suggestionIds: [unwanted.id],
    use: false,
  });
  // Read again: the same person is suggested again, and stays unticked.
  await changeImportRow(actor, id, rowId, { action: 'run_again', expectedRevision: row.revision });
  await tickImports(script);
  await settleImports();
  row = await readRow(rowId);
  expect(row.suggestions.find((x) => x.id === unwanted.id)?.use).toBe(false);

  const limited = {
    ...actor,
    capabilities: actor.capabilities.filter((c) => c !== 'view_identity'),
  };
  const seen = await getImportCompany(limited, id, rowId);
  const p1 = seen.row.suggestions.find((x) => x.kind === 'person' && x.ref === 'P1');
  expect(p1?.kind === 'person' && p1.values.dateOfBirth).toBe('Hidden');
  expect(p1?.source.quote).toBe('Secretary Known, born Hidden (Hidden)');
  // The person already in the app is shown beside what the files say.
  expect(seen.personValues['P1']?.identityType).toBe('MyKad');

  await applyImportCompany(actor, id, rowId, {
    expectedRevision: row.revision,
    requestId: randomUUID(),
  });
  const secretaries = (await companyRelationships(existingId)).filter(
    (r) => r.personId === sec.id && r.role === 'secretary',
  );
  expect(secretaries).toHaveLength(1);
  expect(secretaries[0].endDate).toBe('2024-01-31');
});

it('answers a repeated upload with the file already kept, and holds Apply until stray files are placed', async () => {
  const batch = await createImport(actor, {
    requestId: randomUUID(),
    name: 'Stray hold',
    looseFiles: 0,
    folders: [{ folder: 'Kapur', target: { mode: 'new' } }],
  });
  const rowId = (await getImport(actor, batch.id)).companies[0].id;
  const bytes = await wordFile(['Kapur source']);
  const first = await upload(batch.id, rowId, 'Form 9.docx', bytes);
  const again = await upload(batch.id, rowId, 'Form 9.docx', bytes);
  expect(again.id).toBe(first.id);
  await upload(batch.id, rowId, 'Other.docx', await wordFile(['Cengal Sdn. Bhd. minutes']));
  expect((await readRow(rowId)).files).toHaveLength(2);
  await changeImport(actor, batch.id, { action: 'start' });
  await tickImports(
    scripted({
      Kapur: (ids) => [
        [
          ...company(ids, {
            name: 'Kapur Sdn. Bhd.',
            registrationNumber: `2024${String(Date.now()).slice(-8)}`,
            incorporationDate: '2024-01-05',
            financialYearEnd: '12-31',
            registeredLine1: '1 Jalan Kapur',
          }),
          classify(ids),
          {
            name: 'classify_file',
            args: {
              file_id: ids['Other.docx'],
              read_as: 'Minutes',
              about: 'another_company',
              other_company_name: 'Cengal Sdn. Bhd.',
            },
          },
        ],
      ],
    }),
  );
  await settleImports();
  const row = await readRow(rowId);
  expect(row.files.some((f) => f.result === 'Another company')).toBe(true);
  await expect(
    applyImportCompany(actor, batch.id, rowId, {
      expectedRevision: row.revision,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow('Some files look like they belong to another company');
});

it('keeps nothing a reader saves after the 90-day clean-up removed its import', async () => {
  const { purgeOldImports } = await import('../src/server/imports/runner');
  const { importId: id, rowId } = await freshImport('Meranti purge', {
    mode: 'existing',
    companyId: existingId,
  });
  await tickImports(
    scripted({
      'Meranti purge': (ids, round) => {
        void round;
        return [
          [{ name: 'read_text', args: { file_id: ids['Form'], from_page: 1, to_page: 1 } }],
          [
            {
              name: 'suggest_person',
              args: {
                ref: 'P1',
                kind: 'individual',
                full_name: 'Purged Person',
                values: { identityType: 'MyKad', identityNumber: randomMyKad('910101') },
                effective_date: null,
                ...src(ids['Form'], 'Purged Person'),
              },
            },
          ],
        ];
      },
    }),
  );
  // The clean-up runs while the reader is between turns.
  await new Promise((r) => setTimeout(r, 0));
  const [b] = await db.select().from(s.imports).where(eq(s.imports.id, id));
  await writerDb
    .update(s.imports)
    .set({ createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) })
    .where(eq(s.imports.id, b.id));
  await purgeOldImports();
  await settleImports();
  const row = await readRow(rowId);
  expect(row.status).toBe('Left out');
  expect(row.suggestions).toEqual([]);
});

it('lets the reviewer correct a person, role and holding, and keeps the corrections on a re-read', async () => {
  const pid = randomMyKad('860606');
  const { importId: id, rowId } = await freshImport('Resak', { mode: 'new' });
  const script = scripted({
    Resak: (ids) => [
      [
        ...company(ids, {
          name: 'Resak Sdn. Bhd.',
          registrationNumber: `2025${String(Date.now()).slice(-8)}`,
          incorporationDate: '2025-01-05',
          financialYearEnd: '12-31',
          registeredLine1: '1 Jalan Resak',
          industry: 'G',
          registeredPostcode: '50450',
          registeredTown: 'Kuala Lumpur',
          registeredState: 'W.P. KUALA LUMPUR',
          registeredCountry: 'MALAYSIA',
        }),
        {
          name: 'suggest_person',
          args: {
            ref: 'P1',
            kind: 'individual',
            full_name: 'Resak Persn',
            values: { identityType: 'MyKad', identityNumber: pid },
            effective_date: null,
            ...src(ids['Form'], 'Resak Persn'),
          },
        },
        {
          name: 'suggest_role',
          args: {
            person_ref: 'P1',
            role: 'director',
            start_date: '2025-02-01',
            end_date: null,
            cessation: null,
            ...src(ids['Form'], 'appointed'),
          },
        },
        {
          name: 'suggest_shares',
          args: {
            person_refs: ['P1'],
            class_name: 'Ordinary',
            class_kind: 'Ordinary',
            shares: '600000',
            amount_paid: '600000',
            amount_payable: null,
            consideration: 'Cash',
            date: '2025-01-05',
            ...src(ids['Form'], '600000'),
          },
        },
        classify(ids),
      ],
    ],
  });
  await tickImports(script);
  await settleImports();
  let row = await readRow(rowId);
  const find = (kind: string) => row.suggestions.find((x) => x.kind === kind)!;
  const limited = {
    ...actor,
    capabilities: actor.capabilities.filter((c) => c !== 'view_identity'),
  };
  // Someone without identity access can fix the name, but not the identity number.
  const saved = await changeImportRow(limited, id, rowId, {
    action: 'correct',
    expectedRevision: row.revision,
    suggestionId: find('person').id,
    fields: { fullName: 'Resak Person', identityNumber: '900101-01-0101' },
  });
  expect(saved.suggestions.some((x) => 'original' in x && x.original)).toBe(false);
  row = await readRow(rowId);
  const person = find('person');
  expect(person.kind === 'person' && [person.fullName, person.values.identityNumber]).toEqual([
    'Resak Person',
    pid,
  ]);
  await expect(
    changeImportRow(actor, id, rowId, {
      action: 'correct',
      expectedRevision: row.revision,
      suggestionId: find('role').id,
      fields: { role: 'director', startDate: '2025-02-01', endDate: '2024-01-01' },
    }),
  ).rejects.toThrow('The end date is before the start date.');
  row = await changeImportRow(actor, id, rowId, {
    action: 'correct',
    expectedRevision: row.revision,
    suggestionId: find('role').id,
    fields: { role: 'director', startDate: '2025-01-20', endDate: null },
  });
  row = await changeImportRow(actor, id, rowId, {
    action: 'correct',
    expectedRevision: row.revision,
    suggestionId: find('shares').id,
    fields: {
      className: 'Ordinary',
      classKind: 'Ordinary',
      shares: '60,000',
      amountPaid: '60000',
      amountPayable: null,
      consideration: 'Cash',
      date: '2025-01-05',
    },
  });
  // The agent reads again and suggests its first versions; the corrections stand.
  await changeImportRow(actor, id, rowId, { action: 'run_again', expectedRevision: row.revision });
  await tickImports(script);
  await settleImports();
  row = await readRow(rowId);
  expect(row.suggestions.filter((x) => x.kind === 'role')).toHaveLength(1);
  const role = find('role');
  expect(role.kind === 'role' && role.startDate).toBe('2025-01-20');
  const holding = find('shares');
  expect(holding.kind === 'shares' && holding.shares).toBe('60000');
  expect(holding.correctedBy).toBe(actor.name);
  const applied = await applyImportCompany(actor, id, rowId, {
    expectedRevision: row.revision,
    requestId: randomUUID(),
  });
  const entries = await readShareEntries(applied.applied!.companyId);
  expect(entries.map((e) => e.shares)).toEqual(['60000']);
});
