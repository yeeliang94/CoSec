import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { prior, remember, requestKey } from '../repository';
import { auditChange } from '../resolution/shared';
import { appendCustomValue } from './custom-fields';
import { personUnavailable, visiblePeople, visiblePersonIds } from './scope';
import { queryAudit } from './audit';
import { assertCapability, assertCompany, DomainError, today } from '../../domain/access';
import type { Actor } from '../../domain/model';
import {
  PARTICULAR_KEYS,
  type CompanyRelationship,
  type DatedValue,
  type OtherDirectorship,
  type ParticularKey,
  type Person,
  type PersonKind,
} from '../../domain/resolution/model';
import {
  IDENTITY_KEYS,
  maskIdentity,
  normaliseIdentity,
  particularLabel,
  particularsAt,
  validateParticulars,
} from '../../domain/resolution/particulars';
import { valueAt } from '../../domain/resolution/records';
import { IssuesError } from '../../domain/resolution/validate';

const SEARCH_LIMIT = 200;
const MAX_OTHER_DIRECTORSHIPS = 50;
/** Audit paths recorded as changed without their values (identity particulars). */
const IDENTITY_AUDIT_PATHS = IDENTITY_KEYS.map((key) => `particulars.${key}`);

/**
 * The person as this actor may see it. Without `view_identity`, every dated identity number is
 * masked and dates of birth and passport expiry dates are blanked. Use it for every read that
 * reaches the browser; generated documents print the stored values.
 */
export function personForActor<T extends Person>(actor: Actor, person: T): T {
  // An organisation's registration number is public record, so only individuals are masked.
  if (
    actor.capabilities.includes('view_identity') ||
    !person.particulars ||
    person.kind === 'organisation'
  )
    return person;
  const particulars = { ...person.particulars };
  const hide = (key: ParticularKey, change: (v: DatedValue['value']) => DatedValue['value']) => {
    const list = particulars[key];
    if (list) particulars[key] = list.map((entry) => ({ ...entry, value: change(entry.value) }));
  };
  hide('identityNumber', (v) => (typeof v === 'string' && v ? maskIdentity(v) : v));
  hide('dateOfBirth', () => null);
  hide('passportExpiry', () => null);
  return { ...person, particulars };
}
/**
 * Person audits compare records that both hold `particulars`, so the diff reaches each
 * particular's own path and the identity redaction applies even on a row saved before D1.
 */
const auditable = (person: Person) => ({ ...person, particulars: person.particulars ?? {} });

/** Relationships of the given people, limited to the actor's companies. */
async function scopedRelationships(actor: Actor, personIds: string[], tx?: Transaction) {
  if (!personIds.length || !actor.companyIds.length) return [];
  return (
    await (tx ?? db)
      .select({ data: s.companyRelationships.data })
      .from(s.companyRelationships)
      .where(
        and(
          inArray(s.companyRelationships.personId, personIds),
          inArray(s.companyRelationships.companyId, actor.companyIds),
        ),
      )
  ).map((r) => r.data);
}
/** Every company the person is linked to, including ones outside the actor's access. */
async function linkedCompanyIds(personId: string, tx: Transaction) {
  const rows = await tx
    .selectDistinct({ companyId: s.companyRelationships.companyId })
    .from(s.companyRelationships)
    .where(eq(s.companyRelationships.personId, personId));
  return rows.map((r) => r.companyId).sort();
}

/** Most people one `ids` lookup may name. */
export const MAX_PEOPLE_IDS = 500;

/**
 * People search: a plain read (projections are refreshed when director events post). The first
 * `SEARCH_LIMIT` matches by name are returned; `truncated` says more matched. `kind` keeps only
 * individuals or organisations. `ids` returns exactly those of the given people the actor may see
 * (up to `MAX_PEOPLE_IDS`, never truncated), for screens that need names for known ids.
 */
export async function listPeople(
  actor: Actor,
  options: { q?: string; companyId?: string; kind?: PersonKind; ids?: string[] },
) {
  if (options.companyId) assertCompany(actor, options.companyId);
  if (options.ids && options.ids.length > MAX_PEOPLE_IDS)
    throw new DomainError(`Ask for up to ${MAX_PEOPLE_IDS} people at once.`);
  const { ids, truncated } = await visiblePeople(actor, {
    ...options,
    ids: options.ids ? [...new Set(options.ids)] : undefined,
    limit: options.ids ? MAX_PEOPLE_IDS : SEARCH_LIMIT,
  });
  if (!ids.length) return { people: [], truncated };
  const [rows, relationships] = await Promise.all([
    db.select().from(s.people).where(inArray(s.people.id, ids)),
    scopedRelationships(actor, ids),
  ]);
  const people = rows
    .map((r) => ({
      ...personForActor(actor, r.data),
      relationships: relationships.filter((rel) => rel.personId === r.id),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
  return { people, truncated };
}

export async function getPerson(actor: Actor, id: string) {
  if (!(await visiblePersonIds(actor, { ids: [id] })).length) throw personUnavailable();
  const [row] = await db.select().from(s.people).where(eq(s.people.id, id));
  if (!row) throw personUnavailable();
  const relationships: CompanyRelationship[] = await scopedRelationships(actor, [id]);
  const audit = actor.capabilities.includes('view_audit')
    ? (await queryAudit(actor, { entityType: 'person', entityId: id })).entries
    : [];
  return { person: personForActor(actor, row.data), relationships, audit };
}

export type PersonInput =
  | {
      action: 'create';
      requestId: string;
      kind?: PersonKind;
      fullName: string;
      email?: string | null;
      notes?: string;
    }
  | {
      action: 'update';
      id: string;
      expectedRevision: number;
      requestId: string;
      fullName?: string;
      email?: string | null;
      notes?: string;
      reason: string;
    }
  | {
      action: 'set_custom';
      id: string;
      expectedRevision: number;
      requestId: string;
      definitionId: string;
      value: unknown;
      effectiveDate: string;
      reason: string;
    }
  | {
      action: 'set_particulars';
      id: string;
      expectedRevision: number;
      requestId: string;
      values: Partial<Record<ParticularKey, string | null>>;
      effectiveDate: string;
      reason: string;
    }
  | {
      action: 'set_other_directorships';
      id: string;
      expectedRevision: number;
      requestId: string;
      directorships: {
        id?: string;
        companyName: string;
        appointedOn: string | null;
        ceasedOn: string | null;
      }[];
      reason: string;
    };

const AUDIT_ACTIONS: Record<Exclude<PersonInput['action'], 'create'>, string> = {
  update: 'person.updated',
  set_custom: 'person.custom_set',
  set_particulars: 'person.particulars_set',
  set_other_directorships: 'person.other_directorships_set',
};

/**
 * Appends a dated value for each particular that differs from the one in force on the effective
 * date, then checks the particulars as they would stand on that date. Warnings do not block.
 */
function appendParticulars(
  actor: Actor,
  before: Person,
  input: Extract<PersonInput, { action: 'set_particulars' }>,
): NonNullable<Person['particulars']> {
  const particulars = { ...(before.particulars ?? {}) };
  const reason = input.reason.trim();
  const recordedAt = new Date().toISOString();
  const proposed: Partial<Record<ParticularKey, string | null>> = particularsAt(
    before,
    input.effectiveDate,
  );
  for (const key of PARTICULAR_KEYS) {
    if (!Object.hasOwn(input.values, key)) continue;
    const raw = input.values[key];
    const trimmed = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    const type = Object.hasOwn(input.values, 'identityType')
      ? input.values.identityType
      : valueAt(particulars.identityType, input.effectiveDate);
    const value =
      trimmed && key === 'identityNumber'
        ? normaliseIdentity(typeof type === 'string' ? type : null, trimmed)
        : trimmed;
    // A screen without view_identity shows masked numbers; never store one of those.
    if (
      key === 'identityNumber' &&
      value?.includes('*') &&
      !actor.capabilities.includes('view_identity')
    )
      throw new DomainError('Enter the full identity number, not the masked one.');
    const current = valueAt(particulars[key], input.effectiveDate);
    if ((typeof current === 'string' && current ? current : null) === value) continue;
    proposed[key] = value;
    particulars[key] = [
      ...(particulars[key] ?? []),
      { value, effectiveDate: input.effectiveDate, recordedAt, actorId: actor.id, reason },
    ];
  }
  const kind = before.kind ?? 'individual';
  const errors = validateParticulars(proposed, kind).filter((i) => i.severity === 'error');
  if (errors.length)
    throw new IssuesError(
      'Check the particulars.',
      errors.map((i) => ({
        message: i.message,
        location: particularLabel(i.key, kind),
        fieldId: i.key,
      })),
      'VALIDATION',
    );
  return particulars;
}

function otherDirectorships(
  input: Extract<PersonInput, { action: 'set_other_directorships' }>,
): OtherDirectorship[] {
  if (input.directorships.length > MAX_OTHER_DIRECTORSHIPS)
    throw new DomainError(`Record up to ${MAX_OTHER_DIRECTORSHIPS} other directorships.`);
  const seen = new Set<string>();
  return input.directorships.map((d) => {
    const companyName = d.companyName.trim();
    if (!companyName) throw new DomainError('Enter the company name for each directorship.');
    if (d.appointedOn && d.ceasedOn && d.ceasedOn < d.appointedOn)
      throw new DomainError(`${companyName}: the cessation date is before the appointment date.`);
    let id = d.id || randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    return { id, companyName, appointedOn: d.appointedOn || null, ceasedOn: d.ceasedOn || null };
  });
}

export async function changePerson(actor: Actor, input: PersonInput): Promise<Person> {
  assertCapability(actor, 'manage_people');
  if (input.action === 'create') {
    const key = requestKey(actor, 'person:create', input.requestId);
    return transaction(async (tx) => {
      const old = await prior(tx, key);
      if (old) {
        // A replay returns current data, so it needs the same access as a normal read.
        const [row] = await tx.select().from(s.people).where(eq(s.people.id, old.id));
        if (!row || !(await visiblePersonIds(actor, { ids: [old.id] }, tx)).length)
          throw personUnavailable();
        return personForActor(actor, row.data);
      }
      const now = new Date().toISOString();
      const person: Person = {
        id: randomUUID(),
        ...(input.kind === 'organisation' ? { kind: 'organisation' as const } : {}),
        fullName: input.fullName.trim(),
        nameHistory: [],
        email: input.email?.trim() || null,
        notes: input.notes?.trim() ?? '',
        customValues: {},
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      await tx
        .insert(s.people)
        .values({ id: person.id, fullName: person.fullName, revision: 1, data: person });
      // Unlinked people are firm-level until a relationship links them to a company.
      await auditChange(tx, actor, {
        companyId: null,
        scopeCompanyIds: [],
        entityType: 'person',
        entityId: person.id,
        action: 'person.created',
        before: null,
        after: person,
        requestId: input.requestId,
      });
      await remember(tx, key, { id: person.id, revision: 1 });
      return person;
    });
  }
  const key = requestKey(actor, `person:${input.id}`, input.requestId);
  return transaction(async (tx) => {
    const [row] = await tx.select().from(s.people).where(eq(s.people.id, input.id));
    if (!row || !(await visiblePersonIds(actor, { ids: [input.id] }, tx)).length)
      throw personUnavailable();
    if (await prior(tx, key)) return personForActor(actor, row.data);
    if (row.revision !== input.expectedRevision)
      throw new DomainError('This person changed. Refresh and try again.', 'STALE', 409);
    const companies = await linkedCompanyIds(input.id, tx);
    // Shared identity feeds every linked company's future outputs, so only someone who can act
    // for all of them may change it.
    if (companies.some((c) => !actor.companyIds.includes(c)))
      throw new DomainError('You cannot change this shared identity.', 'FORBIDDEN', 403);
    const before = row.data;
    const next = structuredClone(before);
    if (input.action === 'update') {
      const fullName = input.fullName?.trim();
      if (fullName !== undefined && fullName !== before.fullName) {
        next.nameHistory.push({
          name: before.fullName,
          until: today(),
          actorId: actor.id,
          reason: input.reason.trim(),
        });
        next.fullName = fullName;
      }
      if (input.email !== undefined) next.email = input.email?.trim() || null;
      if (input.notes !== undefined) next.notes = input.notes.trim();
    } else if (input.action === 'set_custom')
      next.customValues = await appendCustomValue(actor, before.customValues, input, 'person', tx);
    else if (input.action === 'set_particulars')
      next.particulars = appendParticulars(actor, before, input);
    else next.otherDirectorships = otherDirectorships(input);
    if (JSON.stringify(next) === JSON.stringify(before))
      throw new DomainError('No change to save.');
    next.revision = before.revision + 1;
    next.updatedAt = new Date().toISOString();
    await tx
      .update(s.people)
      .set({ fullName: next.fullName, revision: next.revision, data: next })
      .where(eq(s.people.id, next.id));
    await auditChange(
      tx,
      actor,
      {
        companyId: null,
        scopeCompanyIds: companies,
        entityType: 'person',
        entityId: next.id,
        action: AUDIT_ACTIONS[input.action],
        before: auditable(before),
        after: auditable(next),
        reason: input.reason,
        requestId: input.requestId,
        detail: { fromRevision: before.revision, toRevision: next.revision },
      },
      IDENTITY_AUDIT_PATHS,
    );
    await remember(tx, key, { id: next.id, revision: next.revision });
    return personForActor(actor, next);
  });
}
