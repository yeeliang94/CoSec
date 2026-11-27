import { randomUUID } from 'node:crypto';
import { DomainError, today } from '../../domain/access';
import type { Actor } from '../../domain/model';
import {
  openQuestions,
  type ImportCompany,
  type ImportFile,
  type Question,
  type Source,
  type Suggestion,
  byReviewer,
} from '../../domain/imports';
import { getActorById } from '../repository';
import {
  checkCharge,
  checkCompanyValue,
  checkPersonValues,
  checkShares,
  isCoreKey,
  missingToCreate,
  fieldCatalogue,
  isDate,
} from './fields';
import { GatewayError, type GatewayConfig, type ModelCaller, type ModelItem } from './gateway';
import { MAX_VIEW_PAGES, openFile, pageParts, ReadError, type Opened } from './readers';
import {
  batchStatus,
  currentRecord,
  findByIdentity,
  heartbeat,
  readImportBytes,
  readRow,
  releaseClaim,
  saveRow,
  tokensUsedToday,
  updateRow,
} from './store';
import { db, transaction } from '../db';
import * as s from '../schema';
import { eq } from 'drizzle-orm';

/**
 * One agent reads one company folder. Its tools are tied to that folder and that company, so it
 * can only read those files and only suggest values for that company. The app checks every value
 * as it is suggested and returns any problem, so the agent can correct it.
 */

const INSTRUCTIONS = `You read one company's files for a Malaysian company secretarial firm and suggest values for that company's records. You only suggest: a person reviews every value before anything is saved.

Principles:
- Work only on this company. If a file is plainly about a different company, classify it as another_company and do not use it.
- Look over the file list first, then read in the order you judge best: usually the latest annual return and registers first, then older forms for dates and history.
- Every value needs its source: the file, the page, and a short exact quote from that page.
- The latest dated document wins for current values. Use older documents for dates and history, such as when a director was appointed or resigned.
- Never guess. Never invent an identity number, date, address or share count. If a value cannot be found, leave it out and list it in finish.
- Use the exact field keys and allowed values from the field list. When a tool returns a problem, correct the value and try again, or leave it out.
- Give each person a short ref such as P1 and reuse it for their roles and shares. One person keeps one ref across all files.
- Suggest each member's shareholding per class as at the latest register or return date, with the amounts paid and payable and whether it was for cash.
- Write dates as YYYY-MM-DD. Malaysian documents usually write DD/MM/YYYY.
- Ask a question only when the files disagree in a way the dates cannot settle, or when a fact the record needs is missing and a person may know it. Ask at most three. Give each choice its evidence and mark the one you suggest.
- Classify every file you open. When you are done, call finish.`;

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const source = {
  file_id: { ...str, description: 'Id of the file the value comes from' },
  page: { type: ['integer', 'null'], description: 'Page number, or null for a one-page file' },
  quote: { ...str, description: 'Short exact quote from that page' },
};
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});
export const TOOLS = [
  tool(
    'read_text',
    'Read the text of pages of a file in this folder.',
    { file_id: str, from_page: { type: 'integer' }, to_page: { type: 'integer' } },
    ['file_id', 'from_page', 'to_page'],
  ),
  tool(
    'view_pages',
    `Look at pages of a scanned PDF or a photo, up to ${MAX_VIEW_PAGES} pages at a time. The pages arrive in the next message.`,
    { file_id: str, from_page: { type: 'integer' }, to_page: { type: 'integer' } },
    ['file_id', 'from_page', 'to_page'],
  ),
  tool(
    'classify_file',
    'Record what a file is and whether it is about this company.',
    {
      file_id: str,
      read_as: { ...str, description: 'What the file is, for example "Annual return 2024"' },
      about: { type: 'string', enum: ['this_company', 'another_company', 'not_a_record'] },
      other_company_name: nstr,
    },
    ['file_id', 'read_as', 'about', 'other_company_name'],
  ),
  tool(
    'suggest_company_value',
    'Suggest one company field value. A later suggestion for the same key replaces the earlier one.',
    {
      key: str,
      value: str,
      effective_date: {
        ...nstr,
        description: 'Date the value applies from: normally the source document date',
      },
      ...source,
    },
    ['key', 'value', 'effective_date', 'file_id', 'page', 'quote'],
  ),
  tool(
    'suggest_person',
    'Suggest a person or organisation and their particulars. Using the same ref again updates that person.',
    {
      ref: str,
      kind: { type: 'string', enum: ['individual', 'organisation'] },
      full_name: str,
      values: {
        type: 'object',
        description: 'Person field keys to values',
        additionalProperties: { type: 'string' },
      },
      effective_date: nstr,
      ...source,
    },
    ['ref', 'kind', 'full_name', 'values', 'effective_date', 'file_id', 'page', 'quote'],
  ),
  tool(
    'suggest_role',
    'Suggest a role a person holds or held in this company.',
    {
      person_ref: str,
      role: { type: 'string', enum: ['director', 'secretary', 'manager', 'auditor', 'other'] },
      start_date: nstr,
      end_date: nstr,
      cessation: {
        type: ['string', 'null'],
        enum: ['resignation', 'removal', 'other_cessation', null],
      },
      ...source,
    },
    ['person_ref', 'role', 'start_date', 'end_date', 'cessation', 'file_id', 'page', 'quote'],
  ),
  tool(
    'suggest_shares',
    'Suggest a shareholding as at a date. Joint holders share one holding.',
    {
      person_refs: { type: 'array', items: str },
      class_name: { ...str, description: 'For example "Ordinary"' },
      class_kind: { type: 'string', enum: ['Ordinary', 'Preference', 'Other'] },
      shares: str,
      amount_payable: {
        ...nstr,
        description: 'Total payable in MYR; null when it equals the amount paid',
      },
      amount_paid: { ...nstr, description: 'Total paid in MYR, or null if the files do not say' },
      consideration: { type: ['string', 'null'], enum: ['Cash', 'Otherwise than cash', null] },
      date: str,
      ...source,
    },
    [
      'person_refs',
      'class_name',
      'class_kind',
      'shares',
      'amount_payable',
      'amount_paid',
      'consideration',
      'date',
      'file_id',
      'page',
      'quote',
    ],
  ),
  tool(
    'suggest_charge',
    'Suggest a registered charge.',
    {
      registered_number: str,
      registered_on: str,
      nature: str,
      chargee: str,
      amount: str,
      discharged_on: nstr,
      ...source,
    },
    [
      'registered_number',
      'registered_on',
      'nature',
      'chargee',
      'amount',
      'discharged_on',
      'file_id',
      'page',
      'quote',
    ],
  ),
  tool(
    'remove_suggestion',
    'Withdraw one of your suggestions by its id.',
    { id: str, reason: str },
    ['id', 'reason'],
  ),
  tool(
    'ask_question',
    'Ask the reviewer one question. Use sparingly.',
    {
      text: str,
      choices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: str,
            file_id: nstr,
            page: { type: ['integer', 'null'] },
            quote: nstr,
          },
          required: ['label', 'file_id', 'page', 'quote'],
          additionalProperties: false,
        },
      },
      suggested_choice: { type: ['integer', 'null'] },
    },
    ['text', 'choices', 'suggested_choice'],
  ),
  tool(
    'finish',
    'Finish this company.',
    {
      summary: str,
      not_found: { type: 'array', items: str, description: 'Fields or facts you could not find' },
    },
    ['summary', 'not_found'],
  ),
];

type Args = Record<string, unknown>;
const text = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const orNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

type Context = {
  row: ImportCompany;
  actor: Actor;
  opened: Map<string, Opened>;
  existing: boolean;
  current: Record<string, string> | null;
  /** Pages to attach after this turn's tool outputs. */
  attachments: { role: 'user'; content: unknown[] }[];
  finished: { summary: string; notFound: string[] } | null;
};

async function open(ctx: Context, file: ImportFile) {
  const cached = ctx.opened.get(file.id);
  if (cached) return cached;
  const opened = await openFile(
    file.kind,
    file.name,
    await readImportBytes(ctx.row.importId, file),
  );
  ctx.opened.set(file.id, opened);
  return opened;
}

function fileOf(ctx: Context, id: unknown) {
  const file = ctx.row.files.find((f) => f.id === id);
  if (!file || file.leftOut) throw new ToolProblem('That file id is not in this company folder.');
  if (file.result === 'Could not read')
    throw new ToolProblem(`That file could not be read: ${file.note}.`);
  return file;
}
class ToolProblem extends Error {}
/** The row left Reading under the reader (the clean-up removed it); nothing more is saved. */
class ReaderStopped extends Error {}

function sourceOf(ctx: Context, args: Args): Source {
  const file = fileOf(ctx, args.file_id);
  const page = typeof args.page === 'number' ? args.page : null;
  if (page !== null && file.pages !== null && (page < 1 || page > file.pages))
    throw new ToolProblem(`That file has ${file.pages} pages.`);
  const quote = text(args.quote, 300);
  if (!quote) throw new ToolProblem('Give a short exact quote from the source page.');
  return { fileId: file.id, page, quote };
}
function dateOrProblem(value: string | null, label: string) {
  if (!isDate(value)) throw new ToolProblem(`Give the ${label} as YYYY-MM-DD.`);
  return value;
}
function replace(ctx: Context, sug: Suggestion, same: (s: Suggestion) => boolean) {
  // A suggestion the reviewer corrected is still recognised by what the agent first said.
  const before = ctx.row.suggestions.find(
    (s) => same(s) || (s.original !== undefined && same({ ...s, ...s.original } as Suggestion)),
  );
  // A value the reviewer typed in or corrected stands until they change it.
  if (before && byReviewer(before))
    return `Kept ${before.id}: the reviewer entered or corrected it themselves.`;
  if (before) {
    sug.id = before.id;
    // A value the reviewer unticked stays unticked, and their choice of person stays made.
    sug.use = sug.use && before.use;
    if (sug.kind === 'person' && before.kind === 'person' && before.linkTo !== undefined)
      sug.linkTo = before.linkTo;
  }
  ctx.row.suggestions = ctx.row.suggestions.filter((s) => !same(s)).concat(sug);
  return `Saved as ${sug.id}${before ? ', replacing the earlier suggestion' : ''}.`;
}
const newId = () => 'S' + randomUUID().slice(0, 8);

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
async function runTool(ctx: Context, name: string, args: Args): Promise<string> {
  if (!TOOL_NAMES.has(name)) throw new ToolProblem(`There is no tool called ${name}.`);
  if (name === 'read_text' || name === 'view_pages') {
    const file = fileOf(ctx, args.file_id);
    const opened = await open(ctx, file);
    const count = opened.pages.length;
    const from = Math.max(1, Number(args.from_page) || 1);
    let to = Math.min(count, Number(args.to_page) || from);
    if (from > count) throw new ToolProblem(`That file has ${count} pages.`);
    if (!ctx.row.run.read.includes(file.id)) ctx.row.run.read.push(file.id);
    if (name === 'view_pages') {
      if (file.kind !== 'pdf' && file.kind !== 'image')
        throw new ToolProblem('Only scanned PDFs and photos have pages to look at; use read_text.');
      to = Math.min(to, from + MAX_VIEW_PAGES - 1);
      const parts = await pageParts(
        file.kind,
        file.name,
        await readImportBytes(ctx.row.importId, file),
        from,
        to,
      );
      ctx.attachments.push({
        role: 'user',
        content: [
          { type: 'input_text', text: `${file.name} (${file.id}), pages ${from} to ${to}:` },
          ...parts,
        ],
      });
      return `Pages ${from} to ${to} of ${file.name} are attached in the next message.`;
    }
    let out = '';
    let p = from;
    for (; p <= to && out.length < 30_000; p++)
      out += `--- page ${p} ---\n${opened.visual[p - 1] ? '(This page is a scan. Use view_pages to look at it.)' : opened.pages[p - 1]}\n`;
    if (out.length > 30_000 || p <= to)
      return `${out.slice(0, 30_000)}\n(Stopped here to keep the reply short. Read on from page ${p - 1 < from ? from : p - 1}.)`;
    return out || '(No text on these pages.)';
  }
  if (name === 'classify_file') {
    const file = fileOf(ctx, args.file_id);
    file.readAs = text(args.read_as, 120);
    if (args.about === 'another_company') {
      file.result = 'Another company';
      file.otherCompany = text(args.other_company_name, 200) || 'another company';
      file.note = 'set aside for a person to check';
      // The reviewer's own corrections stay; the reviewer decides about them.
      ctx.row.suggestions = ctx.row.suggestions.filter(
        (s) => s.source.fileId !== file.id || byReviewer(s),
      );
      return 'Recorded. Do not use this file; a person will decide where it belongs.';
    }
    if (args.about === 'not_a_record') {
      file.result = 'Not used';
      file.note = 'not a company record';
      return 'Recorded.';
    }
    return 'Recorded.';
  }
  if (name === 'remove_suggestion') {
    const target = ctx.row.suggestions.find((s) => s.id === args.id);
    if (target && byReviewer(target))
      throw new ToolProblem(
        'The reviewer entered or corrected that suggestion; leave it as it is.',
      );
    const before = ctx.row.suggestions.length;
    ctx.row.suggestions = ctx.row.suggestions.filter((s) => s.id !== args.id);
    return before === ctx.row.suggestions.length ? 'No suggestion has that id.' : 'Removed.';
  }
  if (name === 'ask_question') {
    if (ctx.row.questions.filter((q) => !q.settled).length >= 3)
      throw new ToolProblem(
        'You have asked three questions. Decide from the evidence or leave the value out.',
      );
    const choices = Array.isArray(args.choices) ? (args.choices as Args[]) : [];
    if (choices.length < 2) throw new ToolProblem('Give at least two choices.');
    const question: Question = {
      id: 'Q' + randomUUID().slice(0, 8),
      text: text(args.text, 600),
      choices: choices.slice(0, 6).map((c) => ({
        label: text(c.label, 300),
        source: c.file_id ? sourceOf(ctx, c) : null,
      })),
      suggested:
        typeof args.suggested_choice === 'number' && choices[args.suggested_choice]
          ? args.suggested_choice
          : null,
      answer: null,
      settled: false,
    };
    ctx.row.questions.push(question);
    return `Asked as ${question.id}. Carry on with the rest; the answer comes later.`;
  }
  if (name === 'finish') {
    ctx.finished = {
      summary: text(args.summary, 2000),
      notFound: (Array.isArray(args.not_found) ? args.not_found : [])
        .map((v) => text(v, 200))
        .filter(Boolean),
    };
    return 'Finished.';
  }
  const src = sourceOf(ctx, args);
  const file = ctx.row.files.find((f) => f.id === src.fileId)!;
  if (file.result === 'Another company')
    throw new ToolProblem('That file is about another company.');
  if (name === 'suggest_company_value') {
    const key = text(args.key, 60);
    const checked = checkCompanyValue(key, text(args.value, 4000));
    if (checked.error) throw new ToolProblem(checked.error);
    const effectiveDate = dateOrProblem(orNull(args.effective_date), 'effective date');
    const current = ctx.current?.[key] ?? '';
    // A change to a value the app already holds starts unticked, so it is a deliberate choice.
    const fixed = ctx.existing && isCoreKey(key);
    const use = !ctx.existing || (!fixed && (!current || current === checked.value));
    const note =
      fixed && current !== checked.value
        ? ' The app keeps its own value for this field on an existing company; the difference is shown to the reviewer.'
        : '';
    return (
      replace(
        ctx,
        {
          id: newId(),
          kind: 'company',
          key,
          value: checked.value,
          effectiveDate,
          source: src,
          use,
        },
        (s) => s.kind === 'company' && s.key === key,
      ) + note
    );
  }
  if (name === 'suggest_person') {
    const ref = text(args.ref, 40);
    if (!ref) throw new ToolProblem('Give the person a ref such as P1.');
    const kind = args.kind === 'organisation' ? 'organisation' : 'individual';
    const fullName = text(args.full_name, 255);
    if (!fullName) throw new ToolProblem('Give the full name.');
    const raw = (args.values && typeof args.values === 'object' ? args.values : {}) as Record<
      string,
      string
    >;
    const before = ctx.row.suggestions.find((s) => s.kind === 'person' && s.ref === ref);
    const merged = { ...(before?.kind === 'person' ? before.values : {}), ...raw };
    const { values, errors } = checkPersonValues(kind, merged);
    if (errors.length) throw new ToolProblem(errors.join(' '));
    const dup = ctx.row.suggestions.find(
      (s) =>
        s.kind === 'person' &&
        s.ref !== ref &&
        values.identityNumber &&
        s.values.identityNumber === values.identityNumber,
    );
    if (dup && dup.kind === 'person')
      throw new ToolProblem(
        `${dup.ref} already has this identity number. Use ref ${dup.ref} for this person.`,
      );
    const effectiveDate = dateOrProblem(orNull(args.effective_date), 'effective date');
    let message = replace(
      ctx,
      {
        id: newId(),
        kind: 'person',
        ref,
        personKind: kind,
        fullName,
        values,
        effectiveDate,
        source: src,
        use: true,
      },
      (s) => s.kind === 'person' && s.ref === ref,
    );
    if (values.identityNumber) {
      const found = await findByIdentity(
        ctx.actor,
        values.identityType ?? null,
        values.identityNumber,
      );
      if (found.some((f) => f.visible))
        message += ` This identity number matches ${found.find((f) => f.visible)!.fullName}, already in the app; they will be linked rather than created again.`;
    }
    return message;
  }
  if (name === 'suggest_role') {
    const personRef = text(args.person_ref, 40);
    const role = text(args.role, 20) as 'director';
    if (!['director', 'secretary', 'manager', 'auditor', 'other'].includes(role))
      throw new ToolProblem(
        'Choose director, secretary, manager, auditor or other. Members come from suggest_shares.',
      );
    const startDate = dateOrProblem(orNull(args.start_date), 'start date');
    const endDate = dateOrProblem(orNull(args.end_date), 'end date');
    if (startDate && endDate && endDate < startDate)
      throw new ToolProblem('The end date is before the start date.');
    const cessation = ['resignation', 'removal', 'other_cessation'].includes(String(args.cessation))
      ? (args.cessation as 'resignation')
      : null;
    return replace(
      ctx,
      {
        id: newId(),
        kind: 'role',
        personRef,
        role,
        startDate,
        endDate,
        cessation: endDate ? (cessation ?? 'other_cessation') : null,
        source: src,
        use: true,
      },
      (s) =>
        s.kind === 'role' &&
        s.personRef === personRef &&
        s.role === role &&
        s.startDate === startDate,
    );
  }
  if (name === 'suggest_shares') {
    const personRefs = (Array.isArray(args.person_refs) ? args.person_refs : [])
      .map((r) => text(r, 40))
      .filter(Boolean);
    if (!personRefs.length) throw new ToolProblem('Name the holder by person ref.');
    const checked = checkShares({
      shares: text(args.shares, 30),
      amountPayable: orNull(args.amount_payable),
      amountPaid: orNull(args.amount_paid),
      date: text(args.date, 10),
    });
    const consideration = ['Cash', 'Otherwise than cash'].includes(String(args.consideration))
      ? (args.consideration as 'Cash')
      : null;
    if (checked.errors.length) throw new ToolProblem(checked.errors.join(' '));
    const className = text(args.class_name, 100) || 'Ordinary';
    const classKind = ['Ordinary', 'Preference', 'Other'].includes(String(args.class_kind))
      ? (args.class_kind as 'Ordinary')
      : 'Ordinary';
    const key = [...personRefs].sort().join('+');
    return replace(
      ctx,
      {
        id: newId(),
        kind: 'shares',
        personRefs,
        className,
        classKind,
        shares: checked.shares,
        amountPayable: checked.amountPayable,
        amountPaid: checked.amountPaid,
        consideration,
        date: text(args.date, 10),
        source: src,
        use: true,
      },
      (s) =>
        s.kind === 'shares' &&
        [...s.personRefs].sort().join('+') === key &&
        s.className === className,
    );
  }
  if (name === 'suggest_charge') {
    const { fields, errors } = checkCharge({
      registeredNumber: text(args.registered_number, 100),
      registeredOn: text(args.registered_on, 10),
      nature: text(args.nature, 500),
      chargee: text(args.chargee, 255),
      amount: text(args.amount, 30),
      dischargedOn: orNull(args.discharged_on),
    });
    if (errors.length) throw new ToolProblem(errors.join(' '));
    return replace(
      ctx,
      { id: newId(), kind: 'charge', ...fields, source: src, use: true },
      (s) =>
        s.kind === 'charge' &&
        s.registeredNumber.toUpperCase() === fields.registeredNumber.toUpperCase(),
    );
  }
  throw new ToolProblem(`There is no tool called ${name}.`);
}

/** The app's own checks once the agent finishes; problems go back to it for one more round. */
/** An existing director's terms, keyed by the person suggestion that matched them. */
export type KnownTerms = Map<string, { name: string; start: string | null; end: string | null }[]>;
const overlaps = (
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
) => (aStart ?? '') <= (bEnd ?? '9999') && (bStart ?? '') <= (aEnd ?? '9999');

export function appChecks(row: ImportCompany, existing: boolean, terms: KnownTerms = new Map()) {
  const problems: string[] = [];
  const refs = new Set(row.suggestions.flatMap((s) => (s.kind === 'person' ? [s.ref] : [])));
  for (const s of row.suggestions) {
    if (s.kind === 'role' && !refs.has(s.personRef))
      problems.push(
        `Role ${s.id} names ${s.personRef}, but there is no suggest_person for that ref.`,
      );
    if (s.kind === 'shares')
      for (const r of s.personRefs)
        if (!refs.has(r))
          problems.push(`Holding ${s.id} names ${r}, but there is no suggest_person for that ref.`);
  }
  const incorporated = row.suggestions.find(
    (s) => s.kind === 'company' && s.key === 'incorporationDate',
  );
  if (incorporated?.kind === 'company')
    for (const s of row.suggestions)
      if (s.kind === 'role' && s.startDate && s.startDate < incorporated.value)
        problems.push(`Role ${s.id} starts before the incorporation date ${incorporated.value}.`);
  // A suggested term must not clash with one the app already holds for the same person: the same
  // appointment is fine (Apply records any new end date), a different overlapping one is not.
  for (const s of row.suggestions) {
    if (s.kind !== 'role' || s.role !== 'director') continue;
    for (const t of terms.get(s.personRef) ?? [])
      if (t.start !== s.startDate && overlaps(t.start, t.end, s.startDate, s.endDate))
        problems.push(
          `Role ${s.id} for ${t.name} (${s.startDate ?? 'no start'} to ${s.endDate ?? 'now'}) overlaps the app's record (${t.start ?? 'no start'} to ${t.end ?? 'now'}). Ask the reviewer which is right with ask_question, or remove the suggestion.`,
        );
  }
  if (!existing) {
    const missing = missingToCreate(row.suggestions, false);
    if (missing.length)
      problems.push(
        `A new company needs ${missing.join(', ')}. Look again; if the files do not say, list them in finish.`,
      );
  }
  const unclassified = row.files.filter(
    (f) => !f.leftOut && row.run.read.includes(f.id) && !f.readAs,
  );
  if (unclassified.length)
    problems.push(`Classify the files you opened: ${unclassified.map((f) => f.id).join(', ')}.`);
  return problems;
}

function listing(row: ImportCompany, previews: Map<string, string>) {
  return row.files
    .filter((f) => !f.leftOut)
    .map((f) => {
      const head = `- ${f.id}: ${f.path} (${f.kind}${f.pages ? `, ${f.pages} pages` : ''})`;
      if (f.result === 'Could not read') return `${head}: could not be read (${f.note})`;
      if (row.run.done.includes(f.id)) return `${head}: already read as "${f.readAs}"`;
      const preview = previews.get(f.id);
      return preview === undefined
        ? head
        : `${head}\n  ${preview ? `starts: ${preview.replace(/\s+/g, ' ').slice(0, 500)}` : 'scanned: look at its pages'}`;
    })
    .join('\n');
}

function openingMessage(
  row: ImportCompany,
  current: Awaited<ReturnType<typeof currentRecord>> | null,
  previews: Map<string, string>,
) {
  const parts = [
    `Company folder: "${row.folder}".`,
    current
      ? `This folder is for an existing company. What the app holds today:\n${JSON.stringify({
          company: current.company,
          people: current.people.map((p) => ({
            name: p.fullName,
            identityNumber: p.identityNumber,
          })),
          roles: current.roles,
          shareClasses: current.shareClasses.map((c) => c.name),
          charges: current.charges,
        })}`
      : 'This folder is for a new company, not yet in the app.',
    fieldCatalogue(),
    `Files in this folder:\n${listing(row, previews)}`,
  ];
  if (row.suggestions.length)
    parts.push(
      `You already made these suggestions in an earlier session (ids in brackets):\n${row.suggestions
        .map((s) => `[${s.id}] ${JSON.stringify({ ...s, id: undefined, use: undefined })}`)
        .join('\n')}`,
    );
  const answered = row.questions.filter((q) => q.answer && !q.settled);
  if (answered.length)
    parts.push(
      `The reviewer answered your questions. Update or remove your suggestions to match, then call finish.\n${answered
        .map(
          (q) =>
            `${q.text}\nAnswer: ${q.answer!.choice !== null ? q.choices[q.answer!.choice].label : ''}${q.answer!.text ? ` (${q.answer!.text})` : ''}`,
        )
        .join('\n\n')}`,
    );
  return parts.join('\n\n');
}

export type RunOptions = {
  call: ModelCaller;
  config: Pick<
    GatewayConfig,
    'maxTurns' | 'maxMinutes' | 'maxTokensPerCompany' | 'dailyTokenLimit'
  >;
  owner: string;
  signal?: AbortSignal;
};

/**
 * Reads one claimed company folder to the end, a pause, or a limit. Progress is saved after
 * every turn, so a restart resumes from the saved suggestions rather than starting over.
 */
export async function runCompany(rowId: string, options: RunOptions) {
  const started = Date.now();
  let row = structuredClone(await readRow(rowId));
  const actor = await getActorById((await batchCreator(row.importId)) ?? '');
  if (!actor)
    return finishRow(rowId, options.owner, (r) =>
      fail(r, 'The person who started this import no longer has an account.'),
    );
  if (!actor.capabilities.includes('prepare_job'))
    return finishRow(rowId, options.owner, (r) =>
      fail(r, 'The person who started this import can no longer prepare records.'),
    );
  const existing = row.target.mode === 'existing';
  let current = null;
  try {
    current = existing
      ? await currentRecord(actor, (row.target as { companyId: string }).companyId)
      : null;
  } catch {
    return finishRow(rowId, options.owner, (r) =>
      fail(r, 'You no longer have access to this company.'),
    );
  }
  row.run.seen = current ? current.revisions : null;
  const ctx: Context = {
    row,
    actor,
    opened: new Map(),
    existing,
    current: current?.company ?? null,
    attachments: [],
    finished: null,
  };
  // Survey: open each waiting file once for its page count and first lines.
  const previews = new Map<string, string>();
  for (const file of row.files) {
    if (file.leftOut || file.result === 'Could not read' || row.run.done.includes(file.id))
      continue;
    try {
      const opened = await open(ctx, file);
      file.pages =
        file.kind === 'pdf' ? opened.pages.length : file.kind === 'image' ? 1 : opened.pages.length;
      previews.set(
        file.id,
        opened.visual.every(Boolean)
          ? ''
          : (opened.pages.find((p) => p.trim()) ?? '').slice(0, 600),
      );
    } catch (error) {
      // A file missing from storage or changed since upload is reported like an unreadable one.
      if (!(error instanceof ReadError) && !(error instanceof DomainError)) throw error;
      file.result = 'Could not read';
      file.note =
        error instanceof ReadError ? error.message : 'the stored copy is missing or has changed';
    }
  }
  row = await persist(ctx);
  // Limits count this run only, so answers or a re-run get a full budget.
  const startTurns = row.run.turns;
  const startTokens = row.run.inputTokens + row.run.outputTokens;

  const input: unknown[] = [{ role: 'user', content: openingMessage(row, current, previews) }];
  let sentBack = false;
  let nudged = false;
  const shownAt: number[] = [];
  try {
    for (;;) {
      if ((await batchStatus(row.importId)) !== 'Running')
        return finishRow(rowId, options.owner, (r) => {
          r.status = 'Waiting';
        });
      const limit =
        ctx.row.run.turns - startTurns >= options.config.maxTurns
          ? 'it reached the turn limit'
          : Date.now() - started > options.config.maxMinutes * 60_000
            ? 'it reached the time limit'
            : ctx.row.run.inputTokens + ctx.row.run.outputTokens - startTokens >=
                options.config.maxTokensPerCompany
              ? 'it reached the token limit for one company'
              : null;
      if (limit)
        return finishRow(rowId, options.owner, (r) =>
          fail(r, `Reading stopped because ${limit}. The suggestions so far are kept.`),
        );
      if ((await tokensUsedToday()) >= options.config.dailyTokenLimit)
        return finishRow(rowId, options.owner, (r) => {
          r.status = 'Waiting';
          r.run.error = 'The daily token limit was reached. Reading continues tomorrow.';
        });

      const reply = await options.call({
        instructions: INSTRUCTIONS,
        input,
        tools: TOOLS,
        signal: options.signal,
      });
      ctx.row.run.turns += 1;
      ctx.row.run.inputTokens += reply.usage.inputTokens;
      ctx.row.run.outputTokens += reply.usage.outputTokens;
      const day = today();
      ctx.row.run.usageByDay[day] =
        (ctx.row.run.usageByDay[day] ?? 0) + reply.usage.inputTokens + reply.usage.outputTokens;
      // Reasoning items are left out: with store=false the gateway cannot look them up again.
      const kept = reply.output.filter((item) => item.type !== 'reasoning');
      input.push(...kept);
      const calls = kept.filter(
        (item): item is ModelItem & { call_id: string; name: string; arguments: string } =>
          item.type === 'function_call',
      );
      for (const call of calls) {
        let output: string;
        try {
          output = await runTool(ctx, call.name, JSON.parse(call.arguments || '{}') as Args);
        } catch (error) {
          if (error instanceof ToolProblem || error instanceof ReadError)
            output = `Not saved: ${error.message}`;
          // A stored copy that has gone missing since an earlier read: tell the agent and go on.
          else if (error instanceof DomainError && error.code === 'STORAGE')
            output = `Not saved: ${error.message} Carry on without this file.`;
          else if (error instanceof SyntaxError)
            output = 'Not saved: the arguments were not valid JSON.';
          else throw error;
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output });
      }
      // Pages shown on earlier turns are replaced by a note, so they are not paid for again on
      // every later call; the agent can look at them again if it needs to.
      for (const at of shownAt.splice(0))
        input[at] = {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '(Pages shown earlier. Use view_pages again if you need them.)',
            },
          ],
        };
      for (const attachment of ctx.attachments.splice(0)) shownAt.push(input.push(attachment) - 1);
      await persist(ctx);
      await heartbeat(rowId, options.owner);

      const stopped = !calls.length && nudged;
      if (ctx.finished || stopped) {
        const problems = appChecks(ctx.row, existing, await knownTerms(ctx, current));
        if (problems.length && !sentBack) {
          sentBack = true;
          ctx.finished = null;
          input.push({
            role: 'user',
            content: `Before finishing, the app found these problems:\n- ${problems.join('\n- ')}\nFix them, then call finish again.`,
          });
          continue;
        }
        const done = ctx.finished ?? {
          summary: 'The agent stopped without calling finish.',
          notFound: [],
        };
        // Anything still wrong is shown to the reviewer rather than dropped.
        return finishRow(rowId, options.owner, (r) =>
          complete(r, done.summary, [...done.notFound, ...problems]),
        );
      }
      if (!calls.length) {
        nudged = true;
        input.push({
          role: 'user',
          content: 'Carry on with the tools. Call finish when you are done.',
        });
      }
    }
  } catch (error) {
    const message =
      error instanceof GatewayError
        ? error.message
        : 'Something went wrong while reading this company.';
    if (!(error instanceof GatewayError) && !(error instanceof ReaderStopped))
      console.error('Import run failed', error instanceof Error ? error.name : 'Unknown');
    await persist(ctx).catch(() => undefined);
    return finishRow(rowId, options.owner, (r) => {
      r.run.attempts += 1;
      // A dropped gateway is tried again later; after three tries the company needs a person.
      if (error instanceof GatewayError && error.retryable && r.run.attempts < 3) {
        r.status = 'Waiting';
        r.run.error = `${message} It will be tried again.`;
      } else fail(r, `${message} The suggestions so far are kept.`);
    });
  }
}

/** The app's director terms for each suggested person who is already in the app. */
async function knownTerms(
  ctx: Context,
  current: Awaited<ReturnType<typeof currentRecord>> | null,
): Promise<KnownTerms> {
  const out: KnownTerms = new Map();
  if (!current) return out;
  for (const s of ctx.row.suggestions) {
    if (s.kind !== 'person') continue;
    const ids = s.values.identityNumber
      ? (
          await findByIdentity(ctx.actor, s.values.identityType ?? null, s.values.identityNumber)
        ).flatMap((m) => (m.personId ? [m.personId] : []))
      : [];
    const terms = current.roles
      .filter((r) => r.role === 'director' && ids.includes(r.personId))
      .map((r) => ({ name: r.personName, start: r.startDate, end: r.endDate }));
    if (terms.length) out.set(s.ref, terms);
  }
  return out;
}

async function batchCreator(importId: string) {
  const [row] = await db
    .select({ createdBy: s.imports.createdBy })
    .from(s.imports)
    .where(eq(s.imports.id, importId));
  return row?.createdBy ?? null;
}

/** Saves the agent's working copy, keeping any change a person made meanwhile to file moves. */
async function persist(ctx: Context) {
  const saved = await updateRow(ctx.row.id, (latest) => {
    // Only the 90-day clean-up moves a row out of Reading while its reader works: stop, keep nothing.
    if (latest.status !== 'Reading') throw new ReaderStopped();
    const files = new Map(ctx.row.files.map((f) => [f.id, f]));
    // Files a person moved in or out while the agent worked follow the saved row.
    latest.files = latest.files.map((f) => files.get(f.id) ?? f);
    latest.suggestions = ctx.row.suggestions;
    latest.questions = mergeQuestions(latest.questions, ctx.row.questions);
    latest.run = ctx.row.run;
  });
  ctx.row = structuredClone(saved);
  return saved;
}
function mergeQuestions(latest: Question[], mine: Question[]) {
  const answers = new Map(latest.map((q) => [q.id, q]));
  return mine.map((q) =>
    answers.get(q.id)?.answer && !q.answer
      ? { ...q, answer: answers.get(q.id)!.answer, settled: false }
      : q,
  );
}

function complete(row: ImportCompany, summary: string, notFound: string[]) {
  row.run.summary = summary;
  row.run.notFound = notFound;
  row.run.finishedAt = new Date().toISOString();
  row.run.error = null;
  for (const q of row.questions) if (q.answer) q.settled = true;
  for (const f of row.files) {
    if (f.result !== 'Waiting' && f.result !== 'Used') continue;
    const used = row.suggestions.filter((s) => s.source.fileId === f.id).length;
    f.result = used ? 'Used' : 'Not used';
    f.note = used
      ? `${used} ${used === 1 ? 'value' : 'values'}`
      : f.note || 'nothing needed from it';
    if (!row.run.done.includes(f.id)) row.run.done.push(f.id);
  }
  const nameSug = row.suggestions.find((s) => s.kind === 'company' && s.key === 'name');
  const regSug = row.suggestions.find(
    (s) => s.kind === 'company' && s.key === 'registrationNumber',
  );
  if (row.target.mode === 'new') {
    if (nameSug?.kind === 'company') row.name = nameSug.value;
    if (regSug?.kind === 'company') row.registrationNumber = regSug.value;
  }
  row.status = openQuestions(row).length ? 'Needs answer' : 'Ready';
}
function fail(row: ImportCompany, message: string) {
  row.status = 'Could not finish';
  row.run.error = message;
  row.run.finishedAt = new Date().toISOString();
}
async function finishRow(rowId: string, owner: string, fn: (row: ImportCompany) => void) {
  return transaction(async (tx) => {
    const row = structuredClone(await readRow(rowId, tx));
    if (row.status !== 'Reading') {
      await releaseClaim(rowId, owner, tx);
      return row;
    }
    fn(row);
    const saved = await saveRow(tx, row);
    await releaseClaim(rowId, owner, tx);
    return saved;
  });
}
