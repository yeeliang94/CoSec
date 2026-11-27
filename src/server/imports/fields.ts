import {
  COMPANY_PARTICULAR_KEYS,
  companyParticularLabel,
  validateCompanyParticulars,
  type CompanyParticularKey,
} from '../../domain/ar1/company';
import {
  COMPANY_STATUSES,
  COMPANY_TYPES,
  COUNTRIES,
  ORIGINS,
  STATES,
} from '../../domain/ar1/mtool-lists';
import { INDUSTRIES, isYearEnd } from '../../domain/company';
import {
  PARTICULAR_KEYS,
  type ParticularKey,
  type PersonKind,
} from '../../domain/resolution/model';
import {
  normaliseIdentity,
  particularLabel,
  particularOptions,
  validateParticulars,
} from '../../domain/resolution/particulars';
import { isCalendarDate } from '../../domain/resolution/records';
import { isMoney, isShareCount } from '../../domain/ar1/shares';
import { validateCharge } from '../../domain/ar1/charges';
import { isMsic } from '../ar1/msic';
import type { Suggestion } from '../../domain/imports';

/**
 * The record fields the agent may suggest, generated from the app's own field lists so a field
 * added to the app reaches the agent without a prompt change. Each check returns a plain message
 * the agent can act on, or null.
 */
export const CORE_COMPANY_FIELDS = {
  name: 'Legal name',
  registrationNumber: 'Registration number (new 12-digit form when shown)',
  incorporationDate: 'Incorporation date',
  financialYearEnd: 'Financial year end, as MM-DD',
  industry: 'Industry section letter',
  activity: 'Short description of the business activity',
} as const;
export type CoreCompanyKey = keyof typeof CORE_COMPANY_FIELDS;
export const isCoreKey = (key: string): key is CoreCompanyKey => key in CORE_COMPANY_FIELDS;
export const isCompanyParticular = (key: string): key is CompanyParticularKey =>
  (COMPANY_PARTICULAR_KEYS as readonly string[]).includes(key);
/** Core fields are set only when a company is created; an existing company keeps its own. */
export const REQUIRED_TO_CREATE: readonly string[] = [
  'name',
  'registrationNumber',
  'incorporationDate',
  'financialYearEnd',
  'industry',
  'registeredLine1',
];
/** The fields a new company still lacks, by label. One rule for the agent's check and Apply. */
export function missingToCreate(
  suggestions: { kind: string; key?: string; use: boolean }[],
  onlyTicked: boolean,
) {
  const keys = new Set(
    suggestions.flatMap((s) => (s.kind === 'company' && (s.use || !onlyTicked) ? [s.key!] : [])),
  );
  return REQUIRED_TO_CREATE.filter((k) => !keys.has(k)).map((k) =>
    k === 'registeredLine1' ? 'Registered office' : companyFieldLabel(k),
  );
}

export function companyFieldLabel(key: string) {
  if (isCoreKey(key)) return CORE_COMPANY_FIELDS[key].replace(/ \(.*\)|, as MM-DD/g, '');
  if (isCompanyParticular(key)) return companyParticularLabel(key);
  return key;
}

const LONG_LIST = 30;
function optionsHint(options: readonly string[]) {
  return options.length > LONG_LIST
    ? `one of mTool's ${options.length} values, for example ${options.slice(0, 3).join(', ')}`
    : `one of: ${options.join(' | ')}`;
}
function companyOptions(key: CompanyParticularKey): readonly string[] | null {
  if (key === 'origin') return ORIGINS;
  if (key === 'status') return COMPANY_STATUSES;
  if (key === 'companyType') return COMPANY_TYPES;
  if (key.endsWith('Country')) return COUNTRIES;
  if (key.endsWith('State')) return STATES;
  if (key.endsWith('AtRegistered')) return ['Yes'];
  return null;
}
/** Up to eight listed options that look like `value`, to put in an error message. */
function closest(options: readonly string[], value: string) {
  const v = value.trim().toLowerCase();
  const hits = options.filter((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
  return (hits.length ? hits : options).slice(0, 8).join(' | ');
}

/** The field list sent to the agent once per company. */
export function fieldCatalogue() {
  const company = [
    ...Object.entries(CORE_COMPANY_FIELDS).map(
      ([key, label]) =>
        `- ${key}: ${label}${key === 'industry' ? `; ${INDUSTRIES.map(([c, l]) => `${c} ${l}`).join('; ')}` : ''}`,
    ),
    ...COMPANY_PARTICULAR_KEYS.map((key) => {
      const options = companyOptions(key);
      return `- ${key}: ${companyParticularLabel(key)}${options ? ` (${optionsHint(options)})` : ''}${key.startsWith('msic') ? ' (MSIC 2008 five-digit code)' : ''}`;
    }),
  ];
  const person = PARTICULAR_KEYS.map((key) => {
    const individual = particularOptions(key, 'individual');
    const organisation = particularOptions(key, 'organisation');
    const label = particularLabel(key);
    const hint =
      individual && organisation && individual !== organisation
        ? ` (individual: ${optionsHint(individual)}; organisation: ${optionsHint(organisation)})`
        : individual
          ? ` (${optionsHint(individual)})`
          : '';
    return `- ${key}: ${label}${hint}`;
  });
  return `Company fields (suggest_company_value):\n${company.join('\n')}\n\nPerson fields (suggest_person values):\n${person.join('\n')}`;
}

/** Normalises and checks one company value; returns the value to store or an error. */
export function checkCompanyValue(
  key: string,
  raw: string,
): { value: string; error: null } | { value: string; error: string } {
  const value = raw.trim();
  if (!value) return { value, error: 'Give a value, or leave the field out.' };
  if (isCoreKey(key)) {
    if (key === 'incorporationDate' && !isCalendarDate(value))
      return { value, error: 'Give the date as YYYY-MM-DD.' };
    if (key === 'financialYearEnd') {
      const monthDay = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : value;
      return isYearEnd(monthDay)
        ? { value: monthDay, error: null }
        : { value, error: 'Give the financial year end as MM-DD, for example 12-31.' };
    }
    if (key === 'industry' && !INDUSTRIES.some(([code]) => code === value.toUpperCase()))
      return {
        value,
        error: `Give an industry section letter: ${INDUSTRIES.map(([c]) => c).join(', ')}.`,
      };
    if (key === 'industry') return { value: value.toUpperCase(), error: null };
    if (key === 'registrationNumber' && value.length < 4)
      return { value, error: 'Give the full registration number.' };
    return { value, error: null };
  }
  if (!isCompanyParticular(key)) return { value, error: `${key} is not a field in the list.` };
  const options = companyOptions(key);
  if (options && !options.includes(value))
    return { value, error: `Use one of the listed values: ${closest(options, value)}.` };
  const issue = validateCompanyParticulars({ [key]: value }, isMsic).find((i) => i.key === key);
  return issue ? { value, error: issue.message } : { value, error: null };
}

/** Normalises and checks a person's values; errors name each field. */
export function checkPersonValues(kind: PersonKind, raw: Record<string, string>) {
  const values: Partial<Record<ParticularKey, string>> = {};
  const errors: string[] = [];
  for (const [key, text] of Object.entries(raw)) {
    if (!(PARTICULAR_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key} is not a person field in the list.`);
      continue;
    }
    const value = String(text ?? '').trim();
    if (!value) continue;
    const options = particularOptions(key as ParticularKey, kind);
    if (options && !options.includes(value)) {
      errors.push(`${key}: use one of the listed values: ${closest(options, value)}.`);
      continue;
    }
    values[key as ParticularKey] = value;
  }
  if (values.identityNumber)
    values.identityNumber = normaliseIdentity(values.identityType ?? null, values.identityNumber);
  // Address parts are checked one by one here; a partly known address is still worth suggesting.
  for (const issue of validateParticulars(values, kind))
    if (issue.severity === 'error' && values[issue.key] !== undefined)
      errors.push(`${issue.key}: ${issue.message}`);
  return { values: values as Record<string, string>, errors };
}

const money = (v: string | null) => (v ? v.replace(/[,\s]|RM|MYR/gi, '') : null);
export function checkShares(input: {
  shares: string;
  amountPayable: string | null;
  amountPaid: string | null;
  date: string;
}) {
  const errors: string[] = [];
  const shares = input.shares.replace(/[,\s]/g, '');
  if (!isShareCount(shares)) errors.push('Give the number of shares as a whole number.');
  const amountPaid = money(input.amountPaid);
  const amountPayable = money(input.amountPayable) ?? amountPaid;
  if (amountPaid && !isMoney(amountPaid))
    errors.push('Give the amount paid in MYR, for example 1000.00.');
  if (amountPayable && !isMoney(amountPayable)) errors.push('Give the amount payable in MYR.');
  if (!isCalendarDate(input.date)) errors.push('Give the date as YYYY-MM-DD.');
  return { shares, amountPayable, amountPaid, errors };
}

export function checkCharge(input: {
  registeredNumber: string;
  registeredOn: string;
  nature: string;
  chargee: string;
  amount: string;
  dischargedOn: string | null;
}) {
  const fields = {
    ...input,
    amount: input.amount.replace(/[,\s]|RM|MYR/gi, ''),
    dischargedOn: input.dischargedOn || null,
  };
  return { fields, errors: validateCharge(fields) };
}

export const isDate = (value: string | null | undefined) => !value || isCalendarDate(value);

const ROLES = ['director', 'secretary', 'manager', 'auditor', 'other'] as const;
const CESSATIONS = ['resignation', 'removal', 'other_cessation'] as const;
const CLASS_KINDS = ['Ordinary', 'Preference', 'Other'] as const;
const CONSIDERATIONS = ['Cash', 'Otherwise than cash'] as const;
const IDENTITY = ['identityType', 'identityNumber', 'dateOfBirth', 'passportExpiry'];
const pick = <T extends string>(list: readonly T[], v: string | null | undefined) =>
  list.find((x) => x === v) ?? null;

/**
 * The reviewer's correction of a person, role, holding or charge, checked by the same rules the
 * agent's suggestions pass. Someone without view_identity cannot change identity particulars.
 */
export function correctSuggestion(
  sug: Exclude<Suggestion, { kind: 'company' }>,
  raw: Record<string, string | null>,
  canSeeIdentity: boolean,
): { next: Suggestion; errors: string[] } {
  const get = (k: string) => (typeof raw[k] === 'string' ? raw[k]!.trim() : '');
  const opt = (k: string) => get(k) || null;
  const errors: string[] = [];
  let next: Suggestion;
  if (sug.kind === 'person') {
    const fullName = get('fullName');
    if (!fullName) errors.push('Enter the full name.');
    const merged: Record<string, string> = { ...sug.values };
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'fullName' || k === 'effectiveDate') continue;
      // Without view_identity these arrive masked, for organisations too: never save them back.
      if (IDENTITY.includes(k) && !canSeeIdentity) continue;
      if (v && v.trim()) merged[k] = v.trim();
      else delete merged[k];
    }
    const checked = checkPersonValues(sug.personKind, merged);
    errors.push(...checked.errors);
    const effectiveDate = opt('effectiveDate');
    if (!isDate(effectiveDate)) errors.push('Enter the date it applies from as YYYY-MM-DD.');
    next = { ...sug, fullName, values: checked.values, effectiveDate };
  } else if (sug.kind === 'role') {
    const role = pick(ROLES, get('role'));
    if (!role) errors.push('Choose a role.');
    const startDate = opt('startDate');
    const endDate = opt('endDate');
    if (!isDate(startDate) || !isDate(endDate)) errors.push('Enter dates as YYYY-MM-DD.');
    else if (startDate && endDate && endDate < startDate)
      errors.push('The end date is before the start date.');
    const cessation = endDate ? (pick(CESSATIONS, get('cessation')) ?? 'other_cessation') : null;
    next = { ...sug, role: role ?? sug.role, startDate, endDate, cessation };
  } else if (sug.kind === 'shares') {
    const checked = checkShares({
      shares: get('shares'),
      amountPayable: opt('amountPayable'),
      amountPaid: opt('amountPaid'),
      date: get('date'),
    });
    errors.push(...checked.errors);
    const className = get('className');
    if (!className) errors.push('Enter the share class.');
    next = {
      ...sug,
      className,
      classKind: pick(CLASS_KINDS, get('classKind')) ?? sug.classKind,
      shares: checked.shares,
      amountPayable: checked.amountPayable,
      amountPaid: checked.amountPaid,
      consideration: pick(CONSIDERATIONS, get('consideration')),
      date: get('date'),
    };
  } else {
    const { fields, errors: problems } = checkCharge({
      registeredNumber: get('registeredNumber'),
      registeredOn: get('registeredOn'),
      nature: get('nature'),
      chargee: get('chargee'),
      amount: get('amount'),
      dischargedOn: opt('dischargedOn'),
    });
    errors.push(...problems);
    next = { ...sug, ...fields };
  }
  return { next, errors };
}
