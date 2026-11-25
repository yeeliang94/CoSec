import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, transaction, type Transaction } from '../db';
import * as s from '../schema';
import { prior, remember, requestKey } from '../repository';
import { auditChange } from '../resolution/shared';
import { assertAny, lockCompany } from './scope';
import { assertCompany, DomainError } from '../../domain/access';
import type { Actor } from '../../domain/model';
import { validateCharge, type Charge } from '../../domain/ar1/charges';

export async function readCharges(companyId: string, tx?: Transaction) {
  return (await (tx ?? db).select().from(s.charges).where(eq(s.charges.companyId, companyId)))
    .map((r) => r.data)
    .sort((a, b) => a.registeredOn.localeCompare(b.registeredOn));
}

export async function listCharges(actor: Actor, companyId: string) {
  assertCompany(actor, companyId);
  return { charges: await readCharges(companyId) };
}

type ChargeFields = {
  registeredNumber: string;
  registeredOn: string;
  nature: string;
  chargee: string;
  amount: string;
  dischargedOn: string | null;
  note: string;
};
export type ChargeInput =
  | ({ action: 'record'; requestId: string } & ChargeFields)
  | ({
      action: 'update';
      requestId: string;
      id: string;
      expectedRevision: number;
      reason: string;
    } & ChargeFields);

/** Registered charges for AR1 section C; every change is audited. */
export async function changeCharge(actor: Actor, companyId: string, input: ChargeInput) {
  assertCompany(actor, companyId);
  assertAny(actor, ['confirm_record', 'manage_people']);
  const fields: ChargeFields = {
    registeredNumber: input.registeredNumber.trim(),
    registeredOn: input.registeredOn,
    nature: input.nature.trim(),
    chargee: input.chargee.trim(),
    amount: input.amount.replace(/[,\s]/g, ''),
    dischargedOn: input.dischargedOn || null,
    note: input.note.trim(),
  };
  const problems = validateCharge(fields);
  if (problems.length) throw new DomainError(problems[0]);
  const key = requestKey(actor, `charges:${companyId}`, input.requestId);
  return transaction(async (tx) => {
    await lockCompany(companyId, tx);
    const old = await prior(tx, key);
    if (old) {
      const [row] = await tx.select().from(s.charges).where(eq(s.charges.id, old.id));
      return row.data;
    }
    const existing = await readCharges(companyId, tx);
    const duplicate = existing.find(
      (c) =>
        c.registeredNumber.toUpperCase() === fields.registeredNumber.toUpperCase() &&
        (input.action === 'record' || c.id !== input.id),
    );
    if (duplicate)
      throw new DomainError('A charge with this registered number is already recorded.');
    if (input.action === 'record') {
      const charge: Charge = {
        id: randomUUID(),
        companyId,
        ...fields,
        createdBy: actor.id,
        createdAt: new Date().toISOString(),
        revision: 1,
      };
      await tx.insert(s.charges).values({ id: charge.id, companyId, revision: 1, data: charge });
      await auditChange(tx, actor, {
        companyId,
        entityType: 'charge',
        entityId: charge.id,
        action: 'charge.recorded',
        before: null,
        after: charge,
        requestId: input.requestId,
      });
      await remember(tx, key, { id: charge.id, revision: 1 });
      return charge;
    }
    const before = existing.find((c) => c.id === input.id);
    if (!before) throw new DomainError('Charge not found.', 'NOT_FOUND', 404);
    if (before.revision !== input.expectedRevision)
      throw new DomainError('This charge changed. Refresh and try again.', 'STALE', 409);
    const next: Charge = { ...before, ...fields, revision: before.revision + 1 };
    if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...before, revision: 0 }))
      throw new DomainError('No change to save.');
    await tx
      .update(s.charges)
      .set({ revision: next.revision, data: next })
      .where(eq(s.charges.id, next.id));
    await auditChange(tx, actor, {
      companyId,
      entityType: 'charge',
      entityId: next.id,
      action: !before.dischargedOn && next.dischargedOn ? 'charge.discharged' : 'charge.updated',
      before,
      after: next,
      reason: input.reason,
      requestId: input.requestId,
      detail: { fromRevision: before.revision, toRevision: next.revision },
    });
    await remember(tx, key, { id: next.id, revision: next.revision });
    return next;
  });
}
