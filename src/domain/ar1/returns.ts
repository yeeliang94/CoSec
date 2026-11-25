import { APPLICATIONS, BO_EXEMPT_CATEGORIES, BO_STATUSES, NOMINEE_STATUSES } from './mtool-lists';
import type { ShareKind } from './shares';

export type Application = (typeof APPLICATIONS)[number];
export type YesNo = 'Yes' | 'No';
type PerKind = Partial<Record<ShareKind, string>>;

/**
 * Answers that are true for one return only. Section B amounts are MYR strings per kind of share;
 * an empty value is left blank in the workbook.
 */
export type ReturnAnswers = {
  sharesQuoted: YesNo | null;
  sectionB: {
    forfeitedShares: PerKind;
    calledUp: PerKind;
    callsReceived: PerKind;
    consideredPaidFullyPaid: PerKind;
    consideredPaidPartlyPaid: PerKind;
    callsUnpaid: PerKind;
    paidOnForfeited: PerKind;
    commission: string;
    discount: string;
    notesOnShares: string;
    notesOnDebentures: string;
  };
  notesOnIndebtedness: string;
  /** Section F analysis chosen for a joint holding, by holder key, where the holders differ. */
  jointAnalyses?: Record<string, string>;
  certificate: {
    /** (a) Unclaimed Moneys Act 1965 complied with. */
    unclaimedMoneys: YesNo | null;
    /** (c) No invitation to the public to subscribe for shares or debentures. */
    noPublicInvitation: YesNo | null;
    /** (d) Private company: members above fifty are employees or former employees only. */
    overFifty: YesNo | null;
    /** (e) Public company with more than 500 members: inspection facilities. */
    overFiveHundred: YesNo | null;
    /** (f) Beneficial owner status. */
    boStatus: (typeof BO_STATUSES)[number] | null;
    /** (g) Exempt category, when exempted from BO reporting. */
    boExemptCategory: (typeof BO_EXEMPT_CATEGORIES)[number] | null;
    /** (h) Nominee director status; defaults from the directors' nominee flags. */
    nomineeStatus: (typeof NOMINEE_STATUSES)[number] | null;
  };
};

export const emptyAnswers = (): ReturnAnswers => ({
  sharesQuoted: null,
  sectionB: {
    forfeitedShares: {},
    calledUp: {},
    callsReceived: {},
    consideredPaidFullyPaid: {},
    consideredPaidPartlyPaid: {},
    callsUnpaid: {},
    paidOnForfeited: {},
    commission: '',
    discount: '',
    notesOnShares: '',
    notesOnDebentures: '',
  },
  notesOnIndebtedness: '',
  jointAnalyses: {},
  certificate: {
    unclaimedMoneys: null,
    noPublicInvitation: null,
    overFifty: null,
    overFiveHundred: null,
    boStatus: null,
    boExemptCategory: null,
    nomineeStatus: null,
  },
});

/** The blank AR1 workbook the secretary made in mTool and uploaded for this return. */
export type UploadedBlank = {
  documentId: string;
  sha256: string;
  fileName: string;
  uploadedAt: string;
  uploadedBy: string;
  /** FilingInfo column E, rows 11 to 29, as read from the workbook. */
  filingInfo: Record<string, string>;
};

/** A source record and the revision a download read, so a later change shows as a new version. */
export type SourceRevision = { kind: string; id: string; revision: number };

/** One filled workbook. The stored file is the frozen output; re-downloading serves it unchanged. */
export type ReturnDownload = {
  version: number;
  documentId: string;
  sha256: string;
  fileName: string;
  blankSha256: string;
  blankFileName: string;
  createdAt: string;
  createdBy: string;
  rowsAdded: number;
  cellsWritten: number;
  /** What mTool will still reject, as listed when the file was made. */
  missing: string[];
  sources: SourceRevision[];
};

export type ReturnStatus = 'Preparing' | 'Downloaded';
export type AnnualReturn = {
  id: string;
  companyId: string;
  calendarYear: number;
  /** The incorporation anniversary the return is made up to. */
  returnDate: string;
  /** 30 days after the return date. */
  dueDate: string;
  firstReturn: boolean;
  /** The previous return's date, for transfers "since the last return". */
  lastReturnDate: string | null;
  application: Application;
  rectificationDeclaration: string;
  courtOrderReference: string;
  answers: ReturnAnswers;
  blank: UploadedBlank | null;
  downloads: ReturnDownload[];
  status: ReturnStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** 29 February anniversaries fall on 28 February in other years. */
export function anniversary(incorporationDate: string, year: number): string {
  const [, mm, dd] = incorporationDate.split('-');
  const date = `${year}-${mm}-${dd}`;
  return mm === '02' && dd === '29' && new Date(`${date}T00:00:00Z`).getUTCMonth() !== 1
    ? `${year}-02-28`
    : date;
}
/**
 * The annual return made up to the incorporation anniversary in `year` (Companies Act 2016,
 * s 68), due within 30 days of it. None for the year of incorporation.
 */
export function returnFor(incorporationDate: string, year: number) {
  const incorporated = Number(incorporationDate.slice(0, 4));
  if (year <= incorporated) return null;
  const returnDate = anniversary(incorporationDate, year);
  return {
    calendarYear: year,
    returnDate,
    dueDate: addDays(returnDate, 30),
    firstReturn: year === incorporated + 1,
    lastReturnDate: year === incorporated + 1 ? null : anniversary(incorporationDate, year - 1),
  };
}
/**
 * The return a company should be working on as at `today`: the latest one whose return date has
 * passed (overdue once 30 days go by), or the first one when the company is not a year old yet.
 */
export function nextReturn(incorporationDate: string, today: string) {
  const year = Number(today.slice(0, 4));
  const passed = [year, year - 1]
    .map((y) => returnFor(incorporationDate, y))
    .find((r) => r && r.returnDate <= today);
  return passed ?? returnFor(incorporationDate, Number(incorporationDate.slice(0, 4)) + 1);
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
/** Overdue, due within seven days, or later; the list groups open returns this way. */
export function dueGroup(dueDate: string, today: string): 'Overdue' | 'Due this week' | 'Later' {
  const days = daysBetween(today, dueDate);
  return days < 0 ? 'Overdue' : days <= 7 ? 'Due this week' : 'Later';
}
/** mTool's date text, dd/mm/yyyy. */
export const mtoolDate = (date: string | null | undefined) =>
  date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '';

/** Certificate (f): the status that asks for an exempt category in (g). */
export const BO_EXEMPT = BO_STATUSES[3];
/** Rectification filings need the statutory declaration for rectification. */
export const needsDeclaration = (application: string) => application.startsWith('Rectification');
/** Filings made under a court order need its reference. */
export const needsCourtOrder = (application: string) => /court order/i.test(application);
