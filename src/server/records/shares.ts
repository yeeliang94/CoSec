import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { prior, remember, requestKey } from '../repository';
import { auditChange } from '../resolution/shared';
import { assertAny, assertPersonVisible, companyEvidence, lockCompany, systemActor } from './scope';
import { readProfile } from './profile';
import { assertCompany, DomainError } from '../../domain/access';
import type { Actor } from '../../domain/model';
import type { CompanyRelationship } from '../../domain/resolution/model';
import { maskIdentity } from '../../domain/resolution/particulars';
import {
  effectiveEntries,
  memberIntervalSources,
  replay,
  SHARE_KINDS,
  validateShareEntry,
  type Holder,
  type ShareClass,
  type ShareEntry,
  type ShareEntryKind,
} from '../../domain/ar1/shares';

export async function readShareEntries(companyId: string, tx?: Transaction) {
  return (
    await (tx ?? db).select().from(s.shareEntries).where(eq(s.shareEntries.companyId, companyId))
  ).map((r) => r.data);
}

export async function listShares(actor: Actor, companyId: string) {
  assertCompany(actor, companyId);
  const [entries, profile] = await Promise.all([
    readShareEntries(companyId),
    readProfile(companyId),
  ]);
  return {
    classes: profile.shareClasses ?? [],
    profileRevision: profile.revision,
    entries: entries
      .sort((a, b) => a.date.localeCompare(b.date) || a.preparedAt.localeCompare(b.preparedAt))
      .map((entry) => entryForActor(actor, entry)),
  };
}

// ---------------------------------------------------------------- trustee identity numbers
/** Audit paths recorded as changed without their values: the trust subject's ID number. */
const TRUSTEE_ID_PATHS = ['from.trustee.subjectIdNumber', 'to.trustee.subjectIdNumber'];
const REDACTED = '[redacted]';

const mapTrusteeId = (holder: Holder | null, change: (value: string) => string): Holder | null =>
  holder?.trustee?.subjectIdNumber
    ? {
        ...holder,
        trustee: { ...holder.trustee, subjectIdNumber: change(holder.trustee.subjectIdNumber) },
      }
    : holder;
const mapTrusteeIds = (entry: ShareEntry, change: (value: string) => string): ShareEntry => ({
  ...entry,
  from: mapTrusteeId(entry.from, change),
  to: mapTrusteeId(entry.to, change),
});

/**
 * The entry as this actor may see it: without `view_identity`, the ID number of the person a
 * trustee holds for is masked, as on a person's own record. Generated returns use stored values.
 */
export function entryForActor(actor: Actor, entry: ShareEntry): ShareEntry {
  if (actor.capabilities.includes('view_identity')) return entry;
  return mapTrusteeIds(entry, maskIdentity);
}
/**
 * The entry as written to the audit log. A new entry's audit diff is one whole value, which path
 * redaction cannot reach, so the ID number is replaced before the diff as well.
 */
const auditableEntry = (entry: ShareEntry | null) =>
  entry ? mapTrusteeIds(entry, () => REDACTED) : null;

/**
 * A screen without `view_identity` shows masked trustee ID numbers. A correction that sends back
 * the masked number of the entry it corrects keeps the stored number; any other masked number is
 * refused, so a masked value is never stored.
 */
function unmaskTrusteeIds(actor: Actor, fields: EntryFields, predecessor: ShareEntry | null) {
  const restore = (holder: Holder | null, side: 'from' | 'to'): Holder | null => {
    const value = holder?.trustee?.subjectIdNumber;
    if (!value?.includes('*') || actor.capabilities.includes('view_identity')) return holder;
    const stored = predecessor?.[side]?.trustee?.subjectIdNumber;
    if (stored && maskIdentity(stored) === value)
      return { ...holder!, trustee: { ...holder!.trustee!, subjectIdNumber: stored } };
    throw new DomainError('Enter the full identity number, not the masked one.');
  };
  return { ...fields, from: restore(fields.from, 'from'), to: restore(fields.to, 'to') };
}

type EntryFields = {
  kind: ShareEntryKind;
  date: string;
  classId: string;
  shares: string;
  from: Holder | null;
  to: Holder | null;
  amountPayable: string | null;
  amountPaid: string | null;
  consideration: ShareEntry['consideration'];
  sourceDocumentId: string | null;
  sourceCaseId: string | null;
  note: string;
};
export type ShareEntryInput =
  | ({ action: 'record'; requestId: string } & EntryFields)
  | ({ action: 'correct'; requestId: string; id: string; voids: boolean } & EntryFields)
  | { action: 'post'; requestId: string; id: string; expectedRevision: number }
  | { action: 'withdraw'; requestId: string; id: string; expectedRevision: number; reason: string };

async function checkFields(
  actor: Actor,
  companyId: string,
  fields: EntryFields,
  classes: ShareClass[],
  tx: Transaction,
) {
  const problems = validateShareEntry(
    fields,
    classes.map((c) => c.id),
  );
  if (problems.length) throw new DomainError(problems[0]);
  // Any person the actor may see can be named, as relationship add allows, so an existing person
  // can join this company by allotment or transfer. Readers of this company see only party ids.
  for (const partyId of new Set([fields.from, fields.to].flatMap((h) => h?.partyIds ?? [])))
    await assertPersonVisible(actor, partyId, tx);
  await checkSources(actor, companyId, fields, tx);
}

/** The source document and resolution must belong to this company (checked for voids too). */
async function checkSources(
  actor: Actor,
  companyId: string,
  fields: Pick<EntryFields, 'sourceDocumentId' | 'sourceCaseId'>,
  tx: Transaction,
) {
  if (fields.sourceDocumentId)
    await companyEvidence(actor, companyId, [fields.sourceDocumentId], tx);
  if (fields.sourceCaseId) {
    const [row] = await tx
      .select({ companyId: s.resolutionCases.companyId })
      .from(s.resolutionCases)
      .where(eq(s.resolutionCases.id, fields.sourceCaseId));
    if (row?.companyId !== companyId)
      throw new DomainError('The source resolution must belong to this company.');
  }
}

const holderOf = (h: Holder | null): Holder | null =>
  h
    ? {
        partyIds: [...h.partyIds],
        ...(h.trustee
          ? { trustee: { ...h.trustee, subjectName: h.trustee.subjectName.trim() } }
          : {}),
      }
    : null;

/**
 * Share register entries follow the officer-event controls: a preparer records a draft, someone
 * else reviews and posts it, and a posted entry is never edited. A correction is a new draft that
 * replaces (or voids) a posted entry once it is posted. Posting is refused if any holding would
 * fall below zero on any date. Member relationships are projected from posted holdings.
 */
export async function changeShareEntry(actor: Actor, companyId: string, input: ShareEntryInput) {
  assertCompany(actor, companyId);
  assertAny(actor, ['confirm_record', 'manage_people']);
  const key = requestKey(actor, `shares:${companyId}`, input.requestId);
  return transaction(async (tx) => {
    await lockCompany(companyId, tx);
    const old = await prior(tx, key);
    if (old) {
      const [row] = await tx.select().from(s.shareEntries).where(eq(s.shareEntries.id, old.id));
      return entryForActor(actor, row.data);
    }
    const profile = await readProfile(companyId, tx);
    const classes = profile.shareClasses ?? [];
    const now = new Date().toISOString();
    if (input.action === 'record' || input.action === 'correct') {
      let predecessor: ShareEntry | null = null;
      if (input.action === 'correct') {
        const [row] = await tx.select().from(s.shareEntries).where(eq(s.shareEntries.id, input.id));
        if (!row || row.companyId !== companyId)
          throw new DomainError('Share entry not found.', 'NOT_FOUND', 404);
        if (row.data.status !== 'Posted')
          throw new DomainError('Only a posted entry can be corrected.');
        predecessor = row.data;
      }
      const voids = input.action === 'correct' && input.voids;
      const fields: EntryFields = voids
        ? { ...predecessor!, from: predecessor!.from, to: predecessor!.to }
        : unmaskTrusteeIds(actor, input, predecessor);
      // A void repeats the posted entry's fields, but its sources are new, so they are checked.
      if (voids) await checkSources(actor, companyId, input, tx);
      else await checkFields(actor, companyId, fields, classes, tx);
      const entry: ShareEntry = {
        id: randomUUID(),
        companyId,
        kind: fields.kind,
        date: fields.date,
        classId: fields.classId,
        shares: fields.shares,
        from: holderOf(
          fields.kind === 'transfer' || fields.kind === 'buyback' ? fields.from : null,
        ),
        to: holderOf(fields.kind === 'buyback' ? null : fields.to),
        amountPayable:
          fields.kind === 'opening' || fields.kind === 'allotment' ? fields.amountPayable : null,
        amountPaid:
          fields.kind === 'opening' || fields.kind === 'allotment' ? fields.amountPaid : null,
        consideration:
          fields.kind === 'opening' || fields.kind === 'allotment' ? fields.consideration : null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        sourceCaseId: input.sourceCaseId ?? null,
        note: input.note.trim(),
        status: 'Draft',
        predecessorId: predecessor?.id ?? null,
        voids,
        preparedBy: actor.id,
        preparedAt: now,
        reviewerId: null,
        postedAt: null,
        revision: 1,
      };
      await tx.insert(s.shareEntries).values({
        id: entry.id,
        companyId,
        status: entry.status,
        revision: 1,
        data: entry,
      });
      await auditChange(
        tx,
        actor,
        {
          companyId,
          entityType: 'share_entry',
          entityId: entry.id,
          action: predecessor ? 'share_entry.correction_recorded' : 'share_entry.recorded',
          before: null,
          after: auditableEntry(entry),
          requestId: input.requestId,
          detail: predecessor ? { correcting: predecessor.id } : undefined,
        },
        TRUSTEE_ID_PATHS,
      );
      await remember(tx, key, { id: entry.id, revision: 1 });
      return entryForActor(actor, entry);
    }
    const [row] = await tx.select().from(s.shareEntries).where(eq(s.shareEntries.id, input.id));
    if (!row || row.companyId !== companyId)
      throw new DomainError('Share entry not found.', 'NOT_FOUND', 404);
    if (row.revision !== input.expectedRevision)
      throw new DomainError('This entry changed. Refresh and try again.', 'STALE', 409);
    const before = row.data;
    if (before.status !== 'Draft') throw new DomainError('Only a draft entry can be changed.');
    const next: ShareEntry = { ...structuredClone(before), revision: before.revision + 1 };
    if (input.action === 'withdraw') {
      next.status = 'Withdrawn';
    } else {
      if (before.preparedBy === actor.id)
        throw new DomainError(
          'Someone other than the preparer must review and post this entry.',
          'SELF_APPROVAL',
          403,
        );
      if (!before.voids && !before.sourceDocumentId && !before.sourceCaseId)
        throw new DomainError(
          'Link the resolution or document this entry comes from before posting.',
        );
      next.status = 'Posted';
      next.reviewerId = actor.id;
      next.postedAt = new Date().toISOString();
      const all = await readShareEntries(companyId, tx);
      // The replaced entry stays in the list as superseded, so the correction takes its place in
      // the replay order (see effectiveEntries).
      const proposed = all
        .filter((e) => e.id !== before.id)
        .map((e) => (e.id === before.predecessorId ? { ...e, status: 'Superseded' as const } : e))
        .concat([next]);
      const { problems } = replay(proposed);
      if (problems.length)
        throw new DomainError(
          `Posting this would leave a holder with fewer than zero shares on ${problems[0].date}.`,
        );
      if (before.predecessorId) {
        const [pred] = await tx
          .select()
          .from(s.shareEntries)
          .where(eq(s.shareEntries.id, before.predecessorId));
        if (pred?.data.status !== 'Posted')
          throw new DomainError('The entry this corrects is no longer posted.');
        const superseded = {
          ...pred.data,
          status: 'Superseded' as const,
          revision: pred.revision + 1,
        };
        await tx
          .update(s.shareEntries)
          .set({ status: superseded.status, revision: superseded.revision, data: superseded })
          .where(eq(s.shareEntries.id, pred.id));
      }
    }
    await tx
      .update(s.shareEntries)
      .set({ status: next.status, revision: next.revision, data: next })
      .where(eq(s.shareEntries.id, next.id));
    await auditChange(
      tx,
      actor,
      {
        companyId,
        entityType: 'share_entry',
        entityId: next.id,
        action: input.action === 'post' ? 'share_entry.posted' : 'share_entry.withdrawn',
        before: auditableEntry(before),
        after: auditableEntry(next),
        reason: input.action === 'withdraw' ? input.reason : null,
        requestId: input.requestId,
        detail: { fromRevision: before.revision, toRevision: next.revision },
      },
      TRUSTEE_ID_PATHS,
    );
    if (input.action === 'post') await syncMemberProjection(companyId, tx);
    await remember(tx, key, { id: next.id, revision: next.revision });
    return entryForActor(actor, next);
  });
}

/** Deterministic id, so re-running the projection updates rather than duplicates. */
const memberRelationshipId = (companyId: string, partyId: string, startDate: string) =>
  'member-' +
  createHash('sha256').update(`${companyId}|${partyId}|${startDate}`).digest('hex').slice(0, 32);

/**
 * Brings member relationships in line with posted holdings, in the posting transaction. Projected
 * members follow the register's intervals, each citing only the entries that opened or closed it.
 * Once the register has entries in effect it is the record of membership, so a member entered by
 * hand or carried over (not projected) that is still in effect on the register's first date is
 * ended on that date and marked, keeping its own end date; rows that ended before it are left
 * alone. A marked row follows the register: re-ended when the first date moves, restored to its
 * own end date when the register no longer covers it (for example every entry voided).
 */
export async function syncMemberProjection(companyId: string, tx: Transaction) {
  const entries = await readShareEntries(companyId, tx);
  const intervals = memberIntervalSources(entries);
  const registerStart = effectiveEntries(entries)[0]?.date ?? null;
  const members = (
    await tx
      .select()
      .from(s.companyRelationships)
      .where(
        and(
          eq(s.companyRelationships.companyId, companyId),
          eq(s.companyRelationships.role, 'member'),
        ),
      )
  ).map((r) => r.data);
  const isProjected = (r: CompanyRelationship) =>
    Boolean(r.projectedFrom && 'shareEntryIds' in r.projectedFrom);
  const existing = members.filter(isProjected);
  for (const before of members) {
    if (isProjected(before)) continue;
    // Only rows the register ended are ever changed back; others keep their own end date.
    const original = before.supersededByRegister
      ? before.supersededByRegister.originalEndDate
      : before.endDate;
    const covered = Boolean(registerStart && (!original || original > registerStart));
    if (!covered && !before.supersededByRegister) continue;
    const { supersededByRegister: _mark, ...rest } = before;
    const next: CompanyRelationship = covered
      ? {
          ...rest,
          // The end date is the first day the row is no longer in effect, never before its start.
          endDate:
            before.startDate && before.startDate > registerStart!
              ? before.startDate
              : registerStart,
          supersededByRegister: { originalEndDate: original },
          revision: before.revision + 1,
        }
      : { ...rest, endDate: original, revision: before.revision + 1 };
    if (
      next.endDate === before.endDate &&
      JSON.stringify(next.supersededByRegister) === JSON.stringify(before.supersededByRegister)
    )
      continue;
    await tx
      .update(s.companyRelationships)
      .set({ revision: next.revision, data: next })
      .where(eq(s.companyRelationships.id, before.id));
    await auditChange(tx, systemActor, {
      companyId,
      entityType: 'company_relationship',
      entityId: before.id,
      action: covered ? 'relationship.ended' : 'relationship.restored',
      before,
      after: next,
      reason: covered
        ? 'Superseded by the share register'
        : 'Share register no longer covers this member',
      detail: { source: 'share_register' },
    });
  }
  const wanted = new Map(
    intervals.map((i) => [memberRelationshipId(companyId, i.partyId, i.startDate), i]),
  );
  const now = new Date().toISOString();
  for (const relationship of existing) {
    if (wanted.has(relationship.id)) continue;
    await tx.delete(s.companyRelationships).where(eq(s.companyRelationships.id, relationship.id));
    await auditChange(tx, systemActor, {
      companyId,
      entityType: 'company_relationship',
      entityId: relationship.id,
      action: 'relationship.projection_removed',
      before: relationship,
      after: null,
      detail: { source: 'share_register' },
    });
  }
  const current = new Map(existing.map((r) => [r.id, r]));
  for (const [id, interval] of wanted) {
    const before = current.get(id);
    const projectedFrom = { shareEntryIds: interval.entryIds };
    if (before) {
      if (
        before.endDate === interval.endDate &&
        JSON.stringify(before.projectedFrom) === JSON.stringify(projectedFrom)
      )
        continue;
      const next = {
        ...before,
        endDate: interval.endDate,
        projectedFrom,
        revision: before.revision + 1,
      };
      await tx
        .update(s.companyRelationships)
        .set({ revision: next.revision, data: next })
        .where(eq(s.companyRelationships.id, id));
      await auditChange(tx, systemActor, {
        companyId,
        entityType: 'company_relationship',
        entityId: id,
        action: 'relationship.projected',
        before,
        after: next,
        detail: { source: 'share_register' },
      });
      continue;
    }
    const relationship: CompanyRelationship = {
      id,
      companyId,
      personId: interval.partyId,
      role: 'member',
      capacity: '',
      startDate: interval.startDate,
      endDate: interval.endDate,
      projectedFrom,
      evidenceIds: [],
      createdBy: systemActor.id,
      createdAt: now,
      revision: 1,
    };
    await tx.insert(s.companyRelationships).values({
      id,
      companyId,
      personId: interval.partyId,
      role: 'member',
      revision: 1,
      data: relationship,
    });
    await auditChange(tx, systemActor, {
      companyId,
      entityType: 'company_relationship',
      entityId: id,
      action: 'relationship.projected',
      before: null,
      after: relationship,
      detail: { source: 'share_register' },
    });
  }
}

/** Share classes on the profile; a class used by any entry cannot be removed or change kind. */
export function checkShareClasses(next: ShareClass[], before: ShareClass[], entries: ShareEntry[]) {
  if (next.length > 20) throw new DomainError('Record up to 20 share classes.');
  const names = new Set<string>();
  // Register entries point at a class by id, so two classes with one id would share a balance.
  const ids = new Set<string>();
  for (const c of next) {
    if (ids.has(c.id)) throw new DomainError('Two share classes have the same reference.');
    ids.add(c.id);
    if (!c.name.trim()) throw new DomainError('Name every share class.');
    if (!(SHARE_KINDS as readonly string[]).includes(c.kind))
      throw new DomainError('Choose ordinary, preference or other for every class.');
    const name = c.name.trim().toUpperCase();
    if (names.has(name)) throw new DomainError(`There are two classes called ${c.name}.`);
    names.add(name);
  }
  const used = new Set(entries.filter((e) => e.status !== 'Withdrawn').map((e) => e.classId));
  for (const old of before) {
    const now = next.find((c) => c.id === old.id);
    if (used.has(old.id) && !now)
      throw new DomainError(`${old.name} has register entries, so it cannot be removed.`);
    if (used.has(old.id) && now && now.kind !== old.kind)
      throw new DomainError(`${old.name} has register entries, so its kind cannot change.`);
  }
}

export async function memberPartyIds(companyId: string, tx?: Transaction) {
  const rows = await (tx ?? db)
    .select({ personId: s.companyRelationships.personId })
    .from(s.companyRelationships)
    .where(
      and(
        eq(s.companyRelationships.companyId, companyId),
        inArray(s.companyRelationships.role, ['member']),
      ),
    );
  return [...new Set(rows.map((r) => r.personId))];
}
