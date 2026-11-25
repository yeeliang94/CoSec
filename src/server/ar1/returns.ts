import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, readSnapshot, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { prior, remember, requestKey } from '../repository';
import { auditChange } from '../resolution/shared';
import { assertAny, lockCompany } from '../records/scope';
import { readProfile } from '../records/profile';
import { readShareEntries } from '../records/shares';
import { readCharges } from '../records/charges';
import { personForActor } from '../records/people';
import { msicDescription } from './msic';
import { compareFilingInfo } from './filing-info';
import { assertCompany, DomainError, today } from '../../domain/access';
import type { Actor, Company } from '../../domain/model';
import type { CompanyRelationship, Person } from '../../domain/resolution/model';
import {
  buildReturn,
  maskAr1Data,
  type Ar1Data,
  type BuildInput,
  type OtherDirectorshipCell,
} from '../../domain/ar1/build';
import { effectiveEntries } from '../../domain/ar1/shares';
import {
  emptyAnswers,
  nextReturn,
  returnFor,
  type AnnualReturn,
  type Application,
  type ReturnAnswers,
  type SourceRevision,
} from '../../domain/ar1/returns';
import { APPLICATIONS } from '../../domain/ar1/mtool-lists';

async function readCompany(companyId: string, tx?: Transaction): Promise<Company> {
  const [row] = await (tx ?? db).select().from(s.companies).where(eq(s.companies.id, companyId));
  if (!row) throw new DomainError('Company access is unavailable.', 'NOT_FOUND', 404);
  return row.data;
}

export type ReturnRow = {
  companyId: string;
  companyName: string;
  registrationNumber: string;
  returnId: string | null;
  calendarYear: number;
  returnDate: string;
  dueDate: string;
  status: 'Not started' | 'Preparing' | 'Downloaded';
  preparedBy: string | null;
  downloadedAt: string | null;
};

/**
 * Every company's current return for the list: its started returns, plus, for a company with no
 * open return, the next one due (not started yet). Only the columns the list shows are read, not
 * each return's answers, blank and download history.
 */
export async function listReturns(
  actor: Actor,
  companyId?: string,
): Promise<{ returns: ReturnRow[] }> {
  const companyIds = companyId ? [companyId] : actor.companyIds;
  if (companyId) assertCompany(actor, companyId);
  if (!companyIds.length) return { returns: [] };
  const data = s.annualReturns.data;
  const [companies, records] = await Promise.all([
    db.select().from(s.companies).where(inArray(s.companies.id, companyIds)),
    db
      .select({
        id: s.annualReturns.id,
        companyId: s.annualReturns.companyId,
        returnDate: s.annualReturns.returnDate,
        status: s.annualReturns.status,
        calendarYear: sql<number>`json_extract(${data}, '$.calendarYear')`,
        dueDate: sql<string>`json_extract(${data}, '$.dueDate')`,
        createdBy: sql<string>`json_extract(${data}, '$.createdBy')`,
        downloadedAt: sql<string | null>`json_extract(${data}, '$.downloads[#-1].createdAt')`,
      })
      .from(s.annualReturns)
      .where(inArray(s.annualReturns.companyId, companyIds)),
  ]);
  const rows: ReturnRow[] = [];
  const now = today();
  for (const { data: company } of companies) {
    if (company.engagementStatus === 'Ended') continue;
    const own = records.filter((r) => r.companyId === company.id);
    for (const r of own)
      rows.push({
        companyId: company.id,
        companyName: company.name,
        registrationNumber: company.registrationNumber,
        returnId: r.id,
        calendarYear: Number(r.calendarYear),
        returnDate: r.returnDate,
        dueDate: r.dueDate,
        status: r.status as AnnualReturn['status'],
        preparedBy: r.createdBy,
        downloadedAt: r.downloadedAt ?? null,
      });
    const next = company.incorporationDate ? nextReturn(company.incorporationDate, now) : null;
    if (next && !own.some((r) => r.returnDate === next.returnDate))
      rows.push({
        companyId: company.id,
        companyName: company.name,
        registrationNumber: company.registrationNumber,
        returnId: null,
        calendarYear: next.calendarYear,
        returnDate: next.returnDate,
        dueDate: next.dueDate,
        status: 'Not started',
        preparedBy: null,
        downloadedAt: null,
      });
  }
  rows.sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.companyName.localeCompare(b.companyName),
  );
  return { returns: rows };
}

const sameName = (a: string, b: string) =>
  a.trim().replace(/\s+/g, ' ').toUpperCase() === b.trim().replace(/\s+/g, ' ').toUpperCase();
/**
 * A registration number typed with a hand-entered name, as "[202001000001] NAME" or
 * "NAME (202001000001)"; null when none is typed.
 */
export function typedRegistration(text: string): OtherDirectorshipCell | null {
  const leading = /^\s*\[([^\]]+)\]\s*(.+)$/.exec(text);
  if (leading) return { registrationNumber: leading[1].trim(), name: leading[2].trim() };
  const trailing = /^(.+?)\s*\((\d{12})\)\s*$/.exec(text);
  if (trailing) return { registrationNumber: trailing[2], name: trailing[1].trim() };
  return null;
}

/**
 * Other directorships in force on the return date, worded later as the AR1 column heads them:
 * "[Company registration number] Name of company".
 *
 * Decision (coordinator, 17 Nov 2026): the filing must not depend on who prepares it, so every
 * firm record is read here whatever the actor's company access. Directorships are public data at
 * SSM, and only the other company's registration number and name reach the return. Each
 * other-company relationship read, and its company, is listed in `sources`, so a change there
 * shows as a new download version. A hand-entered directorship (`otherDirectorships` on the
 * person) takes a registration number typed with the name, or that of a firm company with the
 * same name; without one the name alone is written and the build asks for the number.
 */
async function otherDirectorships(
  companyId: string,
  directorIds: string[],
  asAt: string,
  people: Map<string, Person>,
  tx: Transaction,
) {
  const out = new Map<string, OtherDirectorshipCell[]>();
  const sources: SourceRevision[] = [];
  if (!directorIds.length) return { out, sources };
  const inForce = (from: string | null, until: string | null) =>
    (!from || from <= asAt) && (!until || until > asAt);
  const current = (
    await tx
      .select()
      .from(s.companyRelationships)
      .where(
        and(
          inArray(s.companyRelationships.personId, directorIds),
          eq(s.companyRelationships.role, 'director'),
          ne(s.companyRelationships.companyId, companyId),
        ),
      )
  )
    .map((r) => r.data)
    .filter((r) => inForce(r.startDate, r.endDate));
  const handEntered = directorIds.flatMap((id) =>
    (people.get(id)?.otherDirectorships ?? [])
      .filter((d) => inForce(d.appointedOn, d.ceasedOn))
      .map((d) => ({ personId: id, text: d.companyName })),
  );
  // Matching a hand-entered name needs every firm company; otherwise only the related ones.
  const relatedIds = [...new Set(current.map((r) => r.companyId))];
  const companies = (
    handEntered.length
      ? await tx.select().from(s.companies)
      : relatedIds.length
        ? await tx.select().from(s.companies).where(inArray(s.companies.id, relatedIds))
        : []
  ).map((r) => r.data);
  const byId = new Map(companies.map((c) => [c.id, c]));
  const add = (personId: string, cell: OtherDirectorshipCell) => {
    const list = out.get(personId) ?? [];
    const duplicate = list.some(
      (d) =>
        (cell.registrationNumber && d.registrationNumber === cell.registrationNumber) ||
        (!cell.registrationNumber && sameName(d.name, cell.name)),
    );
    if (!duplicate) list.push(cell);
    out.set(personId, list);
  };
  for (const r of current) {
    const c = byId.get(r.companyId);
    if (!c) continue;
    add(r.personId, { registrationNumber: c.registrationNumber, name: c.name });
    sources.push({ kind: 'relationship', id: r.id, revision: r.revision });
    sources.push({ kind: 'company', id: c.id, revision: c.revision });
  }
  for (const { personId, text } of handEntered) {
    const typed = typedRegistration(text);
    const name = typed?.name ?? text.trim();
    const known = typed
      ? undefined
      : companies.find((c) => c.id !== companyId && sameName(c.name, name));
    // The matched company's number is written, so a change to it must make a new version.
    if (known) sources.push({ kind: 'company', id: known.id, revision: known.revision });
    add(personId, {
      registrationNumber: typed?.registrationNumber ?? known?.registrationNumber ?? '',
      name,
    });
  }
  return { out, sources };
}

/**
 * Everything `buildReturn` reads, with the revision of each source for the download snapshot.
 * Without `tx` every read comes from one read-only snapshot.
 *
 * People are read only where this company's records name them: its relationships, and the
 * holders in its posted share entries in effect (the entries the register replays; drafts and
 * withdrawn or replaced entries do not count). `_actor` stays for callers: the filing does not
 * depend on who prepares it.
 */
export async function loadBuildInput(
  _actor: Actor,
  record: AnnualReturn,
  tx?: Transaction,
): Promise<{ input: BuildInput; sources: SourceRevision[] }> {
  if (!tx) return readSnapshot((own) => readBuildInput(record, own));
  return readBuildInput(record, tx);
}

async function readBuildInput(
  record: AnnualReturn,
  tx: Transaction,
): Promise<{ input: BuildInput; sources: SourceRevision[] }> {
  const companyId = record.companyId;
  const [company, profile, relationshipRows, entries, charges] = await Promise.all([
    readCompany(companyId, tx),
    readProfile(companyId, tx),
    tx.select().from(s.companyRelationships).where(eq(s.companyRelationships.companyId, companyId)),
    readShareEntries(companyId, tx),
    readCharges(companyId, tx),
  ]);
  const relationships: CompanyRelationship[] = relationshipRows.map((r) => r.data);
  const partyIds = new Set(relationships.map((r) => r.personId));
  for (const e of effectiveEntries(entries))
    for (const h of [e.from, e.to]) for (const id of h?.partyIds ?? []) partyIds.add(id);
  const people = new Map(
    partyIds.size
      ? (
          await tx
            .select()
            .from(s.people)
            .where(inArray(s.people.id, [...partyIds]))
        ).map((r) => [r.id, r.data] as const)
      : [],
  );
  const directorIds = [
    ...new Set(relationships.filter((r) => r.role === 'director').map((r) => r.personId)),
  ];
  const elsewhere = await otherDirectorships(companyId, directorIds, record.returnDate, people, tx);
  const sources: SourceRevision[] = [
    { kind: 'company', id: company.id, revision: company.revision },
    { kind: 'company_profile', id: companyId, revision: profile.revision },
    ...[...people.values()].map((p) => ({ kind: 'person', id: p.id, revision: p.revision })),
    ...relationships.map((r) => ({ kind: 'relationship', id: r.id, revision: r.revision })),
    ...elsewhere.sources,
    ...entries.map((e) => ({ kind: 'share_entry', id: e.id, revision: e.revision })),
    ...charges.map((c) => ({ kind: 'charge', id: c.id, revision: c.revision })),
  ]
    .filter((x, i, all) => all.findIndex((y) => y.kind === x.kind && y.id === x.id) === i)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return {
    input: {
      company,
      profile,
      record,
      people,
      relationships,
      otherDirectorships: elsewhere.out,
      entries,
      charges,
    },
    sources,
  };
}

/** Everyone the built return shows: officers, members and joint holders. */
function shownPartyIds(data: Ar1Data) {
  return new Set([
    ...data.d.directors.map((r) => r.personId),
    ...data.d.managers.map((r) => r.personId),
    ...data.d.secretaries.map((r) => r.personId),
    ...data.d.auditors.map((r) => r.personId),
    ...data.e.members.flatMap((r) => r.partyIds),
    ...data.e.subclassification.flatMap((r) => r.partyIds),
  ]);
}

/**
 * The return as the actor may see it. Download sources keep other companies' relationship and
 * company ids (other directorships), which version reuse needs; staff who cannot open those
 * companies do not receive them. A relationship whose company cannot be found is dropped too.
 */
export async function returnForActor(
  actor: Actor,
  record: AnnualReturn,
  tx: Transaction | typeof db = db,
): Promise<AnnualReturn> {
  const sources = record.downloads.flatMap((d) => d.sources);
  const relationshipIds = [
    ...new Set(sources.filter((x) => x.kind === 'relationship').map((x) => x.id)),
  ];
  const companyOf = new Map(
    relationshipIds.length
      ? (
          await tx
            .select({ id: s.companyRelationships.id, companyId: s.companyRelationships.companyId })
            .from(s.companyRelationships)
            .where(inArray(s.companyRelationships.id, relationshipIds))
        ).map((r) => [r.id, r.companyId] as const)
      : [],
  );
  const visible = (companyId: string | undefined) =>
    !!companyId && (companyId === record.companyId || actor.companyIds.includes(companyId));
  const keep = (x: SourceRevision) =>
    x.kind === 'company'
      ? visible(x.id)
      : x.kind === 'relationship'
        ? visible(companyOf.get(x.id))
        : true;
  return {
    ...record,
    downloads: record.downloads.map((d) => ({ ...d, sources: d.sources.filter(keep) })),
  };
}

/** The return with its section values and issues, built from records as at the return date. */
export async function getReturn(actor: Actor, id: string) {
  const [row] = await db.select().from(s.annualReturns).where(eq(s.annualReturns.id, id));
  if (!row) throw new DomainError('Annual return not found.', 'NOT_FOUND', 404);
  assertCompany(actor, row.companyId);
  const record = row.data;
  const { input } = await loadBuildInput(actor, record);
  const built = buildReturn(input);
  for (const m of built.data.a.msic) m.description = msicDescription(m.code) ?? '';
  // Identity values reach the browser masked for staff without view_identity.
  const data = actor.capabilities.includes('view_identity') ? built.data : maskAr1Data(built.data);
  // Only people the return shows or this company's relationships name reach the browser.
  const shown = shownPartyIds(built.data);
  for (const r of input.relationships) shown.add(r.personId);
  return {
    record: await returnForActor(actor, record),
    company: input.company,
    people: [...input.people.values()]
      .filter((p) => shown.has(p.id))
      .map((p) => personForActor(actor, p)),
    relationships: input.relationships,
    data,
    issues: built.issues,
    filingCheck: record.blank ? compareFilingInfo(data.filingInfo, record.blank.filingInfo) : null,
  };
}

export type StartReturnInput = {
  requestId: string;
  companyId: string;
  calendarYear: number;
  application: Application;
  rectificationDeclaration: string;
  courtOrderReference: string;
};

export async function startReturn(actor: Actor, input: StartReturnInput) {
  assertCompany(actor, input.companyId);
  assertAny(actor, ['prepare_job', 'generate_documents']);
  if (!(APPLICATIONS as readonly string[]).includes(input.application))
    throw new DomainError('Choose the application of submission.');
  const key = requestKey(actor, `annual-return:${input.companyId}`, input.requestId);
  return transaction(async (tx) => {
    const company = await lockCompany(input.companyId, tx);
    const old = await prior(tx, key);
    if (old) {
      const [row] = await tx.select().from(s.annualReturns).where(eq(s.annualReturns.id, old.id));
      // By now the return may have downloads whose sources name other companies.
      return returnForActor(actor, row.data, tx);
    }
    const period = returnFor(company.incorporationDate, input.calendarYear);
    if (!period) throw new DomainError('There is no annual return for that year.');
    const [existing] = await tx
      .select({ id: s.annualReturns.id })
      .from(s.annualReturns)
      .where(
        and(
          eq(s.annualReturns.companyId, input.companyId),
          eq(s.annualReturns.returnDate, period.returnDate),
        ),
      );
    if (existing)
      throw new DomainError('This annual return has already been started.', 'CONFLICT', 409);
    const now = new Date().toISOString();
    const record: AnnualReturn = {
      id: randomUUID(),
      companyId: input.companyId,
      ...period,
      application: input.application,
      rectificationDeclaration: input.rectificationDeclaration.trim(),
      courtOrderReference: input.courtOrderReference.trim(),
      answers: emptyAnswers(),
      blank: null,
      downloads: [],
      status: 'Preparing',
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await tx.insert(s.annualReturns).values({
      id: record.id,
      companyId: record.companyId,
      returnDate: record.returnDate,
      status: record.status,
      revision: 1,
      data: record,
    });
    await auditChange(tx, actor, {
      companyId: record.companyId,
      entityType: 'annual_return',
      entityId: record.id,
      action: 'annual_return.started',
      before: null,
      after: record,
      requestId: input.requestId,
    });
    await remember(tx, key, { id: record.id, revision: 1 });
    return record;
  });
}

export type UpdateReturnInput = {
  requestId: string;
  expectedRevision: number;
  application?: Application;
  rectificationDeclaration?: string;
  courtOrderReference?: string;
  answers?: ReturnAnswers;
};

/** Saves the answers that belong to this return only. */
export async function updateReturn(actor: Actor, id: string, input: UpdateReturnInput) {
  const next = await changeReturn(
    actor,
    id,
    input.requestId,
    input.expectedRevision,
    'annual_return.answers_saved',
    (next) => {
      if (input.application) {
        if (!(APPLICATIONS as readonly string[]).includes(input.application))
          throw new DomainError('Choose the application of submission.');
        next.application = input.application;
      }
      if (input.rectificationDeclaration !== undefined)
        next.rectificationDeclaration = input.rectificationDeclaration.trim();
      if (input.courtOrderReference !== undefined)
        next.courtOrderReference = input.courtOrderReference.trim();
      if (input.answers) next.answers = input.answers;
    },
  );
  return returnForActor(actor, next);
}

/** Read, check the revision, change, write and audit one return under the company lock. */
export async function changeReturn(
  actor: Actor,
  id: string,
  requestId: string,
  expectedRevision: number,
  action: string,
  mutate: (next: AnnualReturn, tx: Transaction) => void | Promise<void>,
  detail?: Record<string, unknown>,
) {
  assertAny(actor, ['prepare_job', 'generate_documents']);
  const [found] = await db
    .select({ companyId: s.annualReturns.companyId })
    .from(s.annualReturns)
    .where(eq(s.annualReturns.id, id));
  if (!found) throw new DomainError('Annual return not found.', 'NOT_FOUND', 404);
  assertCompany(actor, found.companyId);
  const key = requestKey(actor, `annual-return:${id}`, requestId);
  return transaction(async (tx) => {
    await lockCompany(found.companyId, tx);
    const [row] = await tx.select().from(s.annualReturns).where(eq(s.annualReturns.id, id));
    if (await prior(tx, key)) return row.data;
    if (row.revision !== expectedRevision)
      throw new DomainError('This return changed. Refresh and try again.', 'STALE', 409);
    const before = row.data;
    const next = structuredClone(before);
    await mutate(next, tx);
    if (JSON.stringify(next) === JSON.stringify(before))
      throw new DomainError('No change to save.');
    next.revision = before.revision + 1;
    next.updatedAt = new Date().toISOString();
    await tx
      .update(s.annualReturns)
      .set({ status: next.status, revision: next.revision, data: next })
      .where(eq(s.annualReturns.id, id));
    await auditChange(tx, actor, {
      companyId: next.companyId,
      entityType: 'annual_return',
      entityId: id,
      action,
      before,
      after: next,
      requestId,
      detail: { fromRevision: before.revision, toRevision: next.revision, ...(detail ?? {}) },
    });
    await remember(tx, key, { id, revision: next.revision });
    return next;
  });
}
