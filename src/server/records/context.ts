import { and, eq, inArray } from 'drizzle-orm';
import { readSnapshot, type Transaction } from '../db';
import * as s from '../schema';
import { getSettings } from '../repository';
import { readCase } from '../resolution/shared';
import { readProfile } from './profile';
import { companyRelationships, directorsAsAt } from './relationships';
import { lockCompany, visiblePersonIds } from './scope';
import { assertCompany, DomainError, today } from '../../domain/access';
import type { Actor } from '../../domain/model';
import type {
  CitationKey,
  PersonSnapshot,
  RelationshipRole,
  ResolutionContext,
} from '../../domain/resolution/model';
import { CITATION_KEYS } from '../../domain/resolution/model';
import { isCalendarDate, resolveValues, valueAt } from '../../domain/resolution/records';
import { templateParticulars } from '../../domain/resolution/particulars';
import { formatLongDate } from '../../domain/resolution/values';

const roleLabel: Record<RelationshipRole, string> = {
  director: 'Director',
  member: 'Member',
  secretary: 'Secretary',
  manager: 'Manager',
  auditor: 'Auditor',
  other: '',
};
const PROPOSED_LIMIT = 1000;

/**
 * The authorised as-at record view a resolution template may bind to. Directors come from posted
 * officer events; members from the company's member relationships in effect on the as-at date. Without `tx` it opens its own
 * read-only snapshot so every read comes from one consistent state; with `tx` it reads in the caller's.
 */
export async function loadResolutionContext(
  actor: Actor,
  caseId: string,
  asAt: string,
  tx?: Transaction,
): Promise<ResolutionContext> {
  if (!isCalendarDate(asAt)) throw new DomainError('Choose a valid as-at date.');
  if (!tx) return readSnapshot((own) => readContext(actor, caseId, asAt, own, false));
  return readContext(actor, caseId, asAt, tx, true);
}

async function readContext(
  actor: Actor,
  caseId: string,
  asAt: string,
  tx: Transaction,
  callerHoldsLock: boolean,
): Promise<ResolutionContext> {
  const resolutionCase = await readCase(actor, caseId, tx);
  const companyId = resolutionCase.companyId;
  assertCompany(actor, companyId);
  const company = callerHoldsLock
    ? await lockCompany(companyId, tx)
    : (await tx.select().from(s.companies).where(eq(s.companies.id, companyId)))[0]?.data;
  if (!company) throw new DomainError('Company access is unavailable.', 'NOT_FOUND', 404);
  const profile = await readProfile(companyId, tx);
  const settings = await getSettings(tx);
  const relationships = await companyRelationships(companyId, tx);
  const directors = await directorsAsAt(companyId, asAt, tx, relationships);
  const inEffect = (r: (typeof relationships)[number]) =>
    !(r.startDate && r.startDate > asAt) && !(r.endDate && r.endDate <= asAt);

  const members = new Map<string, PersonSnapshot>();
  for (const r of relationships)
    if (r.role === 'member' && inEffect(r) && !members.has(r.personId))
      members.set(r.personId, {
        id: r.personId,
        name: r.personName,
        capacity: r.capacity || roleLabel.member,
        appointedOn: r.startDate,
        ceasedOn: r.endDate,
      });

  // Directors first so their snapshot (from events) wins over other roles of the same person.
  const companyPeople = new Map<string, PersonSnapshot>(directors.map((d) => [d.id, d]));
  for (const r of relationships) {
    if (companyPeople.has(r.personId)) continue;
    if (!inEffect(r)) continue;
    if (r.role === 'director') continue; // directors as-at already come from officer events
    companyPeople.set(r.personId, {
      id: r.personId,
      name: r.personName,
      capacity: r.capacity || roleLabel[r.role as RelationshipRole] || '',
      appointedOn: r.startDate,
      ceasedOn: r.endDate,
    });
  }

  const visible = await visiblePersonIds(actor, { limit: PROPOSED_LIMIT }, tx);
  const proposedPeople: PersonSnapshot[] = visible.length
    ? (
        await tx
          .select({ id: s.people.id, name: s.people.fullName })
          .from(s.people)
          .where(inArray(s.people.id, visible))
      )
        .map((p) => ({ id: p.id, name: p.name, capacity: '', appointedOn: null, ceasedOn: null }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const secretaries = new Map<string, PersonSnapshot>();
  for (const r of relationships)
    if (r.role === 'secretary' && inEffect(r) && !secretaries.has(r.personId))
      secretaries.set(r.personId, {
        id: r.personId,
        name: r.personName,
        capacity: r.capacity || roleLabel.secretary,
        appointedOn: r.startDate,
        ceasedOn: r.endDate,
      });

  // Particulars and other directorships for everyone a selector may offer, as at the record date.
  const pools = [
    directors,
    [...members.values()],
    [...companyPeople.values()],
    [...secretaries.values()],
    proposedPeople,
  ];
  const personIds = [...new Set(pools.flat().map((p) => p.id))];
  const people = new Map(
    personIds.length
      ? (await tx.select().from(s.people).where(inArray(s.people.id, personIds))).map((r) => [
          r.id,
          r.data,
        ])
      : [],
  );
  const elsewhere = await otherDirectorships(actor, companyId, personIds, asAt, tx);
  const enrich = (p: PersonSnapshot): PersonSnapshot => {
    const person = people.get(p.id);
    if (!person) return p;
    const lines = [
      ...(elsewhere.get(p.id) ?? []),
      ...(person.otherDirectorships ?? [])
        .filter((d) => !(d.appointedOn && d.appointedOn > asAt))
        .map((d) => directorshipLine(d.companyName, d.appointedOn, d.ceasedOn)),
    ];
    const particulars = templateParticulars(person, asAt);
    return {
      ...p,
      ...(Object.keys(particulars).length ? { particulars } : {}),
      ...(lines.length ? { otherDirectorships: lines.join('\n') } : {}),
    };
  };

  const citations: Partial<Record<CitationKey, string>> = {};
  for (const key of CITATION_KEYS) {
    const value = valueAt(profile.citations[key], asAt);
    if (typeof value === 'string') citations[key] = value;
  }
  return {
    asAt,
    preparedOn: today(),
    firm: {
      name: settings.firmName,
      registrationNumber: settings.firmRegistrationNumber ?? '',
      address: settings.firmAddress ?? '',
      phone: settings.firmPhone ?? '',
      email: settings.firmEmail ?? '',
    },
    company: {
      id: company.id,
      name: company.name,
      registrationNumber: company.registrationNumber,
      address: company.address,
      incorporationDate: company.incorporationDate,
      financialYearEnd: company.financialYearEnd,
      revision: company.revision,
      profileRevision: profile.revision,
      citations,
      custom: resolveValues(profile.customValues, asAt),
    },
    case: {
      id: resolutionCase.id,
      kind: resolutionCase.kind,
      title: resolutionCase.title,
      revision: resolutionCase.revision,
      instructionDate: resolutionCase.instructionDate,
      resolutionDate: resolutionCase.resolutionDate,
      effectiveDate: resolutionCase.effectiveDate,
      custom: resolveValues(resolutionCase.customValues, asAt),
    },
    directors: directors.map(enrich),
    members: [...members.values()].map(enrich).sort((a, b) => a.name.localeCompare(b.name)),
    companyPeople: [...companyPeople.values()]
      .map(enrich)
      .sort((a, b) => a.name.localeCompare(b.name)),
    secretaries: [...secretaries.values()].map(enrich).sort((a, b) => a.name.localeCompare(b.name)),
    proposedPeople: proposedPeople.map(enrich),
  };
}

function directorshipLine(company: string, appointedOn: string | null, ceasedOn: string | null) {
  const dates = [
    appointedOn ? `appointed ${formatLongDate(appointedOn)}` : '',
    ceasedOn ? `ceased ${formatLongDate(ceasedOn)}` : '',
  ].filter(Boolean);
  return dates.length ? `${company} (${dates.join(', ')})` : company;
}

/**
 * Director appointments of these people at other companies the actor can see, in effect on the
 * as-at date or ended before it. Companies outside the actor's access are never named.
 */
async function otherDirectorships(
  actor: Actor,
  companyId: string,
  personIds: string[],
  asAt: string,
  tx: Transaction,
) {
  const out = new Map<string, string[]>();
  const companyIds = actor.companyIds.filter((id) => id !== companyId);
  if (!personIds.length || !companyIds.length) return out;
  const rows = (
    await tx
      .select({ data: s.companyRelationships.data })
      .from(s.companyRelationships)
      .where(
        and(
          inArray(s.companyRelationships.personId, personIds),
          inArray(s.companyRelationships.companyId, companyIds),
          eq(s.companyRelationships.role, 'director'),
        ),
      )
  )
    .map((r) => r.data)
    .filter((r) => !(r.startDate && r.startDate > asAt));
  if (!rows.length) return out;
  const names = new Map(
    (
      await tx
        .select({ id: s.companies.id, data: s.companies.data })
        .from(s.companies)
        .where(inArray(s.companies.id, [...new Set(rows.map((r) => r.companyId))]))
    ).map((c) => [c.id, c.data.name]),
  );
  for (const r of rows.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))) {
    const name = names.get(r.companyId);
    if (!name) continue;
    const ended = r.endDate && r.endDate <= asAt ? r.endDate : null;
    out.set(r.personId, [
      ...(out.get(r.personId) ?? []),
      directorshipLine(name, r.startDate, ended),
    ]);
  }
  return out;
}
