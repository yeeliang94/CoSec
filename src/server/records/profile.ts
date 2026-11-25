import { eq } from 'drizzle-orm';
import { db, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { prior, remember, requestKey } from '../repository';
import { auditChange } from '../resolution/shared';
import { appendCustomValue } from './custom-fields';
import { assertAny, lockCompany } from './scope';
import { assertCompany, DomainError } from '../../domain/access';
import type { Actor } from '../../domain/model';
import type { CitationKey, CompanyProfile } from '../../domain/resolution/model';
import {
  COMPANY_PARTICULAR_KEYS,
  companyParticularLabel,
  companyParticularsAt,
  validateBranch,
  validateCompanyParticulars,
  type Branch,
  type CompanyParticularKey,
} from '../../domain/ar1/company';
import { valueAt } from '../../domain/resolution/records';
import { IssuesError } from '../../domain/resolution/validate';
import { isMsic } from '../ar1/msic';
import { randomUUID } from 'node:crypto';
import type { ShareClass } from '../../domain/ar1/shares';
import { checkShareClasses, readShareEntries } from './shares';

export const emptyProfile = (companyId: string): CompanyProfile => ({
  companyId,
  revision: 0,
  citations: {},
  customValues: {},
});

export async function readProfile(companyId: string, tx?: Transaction) {
  const query = (tx ?? db)
    .select()
    .from(s.companyProfiles)
    .where(eq(s.companyProfiles.companyId, companyId));
  const [row] = await query;
  return row?.data ?? emptyProfile(companyId);
}

export async function getProfile(actor: Actor, companyId: string) {
  assertCompany(actor, companyId);
  return readProfile(companyId);
}

export type ProfileInput = { expectedRevision: number; requestId: string; reason: string } & (
  | { action: 'set_citation'; key: CitationKey; value: string; effectiveDate: string }
  | { action: 'set_custom'; definitionId: string; value: unknown; effectiveDate: string }
  | {
      action: 'set_particulars';
      values: Partial<Record<CompanyParticularKey, string | null>>;
      effectiveDate: string;
    }
  | { action: 'set_branches'; branches: (Omit<Branch, 'id'> & { id?: string })[] }
  | { action: 'set_share_classes'; classes: (Omit<ShareClass, 'id'> & { id?: string })[] }
);

/**
 * Appends a dated value for each company particular that differs from the one in force on the
 * effective date, then checks the particulars as they would stand on that date.
 */
function appendCompanyParticulars(
  actor: Actor,
  before: CompanyProfile,
  input: Extract<ProfileInput, { action: 'set_particulars' }>,
) {
  const particulars = { ...(before.particulars ?? {}) };
  const proposed: Partial<Record<CompanyParticularKey, string | null>> = companyParticularsAt(
    particulars,
    input.effectiveDate,
  );
  const recordedAt = new Date().toISOString();
  let changed = false;
  for (const key of COMPANY_PARTICULAR_KEYS) {
    if (!Object.hasOwn(input.values, key)) continue;
    const raw = input.values[key];
    const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    const current = valueAt(particulars[key], input.effectiveDate);
    if ((typeof current === 'string' && current ? current : null) === value) continue;
    changed = true;
    proposed[key] = value;
    particulars[key] = [
      ...(particulars[key] ?? []),
      {
        value,
        effectiveDate: input.effectiveDate,
        recordedAt,
        actorId: actor.id,
        reason: input.reason.trim(),
      },
    ];
  }
  if (!changed) throw new DomainError('No change to save.');
  const issues = validateCompanyParticulars(proposed, isMsic);
  if (issues.length)
    throw new IssuesError(
      'Check the company particulars.',
      issues.map((i) => ({
        message: i.message,
        location: companyParticularLabel(i.key),
        fieldId: i.key,
      })),
      'VALIDATION',
    );
  return particulars;
}

function branchList(input: Extract<ProfileInput, { action: 'set_branches' }>): Branch[] {
  if (input.branches.length > 50) throw new DomainError('Record up to 50 branches.');
  const seen = new Set<string>();
  return input.branches.map((b, i) => {
    const branch: Branch = {
      ...b,
      id: b.id && !seen.has(b.id) ? b.id : randomUUID(),
      from: b.from || null,
      until: b.until || null,
    };
    seen.add(branch.id);
    const problems = validateBranch(branch);
    if (problems.length) throw new DomainError(`Branch ${i + 1}: ${problems[0]}`);
    return branch;
  });
}

/**
 * Dated company particulars kept beside the immutable companies row. Each change appends a
 * dated value, so an as-at read before the effective date still returns the earlier value.
 */
export async function changeProfile(actor: Actor, companyId: string, input: ProfileInput) {
  assertCompany(actor, companyId);
  assertAny(actor, ['confirm_record', 'manage_people']);
  const key = requestKey(actor, `profile:${companyId}`, input.requestId);
  return transaction(async (tx) => {
    await lockCompany(companyId, tx);
    const before = await readProfile(companyId, tx);
    if (await prior(tx, key)) return before;
    if (before.revision !== input.expectedRevision)
      throw new DomainError('The company profile changed. Refresh and try again.', 'STALE', 409);
    const next = structuredClone(before);
    if (input.action === 'set_citation') {
      const value = input.value.trim();
      if (!value) throw new DomainError('Enter the constitution citation.');
      next.citations[input.key] = [
        ...(before.citations[input.key] ?? []),
        {
          value,
          effectiveDate: input.effectiveDate,
          recordedAt: new Date().toISOString(),
          actorId: actor.id,
          reason: input.reason.trim(),
        },
      ];
    } else if (input.action === 'set_custom')
      next.customValues = await appendCustomValue(actor, before.customValues, input, 'company', tx);
    else if (input.action === 'set_particulars')
      next.particulars = appendCompanyParticulars(actor, before, input);
    else if (input.action === 'set_share_classes') {
      const classes: ShareClass[] = input.classes.map((c) => ({
        id: c.id || randomUUID(),
        name: c.name.trim(),
        kind: c.kind,
      }));
      checkShareClasses(classes, before.shareClasses ?? [], await readShareEntries(companyId, tx));
      next.shareClasses = classes;
      if (JSON.stringify(classes) === JSON.stringify(before.shareClasses ?? []))
        throw new DomainError('No change to save.');
    } else {
      next.branches = branchList(input);
      if (JSON.stringify(next.branches) === JSON.stringify(before.branches ?? []))
        throw new DomainError('No change to save.');
    }
    next.revision = before.revision + 1;
    await tx
      .insert(s.companyProfiles)
      .values({ companyId, revision: next.revision, data: next })
      .onConflictDoUpdate({
        target: s.companyProfiles.companyId,
        set: { revision: next.revision, data: next },
      });
    await auditChange(tx, actor, {
      companyId,
      entityType: 'company_profile',
      entityId: companyId,
      action: `company_profile.${input.action}`,
      before,
      after: next,
      reason: input.reason,
      requestId: input.requestId,
      detail: {
        fromRevision: before.revision,
        toRevision: next.revision,
        ...(input.action === 'set_citation'
          ? { key: input.key }
          : input.action === 'set_custom'
            ? { key: input.definitionId }
            : {}),
        ...('effectiveDate' in input ? { effectiveDate: input.effectiveDate } : {}),
      },
    });
    await remember(tx, key, { id: companyId, revision: next.revision });
    return next;
  });
}
