import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { atomically, db, transaction } from '../db';
import * as s from '../schema';
import { createCompany, getCompany, insertDocument, listOfficerEvents } from '../repository';
import { withAuditSource } from '../audit-source';
import { assertPersonVisible } from '../records/scope';
import { assertCapability, DomainError, today } from '../../domain/access';
import type { Actor, Company, Document } from '../../domain/model';
import {
  openQuestions,
  type ImportCompany,
  type ImportFile,
  type PersonSuggestion,
  type Suggestion,
} from '../../domain/imports';
import { changeProfile, readProfile } from '../records/profile';
import { changePerson } from '../records/people';
import { changeRelationship, companyRelationships } from '../records/relationships';
import { changeShareEntry, readShareEntries } from '../records/shares';
import { changeCharge, readCharges } from '../records/charges';
import { isCompanyParticular, isCoreKey, missingToCreate } from './fields';
import {
  findByIdentity,
  findByName,
  importFilePath,
  readImportBytes,
  readRow,
  removeImportFiles,
  saveRow,
} from './store';
import { companyAddress } from '../../domain/ar1/company';
import { formatAddress } from '../../domain/address';
import { effectiveEntries } from '../../domain/ar1/shares';
import { directorIntervals } from '../../domain/resolution/records';
import { safeStoragePath } from '../storage';
import type { CompanyParticularKey } from '../../domain/ar1/company';

export const applyInput = z.object({
  expectedRevision: z.number().int(),
  requestId: z.string().uuid(),
});

const DOC_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  csv: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
};
const ok = (error: unknown) =>
  error instanceof DomainError && error.message === 'No change to save.';
const uuid = () => randomUUID();

/** What Apply will do, for the dialog. Nothing is written. */
export function applyPlan(row: ImportCompany) {
  const used = row.suggestions.filter((sug) => sug.use && !sug.error);
  const existing = row.target.mode === 'existing';
  const company = used.filter(
    (sug) => sug.kind === 'company' && (!existing || !isCoreKey(sug.key)),
  ).length;
  return {
    company,
    people: used.filter((sug) => sug.kind === 'person').length,
    roles: used.filter((sug) => sug.kind === 'role').length,
    shares: used.filter((sug) => sug.kind === 'shares').length,
    charges: used.filter((sug) => sug.kind === 'charge').length,
    files: new Set(used.flatMap((sug) => (sug.source.fileId ? [sug.source.fileId] : []))).size,
    missing: existing ? [] : missingToCreate(row.suggestions, true),
  };
}

/**
 * Writes one reviewed company through the app's own record writers, all in one transaction:
 * either every value lands or none does. Each audit entry names the import and source file.
 * Directors go in as officer events, members as draft share entries for someone else to post,
 * and a new company stays Unverified until someone else does the opening review.
 */
export async function applyImportCompany(
  actor: Actor,
  importId: string,
  rowId: string,
  input: z.infer<typeof applyInput>,
) {
  assertCapability(actor, 'prepare_job');
  assertCapability(actor, 'manage_people');
  const [batch] = await db.select().from(s.imports).where(eq(s.imports.id, importId));
  if (!batch || batch.createdBy !== actor.id)
    throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
  const row = await readRow(rowId);
  if (row.importId !== importId)
    throw new DomainError('Import access is unavailable.', 'NOT_FOUND', 404);
  if (row.status === 'Applied') return row;
  if (row.revision !== input.expectedRevision)
    throw new DomainError(
      'This company changed while you were looking. Refresh and try again.',
      'STALE',
      409,
    );
  if (openQuestions(row).length) throw new DomainError('Answer the questions before applying.');
  if (row.status !== 'Ready') throw new DomainError('This company is not ready to apply.');
  // Their files would be removed with this company's, so they are placed first.
  if (row.files.some((f) => f.result === 'Another company'))
    throw new DomainError(
      'Some files look like they belong to another company. Choose where they go, or leave them out, before applying.',
    );
  const used = row.suggestions.filter((sug) => sug.use && !sug.error);
  if (!used.length) throw new DomainError('Tick at least one value to apply.');
  const existing = row.target.mode === 'existing' ? row.target.companyId : null;
  if (!existing) {
    const missing = missingToCreate(row.suggestions, true);
    if (missing.length) throw new DomainError(`A new company needs: ${missing.join(', ')}.`);
  }

  // People are matched before anything is written, so a hidden duplicate stops the apply early.
  const people = new Map<string, { suggestion: PersonSuggestion; personId: string | null }>();
  for (const sug of used)
    if (sug.kind === 'person') {
      let personId: string | null = null;
      if (sug.values.identityNumber) {
        const found = await findByIdentity(
          actor,
          sug.values.identityType ?? null,
          sug.values.identityNumber,
        );
        if (found.some((f) => !f.visible))
          throw new DomainError(
            `${sug.fullName} is already in the app, linked to a company you cannot open. Ask an admin for access, then apply again.`,
          );
        personId = found[0]?.personId ?? null;
      }
      // Same name and no identity number to compare: the reviewer decides, never a silent merge.
      if (!personId && (await findByName(actor, sug.fullName)).length) {
        if (sug.linkTo === undefined)
          throw new DomainError(
            `${sug.fullName} has the same name as someone already in the app. On People and roles, choose whether they are the same person.`,
          );
        if (sug.linkTo) {
          await assertPersonVisible(actor, sug.linkTo);
          personId = sug.linkTo;
        }
      }
      people.set(sug.ref, { suggestion: sug, personId });
    }
  const needRef = (ref: string) => {
    const p = people.get(ref);
    if (!p)
      throw new DomainError(
        'A ticked role or holding names a person who is not ticked under People. Tick the person, or untick the role or holding.',
      );
    return p;
  };
  for (const sug of used) {
    if (sug.kind === 'role') needRef(sug.personRef);
    if (sug.kind === 'shares') sug.personRefs.forEach(needRef);
    if (sug.kind === 'role' && sug.role === 'director' && !sug.startDate)
      throw new DomainError(
        `The appointment date of ${needRef(sug.personRef).suggestion.fullName} is missing. Untick that role to apply the rest.`,
      );
    if (sug.kind === 'shares' && (!sug.amountPaid || !sug.consideration))
      throw new DomainError(
        `The holding of ${sug.personRefs.map((r) => needRef(r).suggestion.fullName).join(' and ')} has no amount paid or consideration. Untick it to apply the rest.`,
      );
  }

  // Source files are copied into Documents first (file writes stay outside the transaction).
  const files = new Map<
    string,
    { file: ImportFile; doc: Document | null; key: string | null; bytes: Buffer | null }
  >();
  for (const id of new Set(used.map((sug) => sug.source.fileId))) {
    const file = row.files.find((f) => f.id === id);
    // A value entered by the reviewer has no file; any other value needs its file here.
    if (!file) {
      if (id)
        throw new DomainError(
          'A ticked value comes from a file this company no longer has. Run this company again.',
        );
      continue;
    }
    const ext = file.name.split('.').pop()!.toLowerCase();
    if (!DOC_TYPES[ext] || !file.storageKey) {
      files.set(id, { file, doc: null, key: null, bytes: null });
      continue;
    }
    const bytes = await readImportBytes(importId, file);
    const key = `${uuid()}.${ext === 'csv' ? 'txt' : ext}`;
    const destination = safeStoragePath(key);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    files.set(id, { file, doc: null, key, bytes });
  }
  const cleanup = async () => {
    for (const f of files.values())
      if (f.key) await unlink(safeStoragePath(f.key)).catch(() => undefined);
  };

  const notes: string[] = [];
  let applied: ImportCompany;
  try {
    applied = await atomically(async (tx) => {
      const latest = await readRow(rowId, tx);
      if (latest.revision !== row.revision)
        throw new DomainError(
          'This company changed while you were looking. Refresh and try again.',
          'STALE',
          409,
        );
      let me: Actor = actor;
      const sourced = <T>(sug: Suggestion | null, fn: () => Promise<T>) =>
        withAuditSource(
          {
            importId,
            importCompanyId: rowId,
            file: sug ? (files.get(sug.source.fileId)?.file.name ?? null) : null,
          },
          fn,
        );
      const companyValue = (key: string) => {
        const sug = used.find((x) => x.kind === 'company' && x.key === key);
        return sug?.kind === 'company' ? sug.value : '';
      };

      // 1. The company itself.
      let companyId = existing;
      let company: Company;
      if (!companyId) {
        const registration = companyValue('registrationNumber').replace(/\s/g, '');
        const clash = (await tx.select().from(s.companies)).find(
          (c) =>
            c.data.registrationNumber.replace(/[\s-]/g, '').toUpperCase() ===
            registration.replace(/-/g, '').toUpperCase(),
        );
        if (clash)
          throw new DomainError(
            `A company with registration number ${registration} is already in the app. Match the folder to it instead.`,
          );
        const registered = Object.fromEntries(
          used.flatMap((x) =>
            x.kind === 'company' && isCompanyParticular(x.key) ? [[x.key, x.value]] : [],
          ),
        ) as Partial<Record<CompanyParticularKey, string>>;
        company = {
          id: uuid(),
          name: companyValue('name'),
          registrationNumber: registration,
          incorporationDate: companyValue('incorporationDate'),
          financialYearEnd: companyValue('financialYearEnd'),
          legalStatus: 'Existing',
          engagementStatus: 'Active',
          address:
            formatAddress(companyAddress(registered, 'registered')) || 'See registered office',
          industry: companyValue('industry'),
          activity: companyValue('activity'),
          verification: 'Unverified',
          sourceEvidenceId: null,
          createdBy: actor.id,
          revision: 1,
        };
        await sourced(used.find((x) => x.kind === 'company' && x.key === 'name') ?? null, () =>
          createCompany(actor, [], company),
        );
        companyId = company.id;
        me = { ...actor, companyIds: [...actor.companyIds, company.id] };
      } else company = await getCompany(companyId, tx);
      const id = companyId;
      const fallbackDate = existing ? today() : company.incorporationDate;
      const dateOf = (d: string | null) =>
        !d
          ? fallbackDate
          : !existing && d < company.incorporationDate
            ? company.incorporationDate
            : d;

      // 2. Source documents, so share entries and director events can point at them.
      for (const f of files.values()) {
        if (!f.key || !f.bytes) continue;
        const ext = f.file.name.split('.').pop()!.toLowerCase();
        const doc: Document = {
          id: uuid(),
          companyId: id,
          title: (f.file.readAs || f.file.name).slice(0, 200),
          originalName: f.file.name.slice(0, 200),
          mimeType: DOC_TYPES[ext],
          size: f.bytes.byteLength,
          sha256: createHash('sha256').update(f.bytes).digest('hex'),
          storageKey: f.key,
          createdBy: actor.id,
          createdAt: new Date().toISOString(),
          classification: 'General',
        };
        await sourced(null, () => insertDocument(me, doc));
        f.doc = doc;
      }
      const docOf = (sug: Suggestion) => files.get(sug.source.fileId)?.doc?.id ?? null;

      // 3. Company particulars, grouped by the date each applies from, oldest first.
      const particulars = used.filter(
        (x): x is Extract<Suggestion, { kind: 'company' }> =>
          x.kind === 'company' && isCompanyParticular(x.key),
      );
      const byDate = new Map<string, typeof particulars>();
      for (const p of particulars) {
        const date = dateOf(p.effectiveDate);
        byDate.set(date, [...(byDate.get(date) ?? []), p]);
      }
      for (const [date, group] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const profile = await readProfile(id, tx);
        await sourced(group[0], () =>
          changeProfile(me, id, {
            action: 'set_particulars',
            expectedRevision: profile.revision,
            requestId: uuid(),
            reason: 'Bulk import',
            effectiveDate: date,
            values: Object.fromEntries(group.map((g) => [g.key, g.value])),
          }),
        ).catch((e) => {
          if (!ok(e)) throw e;
        });
      }

      // 4. Share classes the holdings need.
      const holdings = used.filter(
        (x): x is Extract<Suggestion, { kind: 'shares' }> => x.kind === 'shares',
      );
      if (holdings.length) {
        const profile = await readProfile(id, tx);
        const classes = [...(profile.shareClasses ?? [])];
        for (const h of holdings)
          if (!classes.some((c) => c.name.toLowerCase() === h.className.toLowerCase()))
            classes.push({ id: uuid(), name: h.className, kind: h.classKind });
        if (classes.length !== (profile.shareClasses ?? []).length)
          await sourced(holdings[0], () =>
            changeProfile(me, id, {
              action: 'set_share_classes',
              expectedRevision: profile.revision,
              requestId: uuid(),
              reason: 'Bulk import',
              classes,
            }),
          );
      }

      // 5. People: link a match, otherwise create; then their particulars.
      for (const entry of people.values()) {
        const sug = entry.suggestion;
        let personId = entry.personId;
        // Checked again under the write lock: another import may have added this person since.
        if (!personId && sug.values.identityNumber)
          personId =
            (
              await findByIdentity(me, sug.values.identityType ?? null, sug.values.identityNumber)
            )[0]?.personId ?? null;
        if (!personId) {
          const person = await sourced(sug, () =>
            changePerson(me, {
              action: 'create',
              requestId: uuid(),
              kind: sug.personKind,
              fullName: sug.fullName,
            }),
          );
          personId = person.id;
        }
        entry.personId = personId;
        if (Object.keys(sug.values).length) {
          const [p] = await tx.select().from(s.people).where(eq(s.people.id, personId));
          await sourced(sug, () =>
            changePerson(me, {
              action: 'set_particulars',
              id: personId!,
              expectedRevision: p.revision,
              requestId: uuid(),
              values: sug.values,
              effectiveDate: dateOf(sug.effectiveDate),
              reason: 'Bulk import',
            }),
          ).catch((e) => {
            if (ok(e)) return;
            if (e instanceof DomainError && e.code === 'FORBIDDEN') {
              notes.push(
                `${sug.fullName}'s details were kept as they are: they are shared with a company you cannot open.`,
              );
              return;
            }
            throw e;
          });
        }
      }

      // 6. Roles in date order. Directors become officer events.
      const roles = used
        .filter((x): x is Extract<Suggestion, { kind: 'role' }> => x.kind === 'role')
        .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
      for (const r of roles) {
        const personId = needRef(r.personRef).personId!;
        const current = await companyRelationships(id, tx);
        if (r.role === 'director') {
          const name = needRef(r.personRef).suggestion.fullName;
          const terms = directorIntervals(await listOfficerEvents(id, tx)).filter(
            (t) => t.personId === personId,
          );
          const same = terms.find((t) => t.startDate === r.startDate);
          if (same) {
            // The app already has this appointment; record the end date the files give.
            if (!same.endDate && r.endDate) {
              const row = current.find(
                (c) => c.personId === personId && c.role === 'director' && !c.endDate,
              );
              if (row)
                await sourced(r, () =>
                  changeRelationship(me, id, {
                    action: 'end',
                    id: row.id,
                    expectedRevision: row.revision,
                    requestId: uuid(),
                    endDate: r.endDate!,
                    reason: 'Bulk import',
                    cessation: r.cessation ?? 'other_cessation',
                  }),
                );
            } else if (same.endDate && r.endDate && same.endDate !== r.endDate)
              throw new DomainError(
                `${name}'s director term ends on ${r.endDate} in the files but ${same.endDate} in the app. Untick the role, or correct the record first.`,
              );
            continue;
          }
          const clash = terms.find(
            (t) =>
              t.startDate <= (r.endDate ?? '9999') && (r.startDate ?? '') <= (t.endDate ?? '9999'),
          );
          if (clash)
            throw new DomainError(
              `${name}'s director dates in the files (from ${r.startDate}) overlap the app's record (from ${clash.startDate}${clash.endDate ? ` to ${clash.endDate}` : ''}). Untick the role, or correct the record first.`,
            );
        } else {
          // The same appointment already in the app is updated, never added a second time.
          const mine = current.filter((c) => c.personId === personId && c.role === r.role);
          const open = mine.find((c) => !c.endDate);
          // An open appointment counts as the same one only when the start dates agree or one is
          // missing; an "other" role matches on its date alone, since its capacity may differ.
          const same =
            mine.find((c) => r.startDate && c.startDate === r.startDate) ??
            (open && r.role !== 'other' && (!r.startDate || !open.startDate) ? open : undefined);
          const clash =
            !same &&
            r.role !== 'other' &&
            mine.find(
              (c) =>
                (c.startDate ?? '') <= (r.endDate ?? '9999') &&
                (r.startDate ?? '') <= (c.endDate ?? '9999'),
            );
          if (clash)
            throw new DomainError(
              `${needRef(r.personRef).suggestion.fullName}'s ${r.role} dates in the files (from ${r.startDate}) overlap the app's record (from ${clash.startDate}${clash.endDate ? ` to ${clash.endDate}` : ''}). Untick the role, or correct the record first.`,
            );
          if (same) {
            const name = needRef(r.personRef).suggestion.fullName;
            if (!same.endDate && r.endDate)
              await sourced(r, () =>
                changeRelationship(me, id, {
                  action: 'end',
                  id: same.id,
                  expectedRevision: same.revision,
                  requestId: uuid(),
                  endDate: r.endDate!,
                  reason: 'Bulk import',
                  cessation: r.cessation ?? 'other_cessation',
                }),
              );
            else if (same.endDate && r.endDate && same.endDate !== r.endDate)
              throw new DomainError(
                `${name}'s ${r.role} role ends on ${r.endDate} in the files but ${same.endDate} in the app. Untick the role, or correct the record first.`,
              );
            continue;
          }
        }
        const added = await sourced(r, () =>
          changeRelationship(me, id, {
            action: 'add',
            requestId: uuid(),
            personId,
            role: r.role,
            capacity: '',
            startDate: r.startDate,
            evidenceIds: docOf(r) ? [docOf(r)!] : [],
          }),
        );
        if (r.endDate)
          await sourced(r, () =>
            changeRelationship(me, id, {
              action: 'end',
              id: added.id,
              expectedRevision: added.revision,
              requestId: uuid(),
              endDate: r.endDate!,
              reason: 'Bulk import',
              cessation: r.cessation ?? 'other_cessation',
            }),
          );
      }

      // 7. Holdings as draft opening entries; someone else reviews and posts them.
      if (holdings.length) {
        if (effectiveEntries(await readShareEntries(id, tx)).length)
          notes.push(
            'The share register already has entries, so the suggested holdings were not added.',
          );
        else {
          const classes = (await readProfile(id, tx)).shareClasses ?? [];
          for (const h of holdings)
            await sourced(h, () =>
              changeShareEntry(me, id, {
                action: 'record',
                requestId: uuid(),
                kind: 'opening',
                date: h.date,
                classId: classes.find((c) => c.name.toLowerCase() === h.className.toLowerCase())!
                  .id,
                shares: h.shares,
                from: null,
                to: { partyIds: h.personRefs.map((ref) => needRef(ref).personId!) },
                amountPayable: h.amountPayable ?? h.amountPaid,
                amountPaid: h.amountPaid,
                consideration: h.consideration,
                sourceDocumentId: docOf(h),
                sourceCaseId: null,
                note: 'From bulk import',
              }),
            );
        }
      }

      // 8. Charges not already recorded.
      const recorded = new Set(
        (await readCharges(id, tx)).map((c) => c.registeredNumber.toUpperCase()),
      );
      for (const c of used.filter(
        (x): x is Extract<Suggestion, { kind: 'charge' }> => x.kind === 'charge',
      )) {
        if (recorded.has(c.registeredNumber.toUpperCase())) continue;
        await sourced(c, () =>
          changeCharge(me, id, {
            action: 'record',
            requestId: uuid(),
            registeredNumber: c.registeredNumber,
            registeredOn: c.registeredOn,
            nature: c.nature,
            chargee: c.chargee,
            amount: c.amount,
            dischargedOn: c.dischargedOn,
            note: 'From bulk import',
          }),
        );
      }

      // 9. The import row: applied, and its suggestions and quotes dropped (they hold identity numbers).
      const done = structuredClone(latest);
      done.status = 'Applied';
      done.applied = { by: actor.id, at: new Date().toISOString(), companyId: id };
      done.name = company.name;
      done.registrationNumber = company.registrationNumber;
      done.suggestions = [];
      done.questions = [];
      done.run.summary = [`Applied ${used.length} values.`, ...notes].join(' ');
      done.files = done.files.map((f) => ({ ...f, storageKey: '' }));
      return saveRow(tx, done);
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  // The row's own stored files are no longer needed; Documents holds the used ones.
  await removeRowFiles(row);
  await finishBatchIfDone(importId);
  return { ...applied, notes };
}

async function removeRowFiles(row: ImportCompany) {
  for (const f of row.files)
    if (f.storageKey)
      await unlink(importFilePath(row.importId, f.storageKey)).catch(() => undefined);
}
async function finishBatchIfDone(importId: string) {
  const rows = await db
    .select({ status: s.importCompanies.status })
    .from(s.importCompanies)
    .where(eq(s.importCompanies.importId, importId));
  if (rows.some((r) => r.status !== 'Applied' && r.status !== 'Left out')) return;
  await transaction(async (tx) => {
    const [b] = await tx.select().from(s.imports).where(eq(s.imports.id, importId));
    if (!b || b.status === 'Finished') return;
    const data = { ...b.data, status: 'Finished' as const, revision: b.revision + 1 };
    await tx
      .update(s.imports)
      .set({ status: 'Finished', revision: data.revision, data })
      .where(eq(s.imports.id, importId));
  });
  await removeImportFiles(importId);
}
