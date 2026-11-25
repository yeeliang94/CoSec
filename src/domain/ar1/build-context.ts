import type { CompanyRelationship, ParticularKey, Person } from '../resolution/model';
import {
  addressOf,
  CORPORATE_ANALYSES,
  INDIVIDUAL_ANALYSES,
  MALAYSIA,
  PASSPORT,
  particularsAt,
} from '../resolution/particulars';
import { isAddressComplete, type Address } from '../address';
import { companyParticularsAt, type CompanyParticularKey } from './company';
import { replay, SHARE_KINDS, type Holder, type ShareKind } from './shares';
import { mtoolDate } from './returns';
import type {
  AddressCells,
  BuildInput,
  IdentityCells,
  PerKind,
  ReturnIssue,
  ReturnSection,
  FixTarget,
} from './data';

export const cellsOf = (a: Address): AddressCells => [
  a.Line1,
  a.Line2,
  a.Line3,
  a.Postcode,
  a.Town,
  a.State,
  a.Country,
];
export const emptyCells = (): AddressCells => ['', '', '', '', '', '', ''];

export const ALL_ANALYSES = [...INDIVIDUAL_ANALYSES, ...CORPORATE_ANALYSES] as const;
const MALAY_NATIVE = ['MALAY'];
const NON_NATIVE = ['CHINESE', 'INDIAN', 'OTHER RACE'];
/** Section F analysis for one party: decided by nationality and race where certain, else chosen. */
export function analysisFor(person: Person | undefined, asAt: string): string {
  if (!person) return '';
  const values = particularsAt(person, asAt);
  if (person.kind === 'organisation')
    return (CORPORATE_ANALYSES as readonly string[]).includes(values.analysis ?? '')
      ? values.analysis!
      : '';
  if (values.nationality && values.nationality !== MALAYSIA) return 'Non-citizens';
  if (values.nationality === MALAYSIA) {
    if (MALAY_NATIVE.includes(values.race ?? '')) return INDIVIDUAL_ANALYSES[0];
    if (NON_NATIVE.includes(values.race ?? '')) return INDIVIDUAL_ANALYSES[1];
  }
  return (INDIVIDUAL_ANALYSES as readonly string[]).includes(values.analysis ?? '')
    ? values.analysis!
    : '';
}
/** Whether the secretary must choose the analysis for this individual (no default). */
export function choosesAnalysis(person: Person | undefined, asAt: string) {
  if (!person || person.kind === 'organisation') return false;
  const v = particularsAt(person, asAt);
  return (
    v.nationality === MALAYSIA && !!v.race && ![...MALAY_NATIVE, ...NON_NATIVE].includes(v.race)
  );
}

/** "202001012345 (1365432-A)" splits into the 12-digit new number and the old one. */
export function splitRegistrationNumber(value: string) {
  const fresh = /\b(\d{12})\b/.exec(value)?.[1] ?? '';
  const old = /\(([^)]+)\)/.exec(value)?.[1]?.trim() ?? (fresh ? '' : value.trim());
  return { fresh, old };
}

export const activeOn = (r: CompanyRelationship, asAt: string) =>
  (!r.startDate || r.startDate <= asAt) && (!r.endDate || r.endDate > asAt);

/** Identity particulars every officer and individual member needs on the return. */
export const IDENTITY: ParticularKey[] = [
  'identityType',
  'identityNumber',
  'nationality',
  'race',
  'gender',
  'dateOfBirth',
];

export type HolderRow = { holder: Holder; shares: bigint; kinds: Set<ShareKind> };

/**
 * What every section reads, worked out once from the build input as at the return date: the
 * company particulars, the register replayed to that date, and the officers then in office.
 */
export type BuildContext = {
  input: BuildInput;
  asAt: string;
  cp: Partial<Record<CompanyParticularKey, string>>;
  isPublic: boolean;
  register: ReturnType<typeof replay>;
  /** Shares in each kind, summed over the classes of that kind. */
  sumByKind: (pick: (classId: string) => bigint) => PerKind<bigint>;
  treasury: PerKind<bigint>;
  issuedTotal: bigint;
  /** Holders with shares on the return date, by holder key, in register order. */
  holders: Map<string, HolderRow>;
  officers: CompanyRelationship[];
};

export function buildContext(input: BuildInput): BuildContext {
  const asAt = input.record.returnDate;
  const cp = companyParticularsAt(input.profile.particulars, asAt);
  const classes = input.profile.shareClasses ?? [];
  const kindOf = new Map(classes.map((c) => [c.id, c.kind]));
  const register = replay(input.entries, asAt);
  const { state } = register;
  const sumByKind = (pick: (classId: string) => bigint) => {
    const out: PerKind<bigint> = { Ordinary: 0n, Preference: 0n, Other: 0n };
    for (const c of classes) out[c.kind] += pick(c.id);
    return out;
  };
  const issued = (id: string) => state.issued.get(id);
  const cash = sumByKind((id) => issued(id)?.cash ?? 0n);
  const otherwise = sumByKind((id) => issued(id)?.otherwise ?? 0n);
  const holders = new Map<string, HolderRow>();
  for (const h of state.holdings) {
    if (h.shares <= 0n) continue;
    const row = holders.get(h.key) ?? { holder: h.holder, shares: 0n, kinds: new Set() };
    row.shares += h.shares;
    row.kinds.add(kindOf.get(h.classId) ?? 'Ordinary');
    holders.set(h.key, row);
  }
  return {
    input,
    asAt,
    cp,
    isPublic: cp.status === 'Public company',
    register,
    sumByKind,
    treasury: sumByKind((id) => state.treasury.get(id) ?? 0n),
    issuedTotal: SHARE_KINDS.reduce((n, k) => n + cash[k] + otherwise[k], 0n),
    holders,
    officers: input.relationships.filter((r) => activeOn(r, asAt)),
  };
}

/** Collects one section's issues. */
export function issueList(section: ReturnSection) {
  const issues: ReturnIssue[] = [];
  return {
    issues,
    missing: (message: string, target: FixTarget) =>
      issues.push({ section, severity: 'missing', message, target }),
    blocker: (message: string, target: FixTarget) =>
      issues.push({ section, severity: 'blocker', message, target }),
  };
}

/** One person's identity columns as at the return date. */
export function identityCells(person: Person, asAt: string): IdentityCells {
  const v = particularsAt(person, asAt);
  return {
    title: v.title ?? '',
    name: person.fullName,
    idType: v.identityType ?? '',
    idNumber: v.identityNumber ?? '',
    passportExpiry: v.identityType === PASSPORT ? mtoolDate(v.passportExpiry) : '',
    nationality: v.nationality ?? '',
    race: v.race ?? '',
    gender: v.gender ?? '',
    dateOfBirth: mtoolDate(v.dateOfBirth),
  };
}

export type AddressGroupName = 'residential' | 'service' | 'business' | 'registered';
/**
 * Lists one person's missing particulars for a role as a single issue, with the keys a fix panel
 * opens. An address counts as missing until it is complete as mTool checks it.
 */
export function requireParticulars(
  missing: (message: string, target: FixTarget) => void,
  asAt: string,
  person: Person,
  role: CompanyRelationship['role'],
  keys: ParticularKey[],
  addresses: AddressGroupName[] = [],
) {
  const v = particularsAt(person, asAt);
  const absent = keys.filter((k) => !v[k]);
  if (v.identityType === PASSPORT && !v.passportExpiry && keys.includes('identityNumber'))
    absent.push('passportExpiry');
  for (const group of addresses)
    if (!isAddressComplete(addressOf(v, group)))
      absent.push(
        group === 'service' && !v.serviceSameAsResidential
          ? 'serviceLine1'
          : (`${group}Line1` as ParticularKey),
      );
  if (absent.length)
    missing(
      `${person.fullName}: ${absent.length} particular${absent.length > 1 ? 's' : ''} missing.`,
      { kind: 'person', id: person.id, keys: absent, roles: [role] },
    );
}
