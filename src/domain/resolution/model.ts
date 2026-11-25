/**
 * Shared contracts for the resolution builder (RESOLUTION_BUILDER_IMPLEMENTATION_PLAN.md §5).
 * Every lane builds against these types; change them only through the coordinator.
 * "Clause" is a reusable resolution item. It is never a corporate event or an audit entry.
 */
import type { Branch, CompanyParticulars } from '../ar1/company';
import type { ShareClass } from '../ar1/shares';

// ---------------------------------------------------------------- output types
/** Who the document speaks for; 'individual' is a form one person makes about themselves. */
export type ResolutionBody = 'directors' | 'members' | 'individual';
export type OutputType = {
  id: string; // stable, e.g. 'directors_written'
  name: string; // presentation only
  body: ResolutionBody;
  active: boolean;
  order: number;
};

// ---------------------------------------------------------------- document model (schema v1)
export const TEMPLATE_SCHEMA_VERSION = 1;
export type Mark = 'bold' | 'italic' | 'underline' | 'strike';
export type Align = 'left' | 'center' | 'right' | 'justify';
export type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  /**
   * A field reference by stable id. Inside a repeat over a record collection, a reference to the
   * collection field with `property` resolves against the current item (for example its name).
   */
  | { type: 'field'; fieldId: string; property?: RecordProperty }
  /**
   * A `choice` field printed as every option label in option order, joined by `separator`
   * (default "/"). `strikeOthers` strikes the options not chosen; `omitOthers` prints only the
   * chosen one.
   */
  | {
      type: 'choiceText';
      fieldId: string;
      style: 'strikeOthers' | 'omitOthers';
      separator?: string;
    }
  /** A `boolean` field printed as a tick box: ☑ when true, ☐ otherwise. */
  | { type: 'checkbox'; fieldId: string }
  | { type: 'hardBreak' };
/** How a table draws its lines. Absent means 'grid'. */
export type TableBorder = 'grid' | 'none' | 'outer';
export type PageOrientation = 'portrait' | 'landscape';
export type Predicate =
  | {
      op: 'isTrue' | 'isFalse' | 'isEmpty' | 'isNotEmpty';
      fieldId: string;
    }
  | { op: 'equals' | 'notEquals' | 'includes'; fieldId: string; value: string }
  | { op: 'and' | 'or'; all: Predicate[] };
export type BlockNode =
  | { type: 'paragraph'; align?: Align; indent?: number; content: InlineNode[] }
  | { type: 'heading'; level: 1 | 2 | 3; align?: Align; content: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: BlockNode[][] }
  | {
      type: 'table';
      /** Percentages that add up to 100, one per column. */
      columnWidths?: number[];
      border?: TableBorder;
      rows: { header?: boolean; cells: BlockNode[][] }[];
    }
  | { type: 'condition'; when: Predicate; content: BlockNode[] }
  /** Repeats `content` once per item of a recordList field, in the preparer's order. */
  | { type: 'repeat'; fieldId: string; content: BlockNode[]; emptyText?: string }
  | { type: 'pageBreak' }
  /**
   * Starts a new page and Word section with this orientation. The running header, footer and
   * page numbering carry on.
   */
  | { type: 'section'; orientation: PageOrientation }
  /** Assemblies only: where the ordered clause wordings go. */
  | { type: 'clauseSlot'; numbering: 'none' | 'decimal' }
  /** Assemblies only: signature area for one signer role. */
  | { type: 'signatureBlock'; role: SignerRole; heading?: string };

// ---------------------------------------------------------------- fields
export type ValueType =
  | 'text'
  | 'multiline'
  | 'date'
  | 'number'
  | 'boolean'
  | 'choice'
  | 'multiChoice'
  | 'recordReference'
  | 'recordList';
/** Properties a field can read from a chosen person; the list is `RECORD_PROPERTIES`. */
export type RecordProperty = (typeof RECORD_PROPERTIES)[number];
/**
 * People a record selector may offer. All are scoped to the case's company and an as-at date;
 * `proposedPerson` allows any person the actor may see (for a new appointee).
 */
export type RecordContext =
  'currentDirectors' | 'currentMembers' | 'companyPeople' | 'companySecretaries' | 'proposedPerson';
export type FieldSource =
  | { kind: 'binding'; path: string } // must be in the binding registry (bindings.ts)
  | { kind: 'question' }
  | { kind: 'constant'; value: string }
  | {
      kind: 'derived';
      op: 'addDays';
      fieldId: string;
      days: number;
      /** Approved source for any legal time limit. Without one, the value is labelled a sample. */
      sourceNote: string;
    }
  | { kind: 'derived'; op: 'sum'; fieldId: string } // per-row number field
  | { kind: 'derived'; op: 'join'; fieldId: string; property: RecordProperty } // names of a list
  | { kind: 'derived'; op: 'count'; fieldId: string };
export type FieldDefinition = {
  id: string; // stable within a template lineage: /^[a-z][a-z0-9_]{1,63}$/
  label: string;
  help?: string;
  valueType: ValueType;
  source: FieldSource;
  /** 'case': shared across clauses in one case and asked once. 'clause': local to the clause. */
  scope: 'case' | 'clause';
  required?: boolean;
  options?: { id: string; label: string }[]; // choice / multiChoice; ids are stable
  record?: { context: RecordContext };
  /** Asked once per item of this recordList field (for example a fee per director). */
  repeatScope?: string;
  format?: {
    date?: 'long' | 'iso';
    /** Exact decimal places for number display; values are kept as decimal strings. */
    decimals?: number;
    prefix?: string;
    case?: 'upper' | 'none';
  };
  defaultValue?: AnswerValue;
  validation?: { min?: string; max?: string; maxLength?: number; mustBeChecked?: boolean };
};
/** Numbers are exact decimal strings. Record ids are person ids. Choice values are option ids. */
export type AnswerValue = string | boolean | string[] | null;
/** Per-row answers are keyed by item (person) id. */
export type Answers = Record<string, AnswerValue | Record<string, AnswerValue>>;

// ---------------------------------------------------------------- templates
export type TemplateStatus = 'Draft' | 'In review' | 'Returned' | 'Published' | 'Superseded';
export const CLAUSE_CATEGORIES = [
  'Director',
  'Secretary',
  'Auditor',
  'Members',
  'Meeting',
  'Dividend',
  'Share capital',
  'Other',
] as const;
export type ClauseCategory = (typeof CLAUSE_CATEGORIES)[number];
export type UsageContext = 'board' | 'director_appointment' | 'director_resignation';
type Reviewed = {
  status: TemplateStatus;
  /** Optimistic revision for draft edits; published versions never change. */
  revision: number;
  schemaVersion: number;
  source: string; // basis/source of wording, e.g. "Fictional sample — not approved wording"
  effectiveDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  returnReason: string | null;
  predecessorId: string | null;
  /** sha256 of the canonical content, set on submission and checked on publication. */
  contentHash: string | null;
  /** Everyone who created or edited this version's content; none of them may publish it. */
  editors?: string[];
};
export type ClauseTemplate = {
  id: string;
  name: string;
  category: ClauseCategory;
  usageContexts: UsageContext[];
  governingAct: string;
  displayOrder: number;
  hidden: boolean;
  archived: boolean;
  description: string;
  createdBy: string;
  createdAt: string;
  revision: number;
};
export type ClauseVersion = Reviewed & {
  id: string;
  clauseId: string;
  version: number;
  /** One fragment per supported output type id. A type with no wording is not offered. */
  wordings: Record<string, BlockNode[]>;
  fields: FieldDefinition[];
};
/**
 * `subject`: the person an individual form is about, who signs it. `witness`: a blank block for a
 * Commissioner for Oaths or similar, who is not a record; it is never chosen or evidenced.
 */
export type SignerRole = 'directors' | 'members' | 'certifiers' | 'subject' | 'witness';
export const SIGNER_ROLES: readonly SignerRole[] = [
  'directors',
  'members',
  'certifiers',
  'subject',
  'witness',
];
/** Roles whose signers the preparer chooses (and whose signed copies are recorded). */
export const CHOSEN_SIGNER_ROLES: readonly SignerRole[] = [
  'directors',
  'members',
  'certifiers',
  'subject',
];
export const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  directors: 'Director',
  members: 'Member',
  certifiers: 'Certified true copy signer',
  subject: 'Person making the declaration',
  witness: 'Witness',
};
export type PageLayout = {
  pageSize: 'A4' | 'Letter';
  marginsMm: { top: number; right: number; bottom: number; left: number };
  fontFamily: 'Arial' | 'Times New Roman' | 'Calibri';
  fontSizePt: number;
  header: InlineNode[];
  footer: InlineNode[];
  pageNumbers: boolean;
};
export type SignatureSettings = {
  columns: 1 | 2 | 3;
  showDate: boolean;
  /** Label under each line; supports the tokens {name} and {capacity}. */
  label: string;
};
export type ResolutionAssembly = {
  id: string;
  name: string;
  outputTypeId: string;
  usageContexts: UsageContext[];
  archived: boolean;
  description: string;
  createdBy: string;
  createdAt: string;
  revision: number;
};
export type AssemblyVersion = Reviewed & {
  id: string;
  assemblyId: string;
  version: number;
  header: BlockNode[];
  closing: BlockNode[];
  signature: SignatureSettings;
  /** Clause template ids in default order; the newest published version is pinned on use. */
  starterClauseIds: string[];
  /** Case-level shared questions such as the resolution date. */
  fields: FieldDefinition[];
  layout: PageLayout;
};

// ---------------------------------------------------------------- people and records
export type PersonKind = 'individual' | 'organisation';
export type Person = {
  id: string;
  /** A body corporate or audit firm (corporate member, auditor). Absent means an individual. */
  kind?: PersonKind;
  fullName: string;
  /** Previous names with the date the correction was recorded; old outputs keep their snapshot. */
  nameHistory: { name: string; until: string; actorId: string; reason: string }[];
  email: string | null;
  notes: string;
  customValues: CustomValues;
  /** Built-in dated particulars (identity, contact, secretary). Absent on older rows. */
  particulars?: Partial<Record<ParticularKey, DatedValue[]>>;
  /** Directorships in companies outside the app; ones inside come from relationships. */
  otherDirectorships?: OtherDirectorship[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Set when the legacy migration could not establish identity reliably. */
  migrationNote?: string;
};
/** Parts of a structured address, as mTool's AR1 columns hold them; the one model is `../address`. */
export { ADDRESS_PARTS } from '../address';
/** Address groups on a person: an organisation's registered office uses `registered`. */
export const ADDRESS_GROUPS = ['residential', 'service', 'business', 'registered'] as const;
export type AddressGroup = (typeof ADDRESS_GROUPS)[number];
export const PARTICULAR_KEYS = [
  'title',
  'identityType',
  'identityNumber',
  'passportExpiry',
  'dateOfBirth',
  'gender',
  'race',
  'nationality',
  'analysis',
  'occupation',
  'residentialLine1',
  'residentialLine2',
  'residentialLine3',
  'residentialPostcode',
  'residentialTown',
  'residentialState',
  'residentialCountry',
  'serviceLine1',
  'serviceLine2',
  'serviceLine3',
  'servicePostcode',
  'serviceTown',
  'serviceState',
  'serviceCountry',
  'businessLine1',
  'businessLine2',
  'businessLine3',
  'businessPostcode',
  'businessTown',
  'businessState',
  'businessCountry',
  'registeredLine1',
  'registeredLine2',
  'registeredLine3',
  'registeredPostcode',
  'registeredTown',
  'registeredState',
  'registeredCountry',
  'serviceSameAsResidential',
  'serviceEmail',
  'secretaryBody',
  'secretaryLicence',
  'practisingCertificate',
  'auditFirmNumber',
  'placeOfIncorporation',
] as const;
export type ParticularKey = (typeof PARTICULAR_KEYS)[number];
/** Particulars a template can print: each address prints as one joined line, not its parts. */
export const TEMPLATE_PARTICULARS = [
  'title',
  'identityType',
  'identityNumber',
  'passportExpiry',
  'dateOfBirth',
  'gender',
  'race',
  'nationality',
  'occupation',
  'residentialAddress',
  'serviceAddress',
  'businessAddress',
  'registeredAddress',
  'serviceEmail',
  'secretaryBody',
  'secretaryLicence',
  'practisingCertificate',
  'auditFirmNumber',
  'placeOfIncorporation',
] as const;
export type TemplateParticular = (typeof TEMPLATE_PARTICULARS)[number];
export const RECORD_PROPERTIES = [
  'name',
  'capacity',
  'appointedOn',
  'ceasedOn',
  ...TEMPLATE_PARTICULARS,
  'otherDirectorships',
] as const;
/** Person properties that hold dates (printed as long dates). */
export const DATE_PROPERTIES: readonly RecordProperty[] = [
  'appointedOn',
  'ceasedOn',
  'passportExpiry',
  'dateOfBirth',
];
export type OtherDirectorship = {
  id: string;
  companyName: string;
  appointedOn: string | null;
  ceasedOn: string | null;
};
export type RelationshipRole =
  'director' | 'member' | 'secretary' | 'manager' | 'auditor' | 'other';
export type CompanyRelationship = {
  id: string;
  companyId: string;
  personId: string;
  role: RelationshipRole;
  /** Configured attribute only (e.g. "Non-executive"); never a statutory appointment by itself. */
  capacity: string;
  startDate: string | null;
  endDate: string | null;
  /** Director relationships are projections of posted officer events and are not edited directly. */
  projectedFrom: { officerEventIds: string[] } | { shareEntryIds: string[] } | null;
  /**
   * Set when the share register ended this hand-entered or carried-over member row: the end date
   * the row had before. The register re-ends the row when its first date moves and restores this
   * end date when it no longer covers the member.
   */
  supersededByRegister?: { originalEndDate: string | null };
  /**
   * A director's designation, principal (when alternate) and nominee flag, for the annual return:
   * the latest recorded. Read a date's value with `appointmentAt`.
   */
  appointment?: DirectorAppointment;
  /**
   * Every recorded value with the date it applies from, oldest first, so a return for an earlier
   * year keeps the value in force on its return date. Absent on records saved before dating, whose
   * one `appointment` applies throughout.
   */
  appointmentHistory?: DatedAppointment[];
  evidenceIds: string[];
  createdBy: string;
  createdAt: string;
  revision: number;
};
/** mTool's AR1 designation wording. */
export const DIRECTOR_DESIGNATIONS = ['Director', 'Alternate director'] as const;
export type DirectorDesignation = (typeof DIRECTOR_DESIGNATIONS)[number];
export type DirectorAppointment = {
  designation: DirectorDesignation;
  /** The principal director's person id when alternate. */
  alternateTo: string | null;
  nominee: boolean;
};
/** A recorded appointment value; `from` null means from the start of the appointment. */
export type DatedAppointment = DirectorAppointment & { from: string | null };

/** The designation in force on `asAt` (YYYY-MM-DD), or undefined when none was recorded by then. */
export function appointmentAt(
  r: Pick<CompanyRelationship, 'appointment' | 'appointmentHistory'>,
  asAt: string,
): DirectorAppointment | undefined {
  if (!r.appointmentHistory) return r.appointment;
  let found: DatedAppointment | undefined;
  for (const a of r.appointmentHistory) if (a.from === null || a.from <= asAt) found = a;
  if (!found) return undefined;
  const { from: _from, ...value } = found;
  return value;
}
export type CustomFieldScope = 'company' | 'person' | 'case';
export type RecordFieldDefinition = {
  id: string;
  scope: CustomFieldScope;
  label: string;
  valueType: 'text' | 'date' | 'number' | 'boolean' | 'choice';
  options?: { id: string; label: string }[];
  version: number;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  revision: number;
};
/** Dated values, newest last. `effectiveDate` is the date the value applies from. */
export type DatedValue = {
  value: string | boolean | null;
  effectiveDate: string;
  definitionVersion?: number;
  recordedAt: string;
  actorId: string;
  reason: string;
};
export type CustomValues = Record<string, DatedValue[]>;
export const CITATION_KEYS = ['directorAuthority', 'memberAuthority', 'electionAuthority'] as const;
export type CitationKey = (typeof CITATION_KEYS)[number];
/** Editable, dated company particulars kept beside the immutable opening record. */
export type CompanyProfile = {
  companyId: string;
  revision: number;
  citations: Partial<Record<CitationKey, DatedValue[]>>;
  customValues: CustomValues;
  /** Dated AR1 particulars: status, type, offices, contact and MSIC codes. Absent on older rows. */
  particulars?: CompanyParticulars;
  branches?: Branch[];
  /** Share classes for the share register; each has a kind for AR1 section B. */
  shareClasses?: ShareClass[];
};

// ---------------------------------------------------------------- resolution cases
export type CaseKind = 'board' | 'director_appointment' | 'director_resignation';
export type StepState = 'Pending' | 'In progress' | 'Waiting' | 'Complete' | 'Not applicable';
/** 'registration' remains only on cases opened while director-change jobs existed. */
export type StepKind =
  'instruction' | 'preparation' | 'review' | 'execution' | 'registration' | 'custom';
export type CaseStep = {
  id: string;
  kind: StepKind;
  label: string;
  ownerId: string;
  state: StepState;
  reason: string | null; // required for Not applicable
  dueDate: string | null;
  completedAt: string | null;
  dependsOn: string[];
  evidenceIds: string[];
};
export type ClauseEntry = {
  /** Stable key for this clause in the case; clause-specific answers are stored under it. */
  key: string;
  clauseId: string;
  clauseVersionId: string;
};
export type CaseClauseSelection = {
  revision: number;
  outputTypeId: string;
  assemblyVersionId: string;
  clauses: ClauseEntry[];
  /** Reasons recorded when a default clause was removed from a case linked to a retired director-change job. */
  removals: { clauseId: string; reason: string; actorId: string; at: string }[];
};
export type ExecutionRequirement = { personId: string; role: SignerRole };
/** Ordered person ids per role; `subject` is absent on cases saved before individual forms. */
export type SignerSelection = Record<Exclude<SignerRole, 'subject' | 'witness'>, string[]> & {
  subject?: string[];
};
export type DecisionRecord = {
  status: 'Not recorded' | 'Passed' | 'Not passed';
  date: string | null;
  evidenceIds: string[];
  actorId: string | null;
  note: string;
};
/** One hand-off of a prepared resolution to another user. */
export type CaseReview = {
  status: 'With reviewer' | 'Returned' | 'Approved';
  reviewerId: string;
  sentBy: string;
  sentAt: string;
  decidedAt: string | null;
  comment: string;
};
export type ResolutionCase = {
  id: string;
  companyId: string;
  kind: CaseKind;
  title: string;
  personId: string | null;
  ownerId: string;
  state: 'Open' | 'Complete' | 'Cancelled';
  cancellationReason: string | null;
  instructionDate: string | null;
  resolutionDate: string | null;
  effectiveDate: string | null;
  customValues: CustomValues;
  steps: CaseStep[];
  selection: CaseClauseSelection | null;
  /** Draft answers, saved against the exact selection revision. */
  answers: {
    selectionRevision: number;
    shared: Answers;
    clauses: Record<string, Answers>;
    /**
     * Answers of clauses that left the selection when the preparer switched to another document
     * of the set, keyed by clause template id. They come back when that clause is chosen again.
     */
    parked?: Record<string, Answers>;
  };
  signers: SignerSelection;
  decision: DecisionRecord;
  /** Absent while the preparer is still drafting. */
  review?: CaseReview | null;
  /** Generated document families; `assemblyId` is the document of the set the family belongs to. */
  families: { id: string; title: string; createdAt: string; assemblyId?: string }[];
  history: { id: string; action: string; actorId: string; at: string; detail: string }[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

// ---------------------------------------------------------------- resolution context
/** Authorised, as-at view of the records a template may bind to. Built by the records lane. */
export type PersonSnapshot = {
  id: string;
  name: string;
  capacity: string;
  appointedOn: string | null;
  ceasedOn: string | null;
  /** Particulars in force on the as-at date (identity values masked for some viewers). */
  particulars?: Partial<Record<TemplateParticular, string>>;
  /** Other directorships, one per line, for printing. */
  otherDirectorships?: string;
};
export type ResolutionContext = {
  /** Historical generation snapshots only. Live resolutions never load retired jobs. */
  job?: { personName: string | null; effectiveDate: string | null; route: string | null } | null;
  asAt: string;
  /** Preparation date in Asia/Kuala_Lumpur, frozen independently of the record as-at date. */
  preparedOn: string;
  firm: {
    name: string;
    registrationNumber?: string;
    address?: string;
    phone?: string;
    email?: string;
  };
  company: {
    id: string;
    name: string;
    registrationNumber: string;
    address: string;
    incorporationDate: string;
    financialYearEnd: string;
    revision: number;
    profileRevision: number;
    citations: Partial<Record<CitationKey, string>>;
    custom: Record<string, string | boolean | null>;
  };
  case: {
    id: string;
    kind: CaseKind;
    title: string;
    revision: number;
    instructionDate: string | null;
    resolutionDate: string | null;
    effectiveDate: string | null;
    custom: Record<string, string | boolean | null>;
  };
  /** Selector pools. Only these ids may be chosen for the matching record context. */
  directors: PersonSnapshot[];
  members: PersonSnapshot[];
  companyPeople: PersonSnapshot[];
  /** Company secretaries in office on the as-at date. */
  secretaries?: PersonSnapshot[];
  /** People visible to the actor for a proposed appointment (no other-company detail). */
  proposedPeople: PersonSnapshot[];
};

// ---------------------------------------------------------------- generated documents
/** The selection entry key a not-yet-added wording uses while it is being previewed. */
export const CANDIDATE_KEY = 'candidate';
/** Where a preview value came from, so the preview can link back to its question. */
export type ResolvedFieldLink = { unit: string; id: string; missing?: boolean };
export type ResolvedInline =
  { text: string; marks?: Mark[]; field?: ResolvedFieldLink } | { break: true };
export type ResolvedBlock = (
  | { type: 'paragraph'; align?: Align; indent?: number; runs: ResolvedInline[]; number?: string }
  | { type: 'heading'; level: 1 | 2 | 3; align?: Align; runs: ResolvedInline[] }
  | { type: 'list'; ordered: boolean; items: ResolvedBlock[][] }
  | {
      type: 'table';
      columnWidths?: number[];
      border?: TableBorder;
      rows: { header?: boolean; cells: ResolvedBlock[][] }[];
    }
  | { type: 'pageBreak' }
  | { type: 'section'; orientation: PageOrientation }
  | {
      type: 'signatures';
      heading?: string;
      columns: 1 | 2 | 3;
      showDate: boolean;
      signers: { name: string; label: string }[];
    }
) & {
  /** Preview only: the selected wording this block belongs to. */
  clauseKey?: string;
};
export type ResolvedDocument = {
  title: string;
  layout: Omit<PageLayout, 'header' | 'footer'> & {
    /** Plain text of the running header and footer (older generations and search). */
    header: string;
    footer: string;
    /** Resolved runs with marks; absent on generations made before header field chips. */
    headerRuns?: ResolvedInline[];
    footerRuns?: ResolvedInline[];
  };
  blocks: ResolvedBlock[];
  /** True when any value is a labelled sample (for example an unsourced date offset). */
  containsSamples: boolean;
};
export type GenerationStatus = 'Pending' | 'Ready' | 'Failed';
export type DocumentGeneration = {
  id: string;
  familyId: string;
  predecessorId: string | null;
  caseId: string;
  companyId: string;
  outputTypeId: string;
  assemblyVersionId: string;
  clauseVersionIds: string[];
  /** The selection entries (answer keys with their pinned versions) used; set on new generations. */
  clauses?: ClauseEntry[];
  selectionRevision: number;
  signers: SignerSelection;
  /** Roles actually rendered, frozen with the generation. Absent on older rows. */
  executionRequirements?: ExecutionRequirement[];
  answers: { shared: Answers; clauses: Record<string, Answers> };
  /**
   * Exactly the authorised values used, with ids/revisions for provenance. Selector pools hold only
   * the people the answers or signers refer to (never the preparer's wider pools).
   */
  snapshot: ResolutionContext;
  resolvedValues: Record<string, string>;
  resolved: ResolvedDocument | null;
  snapshotHash: string;
  rendererVersion: string;
  status: GenerationStatus;
  failure: string | null;
  /** Private document row holding the DOCX bytes, once Ready. */
  documentId: string | null;
  sha256: string | null;
  requestHash: string;
  createdBy: string;
  createdAt: string;
  finalisedAt: string | null;
};
/** Review, issue and execution records against one exact generation (separate rows). */
export type GenerationRecord =
  | {
      id: string;
      kind: 'review';
      generationId: string;
      sha256: string;
      decision: 'Approved' | 'Returned';
      reason: string;
      actorId: string;
      at: string;
    }
  | {
      id: string;
      kind: 'execution';
      generationId: string;
      sha256: string;
      signerPersonId: string;
      /** Absent on legacy evidence; only unambiguous single-role evidence can satisfy a gate. */
      signerRole?: SignerRole;
      capacity: string;
      signedDate: string;
      evidenceId: string;
      actorId: string;
      at: string;
    };
