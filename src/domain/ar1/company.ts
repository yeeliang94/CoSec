import { isCalendarDate, valueAt } from '../resolution/records';
import type { DatedValue } from '../resolution/model';
import { COMPANY_STATUSES, COMPANY_TYPES, ORIGINS } from './mtool-lists';
import {
  addressProblems,
  ADDRESS_PARTS,
  formatAddress,
  isAddressEmpty,
  type Address,
  type AddressPart,
} from '../address';

// The one address model is `../address`; these names stay for the company screens.
export type { Address, AddressPart };
export { addressProblems };
export const PARTS = ADDRESS_PARTS;
export const joinAddress = formatAddress;
export const addressEmpty = isAddressEmpty;

/**
 * Company addresses for AR1 section A. The register of members and the financial records are
 * usually kept at the registered office, which is what the "same as registered" flags record.
 */
export const COMPANY_ADDRESS_GROUPS = [
  'registered',
  'membersRegister',
  'financialRecords',
  'principal',
] as const;
export type CompanyAddressGroup = (typeof COMPANY_ADDRESS_GROUPS)[number];
const addressKeysOf = (group: CompanyAddressGroup) =>
  ADDRESS_PARTS.map((p) => `${group}${p}` as const);

export const COMPANY_PARTICULAR_KEYS = [
  'origin',
  'status',
  'companyType',
  'formerName',
  'gstNumber',
  ...addressKeysOf('registered'),
  'membersRegisterAtRegistered',
  ...addressKeysOf('membersRegister'),
  'financialRecordsAtRegistered',
  ...addressKeysOf('financialRecords'),
  ...addressKeysOf('principal'),
  'phone',
  'fax',
  'email',
  'website',
  'natureOfBusiness',
  'msic1',
  'msic2',
  'msic3',
] as const;
export type CompanyParticularKey = (typeof COMPANY_PARTICULAR_KEYS)[number];
export type CompanyParticulars = Partial<Record<CompanyParticularKey, DatedValue[]>>;
export type CompanyParticularValues = Partial<Record<CompanyParticularKey, string | null>>;

/** A branch office (AR1 section A); `from` and `until` bound when it counts on a return. */
export type Branch = Address & {
  id: string;
  phone: string;
  fax: string;
  email: string;
  website: string;
  from: string | null;
  until: string | null;
};

export const COMPANY_ADDRESS_LABELS: Record<CompanyAddressGroup, string> = {
  registered: 'Registered office',
  membersRegister: 'Where the register of members is kept',
  financialRecords: 'Where the financial records are kept',
  principal: 'Principal place of business',
};
export const COMPANY_PARTICULAR_LABELS: Partial<Record<CompanyParticularKey, string>> = {
  origin: 'Origin',
  status: 'Status of company',
  companyType: 'Type of company',
  formerName: 'Former name',
  gstNumber: 'GST registration number',
  phone: 'Phone',
  fax: 'Fax',
  email: 'Email',
  website: 'Website',
  natureOfBusiness: 'Nature of business',
  msic1: 'MSIC code 1',
  msic2: 'MSIC code 2',
  msic3: 'MSIC code 3',
};
export function companyParticularLabel(key: CompanyParticularKey): string {
  const fixed = COMPANY_PARTICULAR_LABELS[key];
  if (fixed) return fixed;
  if (key.endsWith('AtRegistered')) return 'Kept at the registered office';
  const group = COMPANY_ADDRESS_GROUPS.find((g) => key.startsWith(g))!;
  const part = key.slice(group.length).replace('Line', 'line ').toLowerCase();
  return `${COMPANY_ADDRESS_LABELS[group]}, ${part}`;
}

export const companyAddressKey = (group: CompanyAddressGroup, part: AddressPart) =>
  `${group}${part}` as CompanyParticularKey;

/** The company particulars in force on `asAt`, keeping only non-empty text. */
export function companyParticularsAt(
  particulars: CompanyParticulars | undefined,
  asAt: string,
): Partial<Record<CompanyParticularKey, string>> {
  const out: Partial<Record<CompanyParticularKey, string>> = {};
  for (const key of COMPANY_PARTICULAR_KEYS) {
    const value = valueAt(particulars?.[key], asAt);
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

/** One company address; a register kept at the registered office reads the registered one. */
export function companyAddress(
  values: Partial<Record<CompanyParticularKey, string | null>>,
  group: CompanyAddressGroup,
): Address {
  const atRegistered =
    (group === 'membersRegister' && values.membersRegisterAtRegistered === 'Yes') ||
    (group === 'financialRecords' && values.financialRecordsAtRegistered === 'Yes');
  const source = atRegistered ? 'registered' : group;
  return Object.fromEntries(
    ADDRESS_PARTS.map((p) => [p, (values[companyAddressKey(source, p)] ?? '').trim()]),
  ) as Address;
}

export type CompanyIssue = { key: CompanyParticularKey; message: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks company particulars as they would stand together. `isMsic` checks a code against mTool's
 * MSIC list, which only the server holds. Every issue blocks a save.
 */
export function validateCompanyParticulars(
  values: CompanyParticularValues,
  isMsic: (code: string) => boolean,
): CompanyIssue[] {
  const issues: CompanyIssue[] = [];
  const get = (key: CompanyParticularKey) => (values[key] ?? '').trim();
  const choose = (key: CompanyParticularKey, options: readonly string[]) => {
    if (get(key) && !options.includes(get(key)))
      issues.push({ key, message: 'Choose one of the listed options.' });
  };
  choose('origin', ORIGINS);
  choose('status', COMPANY_STATUSES);
  choose('companyType', COMPANY_TYPES);
  for (const key of COMPANY_PARTICULAR_KEYS)
    if (get(key).length > (key === 'natureOfBusiness' ? 2000 : 255))
      issues.push({ key, message: 'This is too long.' });
  for (const group of COMPANY_ADDRESS_GROUPS) {
    if (
      (group === 'membersRegister' && get('membersRegisterAtRegistered') === 'Yes') ||
      (group === 'financialRecords' && get('financialRecordsAtRegistered') === 'Yes')
    )
      continue;
    const address = companyAddress(values, group);
    for (const p of addressProblems(address))
      issues.push({ key: companyAddressKey(group, p.part), message: p.message });
  }
  const registered = get('registeredCountry');
  if (registered && registered !== 'MALAYSIA')
    issues.push({
      key: 'registeredCountry',
      message: 'The registered office must be in Malaysia.',
    });
  if (get('email') && !EMAIL.test(get('email')))
    issues.push({ key: 'email', message: 'Enter an email address.' });
  const codes = (['msic1', 'msic2', 'msic3'] as const).map(get);
  codes.forEach((code, i) => {
    const key = (['msic1', 'msic2', 'msic3'] as const)[i];
    if (code && !isMsic(code))
      issues.push({ key, message: 'Enter a code from the MSIC 2008 list.' });
    if (code && codes.indexOf(code) !== i)
      issues.push({ key, message: 'This code is already listed.' });
  });
  if (!codes[0] && (codes[1] || codes[2]))
    issues.push({ key: 'msic1', message: 'Enter the main business code first.' });
  return issues;
}

export function validateBranch(branch: Branch): string[] {
  const out = addressProblems(branch).map((p) => p.message);
  if (isAddressEmpty(branch)) out.push('Enter the branch address.');
  if (branch.email && !EMAIL.test(branch.email)) out.push('Enter an email address.');
  if (branch.from && !isCalendarDate(branch.from)) out.push('Enter the opening date.');
  if (branch.until && !isCalendarDate(branch.until)) out.push('Enter the closing date.');
  if (branch.from && branch.until && branch.until < branch.from)
    out.push('The branch cannot close before it opened.');
  return out;
}

/** Branches open on `asAt`. */
export const branchesAt = (branches: Branch[] | undefined, asAt: string) =>
  (branches ?? []).filter((b) => (!b.from || b.from <= asAt) && (!b.until || b.until > asAt));
