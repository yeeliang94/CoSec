import type { Company } from '../model';
import type {
  CompanyProfile,
  CompanyRelationship,
  ParticularKey,
  Person,
} from '../resolution/model';
import type { CompanyParticularKey } from './company';
import type { Charge } from './charges';
import type { ShareEntry, ShareKind } from './shares';
import type { AnnualReturn } from './returns';

// ---------------------------------------------------------------- output shape
/** One address as mTool's columns hold it: line 1 to 3, postcode, town, state, country. */
export type AddressCells = [string, string, string, string, string, string, string];
export type PerKind<T> = Record<ShareKind, T>;

export type IdentityCells = {
  title: string;
  name: string;
  idType: string;
  idNumber: string;
  passportExpiry: string;
  nationality: string;
  race: string;
  gender: string;
  dateOfBirth: string;
};
export type DirectorRow = IdentityCells & {
  /** The person the row is about, for the screens; never written to the workbook. */
  personId: string;
  designation: string;
  alternateTo: string;
  residential: AddressCells;
  service: AddressCells;
  email: string;
  occupation: string;
  otherDirectorships: string;
};
export type ManagerRow = IdentityCells & {
  personId: string;
  residential: AddressCells;
  business: AddressCells;
  occupation: string;
};
export type SecretaryRow = ManagerRow & {
  professionalType: string;
  licenceNumber: string;
  practisingCertificate: string;
};
export type AuditorRow = {
  personId: string;
  firmNumber: string;
  name: string;
  address: AddressCells;
};
export type MemberRow = IdentityCells & {
  reference: string;
  memberType: string;
  trusteeType: string;
  address: AddressCells;
  shares: string;
  typesOfShares: string;
  analysis: string;
  /** The holder's parties (several for joint holders), for the screens. */
  partyIds: string[];
  /** The holder key of a joint holding, for choosing its analysis on the return. */
  holderKey?: string;
};
export type SubclassificationRow = IdentityCells & {
  reference: string;
  type: string;
  address: AddressCells;
  /**
   * The party the row describes: one joint holder. Empty for the subject of a trust holding, who
   * is recorded on the share entry rather than as a person.
   */
  partyIds: string[];
};
export type ChargeRow = {
  registeredNumber: string;
  /** mTool's dd/mm/yyyy, as the workbook takes it. */
  registeredOn: string;
  /** The same date as YYYY-MM-DD, for the screens. */
  registeredIso: string;
  nature: string;
  chargee: string;
  amount: string;
};

/** Every value the workbook builder writes, in mTool's wording and formats. */
export type Ar1Data = {
  filingInfo: FilingInfo;
  a: {
    registered: AddressCells;
    membersRegister: AddressCells;
    financialRecords: AddressCells;
    principal: AddressCells;
    phone: string;
    fax: string;
    email: string;
    website: string;
    natureOfBusiness: string;
    msic: { code: string; description: string }[];
    branches: {
      address: AddressCells;
      phone: string;
      fax: string;
      email: string;
      website: string;
    }[];
  };
  b: {
    cash: PerKind<string>;
    otherwise: PerKind<string>;
    forfeited: PerKind<string>;
    treasury: PerKind<string>;
    fullyPaid: PerKind<string>;
    partlyPaid: PerKind<string>;
    calledUp: PerKind<string>;
    callsReceived: PerKind<string>;
    consideredPaidFullyPaid: PerKind<string>;
    consideredPaidPartlyPaid: PerKind<string>;
    callsUnpaid: PerKind<string>;
    paidOnForfeited: PerKind<string>;
    commission: string;
    discount: string;
    notesOnShares: string;
    notesOnDebentures: string;
  };
  c: { charges: ChargeRow[]; notes: string };
  d: {
    directors: DirectorRow[];
    managers: ManagerRow[];
    secretaries: SecretaryRow[];
    auditors: AuditorRow[];
  };
  e: { members: MemberRow[]; subclassification: SubclassificationRow[] };
  /** Section F fills itself from E in the workbook; these totals are for the app's check. */
  f: { byAnalysis: Record<string, string>; unclassified: string; total: string };
  g: {
    unclaimedMoneys: string;
    transfersRegistered: string;
    noPublicInvitation: string;
    overFifty: string;
    overFiveHundred: string;
    boStatus: string;
    boExemptCategory: string;
    nomineeStatus: string;
  };
};

/** FilingInfo column E, rows 11 to 27, as the blank must hold them for this return. */
export const FILING_ROWS = {
  newRegistrationNumber: 11,
  oldRegistrationNumber: 12,
  name: 13,
  formerName: 14,
  gstNumber: 15,
  calendarYear: 16,
  dateOfReturn: 17,
  origin: 18,
  status: 19,
  companyType: 20,
  application: 21,
  rectificationDeclaration: 22,
  courtOrderReference: 23,
  submissionType: 24,
  firstReturn: 25,
  sharesQuoted: 26,
  numberOfMembers: 27,
} as const;
export type FilingField = keyof typeof FILING_ROWS;
export type FilingInfo = Record<FilingField, string>;
export const FILING_LABELS: Record<FilingField, string> = {
  newRegistrationNumber: 'New registration number',
  oldRegistrationNumber: 'Old registration number',
  name: 'Company name',
  formerName: 'Former name',
  gstNumber: 'GST registration number',
  calendarYear: 'Calendar year',
  dateOfReturn: 'Date of annual return',
  origin: 'Origin of company',
  status: 'Status of company',
  companyType: 'Type of company',
  application: 'Application of submission',
  rectificationDeclaration: 'Statutory declaration for rectification',
  courtOrderReference: 'Court order reference',
  submissionType: 'Type of submission',
  firstReturn: 'First annual return since incorporation',
  sharesQuoted: 'Shares quoted on a stock exchange',
  numberOfMembers: 'Number of members',
};

// ---------------------------------------------------------------- issues
export type ReturnSection = 'Filing' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type FixTarget =
  | { kind: 'person'; id: string; keys: ParticularKey[]; roles: CompanyRelationship['role'][] }
  | { kind: 'company'; keys: CompanyParticularKey[] }
  | { kind: 'answer'; field: string }
  | { kind: 'shares' }
  /** The company's officers: appoint a director or secretary. */
  | { kind: 'officers' }
  | { kind: 'appointment'; relationshipId: string };
export type ReturnIssue = {
  section: ReturnSection;
  /** "missing": mTool will reject the workbook until it is filled. "blocker": the figures disagree. */
  severity: 'missing' | 'blocker';
  message: string;
  target: FixTarget;
};
/** What each section builder returns. */
export type Built<T> = { data: T; issues: ReturnIssue[] };

// ---------------------------------------------------------------- inputs
/**
 * A directorship held at another company on the return date. `registrationNumber` is empty when
 * it is not known (a hand-entered directorship that names no number).
 */
export type OtherDirectorshipCell = { registrationNumber: string; name: string };

export type BuildInput = {
  company: Company;
  profile: CompanyProfile;
  record: Pick<
    AnnualReturn,
    | 'calendarYear'
    | 'returnDate'
    | 'firstReturn'
    | 'lastReturnDate'
    | 'application'
    | 'rectificationDeclaration'
    | 'courtOrderReference'
    | 'answers'
  >;
  people: Map<string, Person>;
  relationships: CompanyRelationship[];
  /** Other directorships per person, in force on the return date. */
  otherDirectorships: Map<string, OtherDirectorshipCell[]>;
  entries: ShareEntry[];
  charges: Charge[];
};
