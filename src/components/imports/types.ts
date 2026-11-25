/** Response shapes of the bulk import endpoints, for the screens. */
import type {
  ImportBatch,
  ImportCompany,
  ImportCompanyStatus,
  ImportFile,
  ImportTarget,
} from '@/domain/imports';

export type ImportListItem = ImportBatch & {
  companies: number;
  applied: number;
  waitingOnYou: number;
};
export type ImportList = { imports: ImportListItem[]; gatewayProblem: string | null };
export type RowSummary = {
  id: string;
  folder: string;
  name: string;
  registrationNumber: string;
  target: ImportTarget;
  status: ImportCompanyStatus;
  files: number;
  filesRead: number;
  suggestions: number;
  openQuestions: number;
  error: string | null;
  applied: { by: string; at: string; companyId: string } | null;
};
export type ImportView = {
  batch: ImportBatch;
  companies: RowSummary[];
  files: (ImportFile & { companyRowId: string; companyName: string })[];
  reading: number;
  waiting: number;
  gatewayProblem: string | null;
};
export type CurrentRecordView = {
  company: Record<string, string>;
  verification: string;
  people: {
    id: string;
    fullName: string;
    kind: string;
    identityType: string;
    identityNumber: string;
  }[];
  roles: {
    personId: string;
    personName: string;
    role: string;
    startDate: string | null;
    endDate: string | null;
  }[];
  shareClasses: { id: string; name: string }[];
  shareEntries: number;
  shareDrafts: number;
  charges: { registeredNumber: string; chargee: string }[];
  revisions: { company: number; profile: number };
};
export type CompanyDetail = {
  batch: ImportBatch;
  row: ImportCompany;
  current: CurrentRecordView | null;
  matches: Record<string, { personId: string | null; visible: boolean; fullName: string | null }[]>;
  nameMatches: Record<string, { personId: string; fullName: string }[]>;
  /** What the app holds today for each person the import would update. */
  personValues: Record<string, Record<string, string>>;
  gatewayProblem: string | null;
  plan: {
    company: number;
    people: number;
    roles: number;
    shares: number;
    charges: number;
    files: number;
    missing: string[];
  };
};
