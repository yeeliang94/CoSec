/**
 * Bulk import of client files. A batch is one client folder; each company folder inside it is
 * read by its own agent, which only suggests values. A person reviews and applies them.
 */
import type { RelationshipRole } from './resolution/model';

export type ImportBatchStatus = 'Uploading' | 'Running' | 'Paused' | 'Finished';
export type ImportBatch = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  status: ImportBatchStatus;
  /** Files that sat outside every company folder and were left out. */
  looseFiles: number;
  /** Set when import data older than 90 days was removed. */
  purgedAt?: string;
  revision: number;
};

export type ImportCompanyStatus =
  | 'Uploading'
  | 'Waiting'
  | 'Reading'
  | 'Needs answer'
  | 'Ready'
  | 'Could not finish'
  | 'Applied'
  | 'Left out';

export type FileKind = 'pdf' | 'word' | 'excel' | 'image' | 'text' | 'other';
export type FileResult = 'Waiting' | 'Used' | 'Not used' | 'Another company' | 'Could not read';
export type ImportFile = {
  id: string;
  /** Path inside the company folder, using forward slashes. */
  path: string;
  name: string;
  size: number;
  sha256: string;
  storageKey: string;
  kind: FileKind;
  pages: number | null;
  /** What the agent read the file as, such as "Annual return 2024". */
  readAs: string;
  result: FileResult;
  /** Why a file was not used or could not be read. */
  note: string;
  /** For "Another company": the company the file seems to be about. */
  otherCompany?: string;
  /** Set when a person moved the file here from another company folder. */
  movedFrom?: string;
};

/** Where a value came from. `fileId` is empty for a value the reviewer typed in. */
export type Source = { fileId: string; page: number | null; quote: string };

type Base = {
  id: string;
  source: Source;
  use: boolean;
  error?: string;
  /** Set when the reviewer corrected the agent's suggestion: who did it. */
  correctedBy?: string;
  /** The agent's suggestion before the first correction, so a re-read recognises it. */
  original?: Record<string, unknown>;
};
/** True for a value the reviewer typed in or corrected; the agent leaves it alone. */
export const byReviewer = (s: { source: Source; correctedBy?: string }) =>
  !s.source.fileId || Boolean(s.correctedBy);
export type CompanySuggestion = Base & {
  kind: 'company';
  /** A key from the field list: a core company field or a company particular. */
  key: string;
  value: string;
  /** The date the value applies from, normally the source document's date. */
  effectiveDate: string | null;
};
export type PersonSuggestion = Base & {
  kind: 'person';
  /** The agent's handle for this person, used by roles and shares. */
  ref: string;
  personKind: 'individual' | 'organisation';
  fullName: string;
  values: Record<string, string>;
  effectiveDate: string | null;
  /**
   * The reviewer's choice when someone with the same name, and no matching identity number, is
   * already in the app: that person's id, or null for a new person. Unset until they choose.
   */
  linkTo?: string | null;
};
export type RoleSuggestion = Base & {
  kind: 'role';
  personRef: string;
  role: RelationshipRole;
  startDate: string | null;
  endDate: string | null;
  cessation: 'resignation' | 'removal' | 'other_cessation' | null;
};
export type SharesSuggestion = Base & {
  kind: 'shares';
  personRefs: string[];
  className: string;
  classKind: 'Ordinary' | 'Preference' | 'Other';
  shares: string;
  amountPayable: string | null;
  amountPaid: string | null;
  consideration: 'Cash' | 'Otherwise than cash' | null;
  date: string;
};
export type ChargeSuggestion = Base & {
  kind: 'charge';
  registeredNumber: string;
  registeredOn: string;
  nature: string;
  chargee: string;
  amount: string;
  dischargedOn: string | null;
};
export type Suggestion =
  CompanySuggestion | PersonSuggestion | RoleSuggestion | SharesSuggestion | ChargeSuggestion;

export type Question = {
  id: string;
  text: string;
  choices: { label: string; source: Source | null }[];
  suggested: number | null;
  answer: { choice: number | null; text: string; by: string; at: string } | null;
  /** True once the agent has read the answer and updated its suggestions. */
  settled: boolean;
};

export type RunRecord = {
  startedAt: string | null;
  finishedAt: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  error: string | null;
  summary: string;
  notFound: string[];
  /** Files the agent has finished with, so a resumed run does not read them again. */
  done: string[];
  /** Files read so far, for the progress line. */
  read: string[];
  /** Record revisions when reading started, to show later changes made in the app. */
  seen?: { company: number; profile: number } | null;
  /** Tokens used per day (YYYY-MM-DD), for the firm's daily limit. */
  usageByDay: Record<string, number>;
};

export type ImportTarget =
  { mode: 'existing'; companyId: string } | { mode: 'new' } | { mode: 'leave_out' };

export type ImportCompany = {
  id: string;
  importId: string;
  folder: string;
  target: ImportTarget;
  /** Display name: the matched company's, else the name the agent found, else the folder. */
  name: string;
  registrationNumber: string;
  status: ImportCompanyStatus;
  files: ImportFile[];
  suggestions: Suggestion[];
  questions: Question[];
  run: RunRecord;
  applied: { by: string; at: string; companyId: string } | null;
  revision: number;
};

export const emptyRun = (): RunRecord => ({
  startedAt: null,
  finishedAt: null,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  attempts: 0,
  error: null,
  summary: '',
  notFound: [],
  done: [],
  read: [],
  usageByDay: {},
});

export type ImportSettings = {
  /** The model gateway, for example https://gateway.example.com/v1. Empty: import is off. */
  gatewayUrl: string;
  model: string;
  /** Sent as the `custom-llm-provider` header when set. */
  providerHeader: string;
  companiesAtOnce: number;
  maxTurns: number;
  maxMinutes: number;
  maxTokensPerCompany: number;
  dailyTokenLimit: number;
};
export const defaultImportSettings: ImportSettings = {
  gatewayUrl: '',
  model: '',
  providerHeader: '',
  companiesAtOnce: 4,
  maxTurns: 60,
  maxMinutes: 30,
  maxTokensPerCompany: 3_000_000,
  dailyTokenLimit: 50_000_000,
};

/** Kept for the screens: what each status means to a person. */
export const STATUS_LABELS: Record<ImportCompanyStatus, string> = {
  Uploading: 'Uploading files',
  Waiting: 'Waiting to be read',
  Reading: 'Reading',
  'Needs answer': 'Needs your answer',
  Ready: 'Ready for review',
  'Could not finish': 'Could not finish',
  Applied: 'Applied',
  'Left out': 'Left out',
};

export function fileKind(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'word';
  if (ext === 'xlsx' || ext === 'xlsm') return 'excel';
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 'image';
  if (['txt', 'csv'].includes(ext)) return 'text';
  return 'other';
}

const SUFFIXES =
  /\b(sdn\.?\s*bhd\.?|sendirian\s+berhad|berhad|bhd\.?|plc|ltd\.?|limited|llp|\(m\))/g;
/** A company or folder name reduced to its distinctive words. */
export function nameKey(name: string) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * The company a folder name points to: its registration number in the name, else the same
 * distinctive words, else one name starting with the other. Ambiguous matches return null.
 */
export function matchFolder(
  folder: string,
  companies: { id: string; name: string; registrationNumber: string }[],
): string | null {
  const folderDigits = digits(folder);
  if (folderDigits.length >= 6) {
    const byNumber = companies.filter((c) => {
      const reg = digits(c.registrationNumber);
      return reg.length >= 6 && folderDigits.includes(reg);
    });
    if (byNumber.length === 1) return byNumber[0].id;
  }
  const key = nameKey(folder);
  if (!key) return null;
  const exact = companies.filter((c) => nameKey(c.name) === key);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const partial = companies.filter((c) => {
    const other = nameKey(c.name);
    return (
      other.length >= 4 &&
      key.length >= 4 &&
      (other.startsWith(key + ' ') || key.startsWith(other + ' '))
    );
  });
  return partial.length === 1 ? partial[0].id : null;
}

/** Splits browser folder paths (root/company/…/file) into company folders and loose files. */
export function groupFolderFiles<T extends { relativePath: string }>(files: T[]) {
  const folders = new Map<string, T[]>();
  let loose = 0;
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean);
    // Hidden files and the system's own files are not client documents.
    if (parts.slice(1).some((p) => p.startsWith('.'))) continue;
    const name = parts[parts.length - 1];
    if (name.startsWith('~$') || /^(thumbs\.db|desktop\.ini)$/i.test(name)) continue;
    // parts[0] is the chosen folder itself; parts[1] the company folder.
    if (parts.length < 3) {
      loose++;
      continue;
    }
    const list = folders.get(parts[1]) ?? [];
    list.push(file);
    folders.set(parts[1], list);
  }
  return {
    folders: [...folders.entries()]
      .map(([name, list]) => ({ name, files: list }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    loose,
  };
}

export const openQuestions = (company: Pick<ImportCompany, 'questions'>) =>
  company.questions.filter((q) => !q.answer);
