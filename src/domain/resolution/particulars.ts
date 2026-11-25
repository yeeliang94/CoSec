import { isCalendarDate, valueAt } from './records';
import {
  addressProblems,
  ADDRESS_PARTS,
  formatAddress,
  isAddressEmpty,
  type Address,
  type AddressPart,
} from '../address';
import {
  ADDRESS_GROUPS,
  PARTICULAR_KEYS,
  TEMPLATE_PARTICULARS,
  type AddressGroup,
  type DatedValue,
  type ParticularKey,
  type Person,
  type PersonKind,
  type PersonSnapshot,
  type RecordProperty,
  type ResolutionContext,
  type TemplateParticular,
} from './model';
import {
  COUNTRIES,
  GENDERS,
  NATIONALITIES,
  ORGANISATION_ID_TYPES,
  PERSON_ID_TYPES,
  PROFESSIONAL_TYPES,
  RACES,
  STATES,
  TITLES,
} from '../ar1/mtool-lists';

export {
  COUNTRIES,
  GENDERS,
  NATIONALITIES,
  ORGANISATION_ID_TYPES,
  PERSON_ID_TYPES,
  RACES,
  STATES,
  TITLES,
};
/** mTool calls the secretary's professional body its "professional type". */
export const PROFESSIONAL_BODIES = PROFESSIONAL_TYPES;

/**
 * Section F analysis of shareholdings, in mTool's AR1 wording (DropdownCustomizations.xml).
 * An individual member takes one of the first three; a body corporate one of the last three.
 */
export const INDIVIDUAL_ANALYSES = [
  'Citizens who are Malays and natives',
  'Citizens who are non-Malays and non-natives',
  'Non-citizens',
] as const;
export const CORPORATE_ANALYSES = [
  'Bodies corporate controlled by citizens who are Malays and natives',
  'Bodies corporate controlled by citizens who are non-Malays and non-natives',
  'Bodies corporate controlled by non-citizens',
] as const;

/** Identity types whose numbers are 12 digits, stored without dashes as mTool does. */
export const TWELVE_DIGIT_IDS = ['MyKad', 'MyPR', 'MyKAS'] as const;
export const PASSPORT = 'Passport number';
export const MALAYSIA = 'MALAYSIA';

const ADDRESS_GROUP_LABELS: Record<AddressGroup, string> = {
  residential: 'Residential address',
  service: 'Service address',
  business: 'Business address',
  registered: 'Registered office',
};
const ADDRESS_PART_LABELS: Record<AddressPart, string> = {
  Line1: 'line 1',
  Line2: 'line 2',
  Line3: 'line 3',
  Postcode: 'postcode',
  Town: 'town',
  State: 'state',
  Country: 'country',
};
export const addressKey = (group: AddressGroup, part: AddressPart) =>
  `${group}${part}` as ParticularKey;
export const addressKeys = (group: AddressGroup) => ADDRESS_PARTS.map((p) => addressKey(group, p));
export const addressGroupLabel = (group: AddressGroup) => ADDRESS_GROUP_LABELS[group];
/** The group an address part key belongs to, or null for other particulars. */
export function addressGroupOf(key: ParticularKey): AddressGroup | null {
  return (
    ADDRESS_GROUPS.find(
      (g) => key.startsWith(g) && key !== 'serviceSameAsResidential' && key !== 'serviceEmail',
    ) ?? null
  );
}

/** Built-in person particulars: labels, mTool option wording, validation and masking. */
export const PARTICULAR_LABELS = {
  title: 'Title',
  identityType: 'ID type',
  identityNumber: 'ID number',
  passportExpiry: 'Passport expiry date',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  race: 'Race',
  nationality: 'Nationality',
  analysis: 'Shareholding analysis',
  occupation: 'Occupation',
  ...Object.fromEntries(
    ADDRESS_GROUPS.flatMap((g) =>
      ADDRESS_PARTS.map((p) => [
        addressKey(g, p),
        `${ADDRESS_GROUP_LABELS[g]} ${ADDRESS_PART_LABELS[p]}`,
      ]),
    ),
  ),
  serviceSameAsResidential: 'Service address same as residential',
  serviceEmail: 'Email',
  secretaryBody: 'Professional type',
  secretaryLicence: 'Licence or membership number',
  practisingCertificate: 'SSM practising certificate number',
  auditFirmNumber: 'Audit firm number',
  placeOfIncorporation: 'Place of incorporation',
} as Record<ParticularKey, string>;

/** Labels that read better for an organisation. */
export function particularLabel(key: ParticularKey, kind: PersonKind = 'individual'): string {
  if (kind === 'organisation') {
    if (key === 'identityNumber') return 'Registration number';
    if (key === 'analysis') return 'Controlled by';
  }
  return PARTICULAR_LABELS[key];
}

/** Lower-case names of the person properties a template field can show. */
export const RECORD_PROPERTY_LABELS: Record<RecordProperty, string> = {
  name: 'name',
  capacity: 'capacity',
  appointedOn: 'appointed on',
  ceasedOn: 'ceased on',
  title: 'title',
  identityType: 'ID type',
  identityNumber: 'ID number',
  passportExpiry: 'passport expiry date',
  dateOfBirth: 'date of birth',
  gender: 'gender',
  race: 'race',
  nationality: 'nationality',
  occupation: 'occupation',
  residentialAddress: 'residential address',
  serviceAddress: 'service address',
  businessAddress: 'business address',
  registeredAddress: 'registered office',
  serviceEmail: 'email',
  secretaryBody: 'professional type',
  secretaryLicence: 'licence or membership number',
  practisingCertificate: 'SSM practising certificate number',
  auditFirmNumber: 'audit firm number',
  placeOfIncorporation: 'place of incorporation',
  otherDirectorships: 'other directorships',
};

/** A person snapshot with identity values masked, for staff without `view_identity`. */
export function maskSnapshot(person: PersonSnapshot): PersonSnapshot {
  if (!person.particulars) return person;
  const { identityNumber, passportExpiry: _p, dateOfBirth: _d, ...rest } = person.particulars;
  return {
    ...person,
    particulars: {
      ...rest,
      ...(identityNumber ? { identityNumber: maskIdentity(identityNumber) } : {}),
    },
  };
}
/** Every selector pool of a resolution context with identity values masked. */
export function maskContext(ctx: ResolutionContext): ResolutionContext {
  const mask = (list: PersonSnapshot[] | undefined) => list?.map(maskSnapshot);
  return {
    ...ctx,
    directors: mask(ctx.directors)!,
    members: mask(ctx.members)!,
    companyPeople: mask(ctx.companyPeople)!,
    proposedPeople: mask(ctx.proposedPeople)!,
    ...(ctx.secretaries ? { secretaries: mask(ctx.secretaries) } : {}),
  };
}

/** Identity particulars hidden from staff without `view_identity` and never written to audit. */
export const IDENTITY_KEYS = ['identityNumber', 'passportExpiry', 'dateOfBirth'] as const;
/** Particulars holding a `YYYY-MM-DD` date. */
export const DATE_PARTICULARS: readonly ParticularKey[] = ['passportExpiry', 'dateOfBirth'];

/** Particulars restricted to a fixed list; the value must be one of these exact strings. */
export function particularOptions(
  key: ParticularKey,
  kind: PersonKind = 'individual',
): readonly string[] | null {
  if (key === 'identityType')
    return kind === 'organisation' ? ORGANISATION_ID_TYPES : PERSON_ID_TYPES;
  if (key === 'analysis') return kind === 'organisation' ? CORPORATE_ANALYSES : INDIVIDUAL_ANALYSES;
  if (key.endsWith('Country') || key === 'placeOfIncorporation') return COUNTRIES;
  if (key.endsWith('State') && addressGroupOf(key)) return STATES;
  const fixed: Partial<Record<ParticularKey, readonly string[]>> = {
    title: TITLES,
    gender: GENDERS,
    race: RACES,
    nationality: NATIONALITIES,
    secretaryBody: PROFESSIONAL_BODIES,
    serviceSameAsResidential: ['Yes'],
  };
  return fixed[key] ?? null;
}

export type ParticularValues = Partial<Record<ParticularKey, string | null | undefined>>;
export type ParticularIssue = {
  key: ParticularKey;
  message: string;
  severity: 'error' | 'warning';
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The particulars in force on `asAt`, keeping only non-empty text. */
export function particularsAt(
  person: Pick<Person, 'particulars'>,
  asAt: string,
): Partial<Record<ParticularKey, string>> {
  const out: Partial<Record<ParticularKey, string>> = {};
  for (const key of PARTICULAR_KEYS) {
    const value = valueAt(person.particulars?.[key], asAt);
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

export type { Address };
export { formatAddress, isAddressEmpty };
/** One address group as parts; a service address marked "same as residential" reads the residential one. */
export function addressOf(values: ParticularValues, group: AddressGroup): Address {
  const source =
    group === 'service' && values.serviceSameAsResidential === 'Yes' ? 'residential' : group;
  return Object.fromEntries(
    ADDRESS_PARTS.map((p) => [p, (values[addressKey(source, p)] ?? '').trim()]),
  ) as Address;
}

/** The particulars a template prints, with each address joined into one line. */
export function templateParticulars(
  person: Pick<Person, 'particulars'>,
  asAt: string,
): Partial<Record<TemplateParticular, string>> {
  const values = particularsAt(person, asAt);
  const out: Partial<Record<TemplateParticular, string>> = {};
  for (const key of TEMPLATE_PARTICULARS) {
    const group = key.endsWith('Address')
      ? (key.slice(0, -'Address'.length) as AddressGroup)
      : null;
    const value = group
      ? formatAddress(addressOf(values, group))
      : key === 'identityNumber' && values.identityNumber
        ? formatIdentity(values.identityType, values.identityNumber)
        : values[key as ParticularKey];
    if (value) out[key] = value;
  }
  return out;
}

/** `880516145888` becomes `880516-**-****`; other values keep two characters at each end. */
export function maskIdentity(value: string): string {
  const digits = /^(\d{6})-?\d{2}-?\d{4}$/.exec(value);
  if (digits) return `${digits[1]}-**-****`;
  if (value.length <= 4) return '*'.repeat(value.length);
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}
/** A 12-digit number shown as YYMMDD-PB-###G for reading; stored without dashes. */
export function formatIdentity(type: string | undefined, value: string): string {
  return (TWELVE_DIGIT_IDS as readonly string[]).includes(type ?? '') && /^\d{12}$/.test(value)
    ? `${value.slice(0, 6)}-${value.slice(6, 8)}-${value.slice(8)}`
    : value;
}
/** What is stored for an entered ID number: 12-digit types lose dashes and spaces. */
export function normaliseIdentity(type: string | null | undefined, value: string): string {
  return (TWELVE_DIGIT_IDS as readonly string[]).includes(type ?? '')
    ? value.replace(/[\s-]/g, '')
    : value.trim();
}

/** The MyKad's YYMMDD part as a calendar date, trying both centuries; empty when it is not one. */
function birthDates(yymmdd: string) {
  const [yy, mm, dd] = [yymmdd.slice(0, 2), yymmdd.slice(2, 4), yymmdd.slice(4, 6)];
  return ['19', '20'].map((c) => `${c}${yy}-${mm}-${dd}`).filter(isCalendarDate);
}

/**
 * Checks one person's particulars as they would stand together. Errors block a save; warnings
 * never do. Completeness for the annual return is checked separately, as at the return date.
 */
export function validateParticulars(
  values: ParticularValues,
  kind: PersonKind = 'individual',
): ParticularIssue[] {
  const issues: ParticularIssue[] = [];
  const error = (key: ParticularKey, message: string) =>
    issues.push({ key, message, severity: 'error' });
  const get = (key: ParticularKey) => {
    const value = values[key];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  };
  for (const key of PARTICULAR_KEYS) {
    const value = get(key);
    if (!value) continue;
    if (value.length > 255) error(key, 'Enter up to 255 characters.');
    const options = particularOptions(key, kind);
    if (options && !options.includes(value)) error(key, 'Choose one of the listed options.');
    if (DATE_PARTICULARS.includes(key) && !isCalendarDate(value))
      error(key, 'Enter a calendar date (YYYY-MM-DD).');
  }
  const type = get('identityType');
  const number = get('identityNumber');
  if (number && !type) error('identityType', 'Choose the ID type.');
  if (number && (TWELVE_DIGIT_IDS as readonly string[]).includes(type)) {
    const digits = normaliseIdentity(type, number);
    if (!/^\d{12}$/.test(digits))
      error('identityNumber', `Enter the ${type} number as 12 digits, for example 880516145888.`);
    else if (type === 'MyKad') {
      const births = birthDates(digits.slice(0, 6));
      if (!births.length)
        error('identityNumber', 'The first six digits of the MyKad are not a date of birth.');
      const dob = get('dateOfBirth');
      if (births.length && isCalendarDate(dob) && !births.includes(dob))
        issues.push({
          key: 'dateOfBirth',
          message: 'The date of birth does not match the MyKad.',
          severity: 'warning',
        });
    }
  }
  if (get('passportExpiry') && type !== PASSPORT)
    error('passportExpiry', 'A passport expiry date applies only to a passport.');
  const email = get('serviceEmail');
  if (email && !EMAIL.test(email)) error('serviceEmail', 'Enter an email address.');
  for (const group of ADDRESS_GROUPS) {
    if (group === 'service' && get('serviceSameAsResidential') === 'Yes') continue;
    // Country and state values are already checked against mTool's lists above.
    const label = ADDRESS_GROUP_LABELS[group].toLowerCase();
    for (const p of addressProblems(addressOf(values, group), { label, checkLists: false }))
      error(addressKey(group, p.part), p.message);
  }
  return issues;
}

// ---------------------------------------------------------------- legacy particulars
/** Particulars stored before 16 Nov 2026 used these keys and wordings. */
const LEGACY_ID_TYPES: Record<string, string> = { NRIC: 'MyKad', Passport: PASSPORT };
const LEGACY_GENDERS: Record<string, string> = { MALE: 'Male', FEMALE: 'Female' };
const LEGACY_ADDRESSES = { residentialAddress: 'residential', serviceAddress: 'service' } as const;

/**
 * Converts particulars recorded in the first director-forms shape: NRIC and Passport become
 * mTool's MyKad and Passport number (12-digit numbers lose their dashes), MALE and FEMALE become
 * Male and Female, and a free-text address is split into lines 1 to 3, with any further lines
 * joined onto line 3. Postcode, town, state and country are never guessed from free text, so a
 * converted address stays incomplete until someone enters them. Returns null when nothing changes.
 */
export function upgradeLegacyParticulars(
  particulars: Record<string, DatedValue[] | undefined> | undefined,
): Person['particulars'] | null {
  if (!particulars) return null;
  let changed = false;
  const out: Record<string, DatedValue[]> = {};
  for (const [key, list] of Object.entries(particulars)) {
    if (!list) continue;
    if (key in LEGACY_ADDRESSES) {
      changed = true;
      const group = LEGACY_ADDRESSES[key as keyof typeof LEGACY_ADDRESSES];
      for (const entry of list) {
        const lines =
          typeof entry.value === 'string'
            ? entry.value
                .split(/\r?\n|,\s*/)
                .map((l) => l.trim())
                .filter(Boolean)
            : [];
        const parts = [lines[0] ?? null, lines[1] ?? null, lines.slice(2).join(', ') || null];
        (['Line1', 'Line2', 'Line3'] as const).forEach((part, i) => {
          const target = addressKey(group, part);
          (out[target] ??= []).push({ ...entry, value: parts[i] });
        });
      }
      continue;
    }
    const mapped = list.map((entry) => {
      if (typeof entry.value !== 'string') return entry;
      let value = entry.value;
      if (key === 'identityType') value = LEGACY_ID_TYPES[value] ?? value;
      if (key === 'gender') value = LEGACY_GENDERS[value] ?? value;
      return value === entry.value ? entry : { ...entry, value };
    });
    if (key === 'identityNumber') {
      // The ID type in force at each entry decides whether dashes go.
      const types = particulars.identityType ?? [];
      for (let i = 0; i < mapped.length; i++) {
        const entry = mapped[i];
        const type = valueAt(types, entry.effectiveDate);
        const upgraded = typeof type === 'string' ? (LEGACY_ID_TYPES[type] ?? type) : null;
        if (typeof entry.value === 'string') {
          const value = normaliseIdentity(upgraded, entry.value);
          if (value !== entry.value) mapped[i] = { ...entry, value };
        }
      }
    }
    if (mapped.some((entry, i) => entry !== list[i])) changed = true;
    // Entries for a key keep their order; lists merge in recording order below.
    out[key] = [...(out[key] ?? []), ...mapped];
  }
  if (!changed) return null;
  for (const key of Object.keys(out))
    out[key].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  return out as Person['particulars'];
}
