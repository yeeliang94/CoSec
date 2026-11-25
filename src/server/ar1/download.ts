import { and, eq } from 'drizzle-orm';
import { db, transaction } from '../db';
import * as s from '../schema';
import { audit, prior, remember, requestKey } from '../repository';
import {
  MAX_UPLOAD_BYTES,
  readDownload,
  recordGenerated,
  removeStoredFile,
  stageWorkbook,
} from '../storage';
import { assertAny } from '../records/scope';
import { changeReturn, loadBuildInput, returnForActor } from './returns';
import { compareFilingInfo, NotAnAr1Workbook, readFilingInfo } from './filing-info';
import { assertBlankTables, fillWorkbook, readBack } from './fill';
import { readPackage } from './zip';
import { msicDescription } from './msic';
import { assertCompany, DomainError } from '../../domain/access';
import type { Actor, Document } from '../../domain/model';
import { buildReturn } from '../../domain/ar1/build';
import type { AnnualReturn, ReturnDownload } from '../../domain/ar1/returns';

/** What `changeReturn` requires of the actor; checked before any upload is parsed. */
const PREPARE = ['prepare_job', 'generate_documents'] as const;

async function readRecord(actor: Actor, id: string) {
  const [row] = await db.select().from(s.annualReturns).where(eq(s.annualReturns.id, id));
  if (!row) throw new DomainError('Annual return not found.', 'NOT_FOUND', 404);
  assertCompany(actor, row.companyId);
  return row.data;
}

/** Whether `changeReturn` has already handled this request (its idempotency key, read early). */
async function handledBefore(actor: Actor, id: string, requestId: string) {
  const key = requestKey(actor, `annual-return:${id}`, requestId);
  const [row] = await db.select().from(s.requests).where(eq(s.requests.id, key));
  return Boolean(row);
}

/** The audit entries for workbooks made from this return, newest last. */
async function workbookEvents(id: string) {
  const rows = await db
    .select()
    .from(s.auditEvents)
    .where(
      and(
        eq(s.auditEvents.subjectId, id),
        eq(s.auditEvents.entityType, 'annual_return'),
        eq(s.auditEvents.action, 'annual_return.workbook_created'),
      ),
    );
  return rows
    .map((r) => ({
      actorId: r.actorId,
      requestId: r.requestId,
      detail: r.detail as { version?: number; toRevision?: number },
    }))
    .sort((a, b) => (a.detail.version ?? 0) - (b.detail.version ?? 0));
}

/** The download an earlier, successful request made, for a retry of that same request. */
async function priorDownload(actor: Actor, record: AnnualReturn, requestId: string) {
  const event = (await workbookEvents(record.id)).find(
    (e) => e.actorId === actor.id && e.requestId === requestId,
  );
  // A request that reused an existing version made no workbook event; its receipt names it.
  const key = requestKey(actor, `annual-return:${record.id}`, requestId);
  const version = event?.detail.version ?? (await transaction((tx) => prior(tx, key)))?.version;
  const download = record.downloads.find((d) => d.version === version);
  if (!download)
    throw new DomainError(
      'This request was already used for another change. Refresh and try again.',
      'CONFLICT',
      409,
    );
  return shown(actor, record, download.version);
}

/** The return and one of its versions as this actor may see them (other companies' ids removed). */
async function shown(actor: Actor, record: AnnualReturn, version: number) {
  const visible = await returnForActor(actor, record);
  return { record: visible, download: visible.downloads.find((d) => d.version === version)! };
}

/**
 * The checks the blank upload route makes before it reads the request body: the return exists,
 * the actor may see its company and may change the return.
 */
export async function assertMayUploadBlank(actor: Actor, id: string) {
  await readRecord(actor, id);
  assertAny(actor, [...PREPARE]);
}

/** Runs `commit`; if it fails, the staged file is removed so no orphan stays on disk. */
async function withStaged<T>(doc: Document, commit: () => Promise<T>) {
  try {
    return await commit();
  } catch (error) {
    await removeStoredFile(doc.storageKey);
    throw error;
  }
}

/**
 * Keeps the blank AR1 workbook the secretary made in mTool for this return, with its filing
 * information. A replaced blank stays among the company's documents; the return points at the
 * newest one, and each download records which blank it came from.
 */
export async function uploadBlank(
  actor: Actor,
  id: string,
  input: { requestId: string; expectedRevision: number; file: File },
) {
  const record = await readRecord(actor, id);
  // Permission first: an uploaded workbook is only parsed for someone who may change the return.
  assertAny(actor, [...PREPARE]);
  if (await handledBefore(actor, id, input.requestId)) return returnForActor(actor, record);
  if (input.file.size > MAX_UPLOAD_BYTES) throw new DomainError('Files must be 15 MiB or smaller.');
  const bytes = Buffer.from(await input.file.arrayBuffer());
  let filingInfo: Record<string, string>;
  try {
    filingInfo = readFilingInfo(bytes);
    assertBlankTables(readPackage(bytes));
  } catch (error) {
    if (error instanceof NotAnAr1Workbook) throw new DomainError(error.message);
    throw error;
  }
  const doc = await stageWorkbook(actor, {
    companyId: record.companyId,
    title: `Blank AR1 workbook, annual return ${record.calendarYear}`,
    fileName: input.file.name || 'blank-ar1.xlsx',
    bytes,
  });
  const saved = await withStaged(doc, () =>
    changeReturn(
      actor,
      id,
      input.requestId,
      input.expectedRevision,
      'annual_return.blank_uploaded',
      async (next, tx) => {
        await recordGenerated(actor, doc, tx);
        next.blank = {
          documentId: doc.id,
          sha256: doc.sha256,
          fileName: doc.originalName,
          uploadedAt: doc.createdAt,
          uploadedBy: actor.id,
          filingInfo,
        };
      },
      { documentId: doc.id, sha256: doc.sha256 },
    ),
  );
  // A concurrent retry of the same request got there first: this copy was never recorded.
  if (saved.blank?.documentId !== doc.id) await removeStoredFile(doc.storageKey);
  return returnForActor(actor, saved);
}

const fileName = (record: AnnualReturn, registration: string, version: number) =>
  `AR1_${registration || 'company'}_${record.returnDate.replaceAll('-', '')}_v${version}.xlsx`;

/**
 * Fills the uploaded blank from records as at the return date and keeps the result as a new
 * version. The stored file is the frozen output: later record changes need a new version.
 * Refused while the blank's filing information does not match the return, and while the figures
 * disagree (a "blocker" issue). Missing particulars do not stop a download (owner decision,
 * 16 Nov 2026); the version records what was missing. When nothing has changed since the latest
 * version (same blank, same record revisions, same return), that version is returned instead of
 * storing an identical file again.
 */
export async function createDownload(
  actor: Actor,
  id: string,
  input: { requestId: string; expectedRevision: number },
): Promise<{ record: AnnualReturn; download: ReturnDownload }> {
  const record = await readRecord(actor, id);
  assertAny(actor, [...PREPARE]);
  // A retry of a request that succeeded gets its result, not a stale-revision refusal.
  if (await handledBefore(actor, id, input.requestId))
    return priorDownload(actor, record, input.requestId);
  if (record.revision !== input.expectedRevision)
    throw new DomainError('This return changed. Refresh and try again.', 'STALE', 409);
  if (!record.blank) throw new DomainError('Upload the blank AR1 workbook from mTool first.');
  const { input: buildInput, sources } = await loadBuildInput(actor, record);
  const { data, issues } = buildReturn(buildInput);
  const blocker = issues.find((i) => i.severity === 'blocker');
  if (blocker)
    throw new DomainError(
      `The workbook cannot be made until this is fixed: ${blocker.message}`,
      'BLOCKED',
      409,
    );
  for (const m of data.a.msic) m.description = msicDescription(m.code) ?? '';
  const differences = compareFilingInfo(data.filingInfo, record.blank.filingInfo);
  if (differences.length)
    throw new DomainError(
      'The blank workbook’s filing information does not match this return. Make a new blank in mTool, or correct the return.',
    );
  const missing = issues.map((i) => i.message);

  const latest = record.downloads.at(-1);
  if (
    latest &&
    latest.blankSha256 === record.blank.sha256 &&
    JSON.stringify(latest.sources) === JSON.stringify(sources) &&
    JSON.stringify(latest.missing) === JSON.stringify(missing)
  ) {
    // The return itself (answers, filing details) is unchanged when its revision is still the one
    // the latest version's own change produced.
    const event = (await workbookEvents(id)).find((e) => e.detail.version === latest.version);
    if (event?.detail.toRevision === record.revision) {
      // Remembered, so a retry returns this same version even if records change in between.
      const key = requestKey(actor, `annual-return:${id}`, input.requestId);
      const reused = await transaction(async (tx) => {
        const earlier = await prior(tx, key);
        if (!earlier) await remember(tx, key, { id, version: latest.version });
        return earlier;
      });
      // A concurrent request with this id got there first; return what it recorded.
      if (reused) return priorDownload(actor, record, input.requestId);
      return shown(actor, record, latest.version);
    }
  }

  const blank = await readDownload(actor, record.blank.documentId, { audit: false });
  if (blank.document.sha256 !== record.blank.sha256)
    throw new DomainError('The stored blank workbook changed. Upload it again.', 'STORAGE', 503);
  let filled;
  try {
    filled = fillWorkbook(blank.bytes, data);
  } catch (error) {
    if (error instanceof Error)
      throw new DomainError(`The workbook could not be filled: ${error.message}`);
    throw error;
  }
  const mismatches = readBack(filled.bytes, filled.written);
  if (mismatches.length)
    throw new DomainError(
      `The filled workbook did not read back (${mismatches[0].sheet}!${mismatches[0].cell}).`,
      'STORAGE',
      500,
    );
  const version = record.downloads.length + 1;
  const registration = data.filingInfo.newRegistrationNumber;
  const doc = await stageWorkbook(actor, {
    companyId: record.companyId,
    title: `Annual return ${record.calendarYear}, AR1 workbook version ${version}`,
    fileName: fileName(record, registration, version),
    bytes: filled.bytes,
  });
  const download: ReturnDownload = {
    version,
    documentId: doc.id,
    sha256: doc.sha256,
    fileName: doc.originalName,
    blankSha256: record.blank.sha256,
    blankFileName: record.blank.fileName,
    createdAt: doc.createdAt,
    createdBy: actor.id,
    rowsAdded: filled.rowsAdded,
    cellsWritten: filled.written.length,
    missing,
    sources,
  };
  const saved = await withStaged(doc, () =>
    changeReturn(
      actor,
      id,
      input.requestId,
      input.expectedRevision,
      'annual_return.workbook_created',
      async (next, tx) => {
        await recordGenerated(actor, doc, tx);
        next.downloads.push(download);
        next.status = 'Downloaded';
      },
      { version, documentId: doc.id, sha256: doc.sha256, missing: issues.length },
    ),
  );
  const ours = saved.downloads.find((d) => d.documentId === doc.id);
  if (ours) return shown(actor, saved, ours.version);
  // A concurrent retry of the same request got there first: this copy was never recorded.
  await removeStoredFile(doc.storageKey);
  return priorDownload(actor, saved, input.requestId);
}

/** The stored file of one version, unchanged since it was made. */
export async function downloadVersion(actor: Actor, id: string, version: number) {
  const record = await readRecord(actor, id);
  const entry = record.downloads.find((d) => d.version === version);
  if (!entry) throw new DomainError('That version does not exist.', 'NOT_FOUND', 404);
  const { document, bytes } = await readDownload(actor, entry.documentId, { audit: false });
  if (document.sha256 !== entry.sha256)
    throw new DomainError('The stored workbook failed its integrity check.', 'STORAGE', 503);
  await audit(actor, record.companyId, 'annual_return.downloaded', record.id, {
    version,
    documentId: document.id,
    sha256: document.sha256,
  });
  return { bytes, fileName: entry.fileName };
}
