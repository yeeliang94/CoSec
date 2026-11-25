import { isCalendarDate } from '../resolution/records';
import { isMoney } from './shares';

/** A registered charge (AR1 section C). Amounts are MYR; foreign-currency charges are not supported yet. */
export type Charge = {
  id: string;
  companyId: string;
  /** SSM's registered number of the charge. */
  registeredNumber: string;
  registeredOn: string;
  nature: string;
  chargee: string;
  /** Amount secured, in MYR. */
  amount: string;
  dischargedOn: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
  revision: number;
};

/** A charge counts on a return when registered by the return date and not discharged by then. */
export const chargesAt = (charges: Charge[], asAt: string) =>
  charges
    .filter((c) => c.registeredOn <= asAt && (!c.dischargedOn || c.dischargedOn > asAt))
    .sort((a, b) => a.registeredOn.localeCompare(b.registeredOn) || a.id.localeCompare(b.id));

export function validateCharge(
  charge: Pick<
    Charge,
    'registeredNumber' | 'registeredOn' | 'nature' | 'chargee' | 'amount' | 'dischargedOn'
  >,
): string[] {
  const out: string[] = [];
  if (!charge.registeredNumber.trim()) out.push('Enter the registered number of the charge.');
  if (!isCalendarDate(charge.registeredOn)) out.push('Enter the date of registration.');
  if (!charge.nature.trim()) out.push('Enter the nature of the charge.');
  if (!charge.chargee.trim()) out.push('Enter the chargee.');
  if (!isMoney(charge.amount)) out.push('Enter the amount secured in MYR, for example 1500000.00.');
  if (charge.dischargedOn) {
    if (!isCalendarDate(charge.dischargedOn)) out.push('Enter the discharge date.');
    else if (charge.dischargedOn < charge.registeredOn)
      out.push('The discharge date cannot be before the registration date.');
  }
  return out;
}
