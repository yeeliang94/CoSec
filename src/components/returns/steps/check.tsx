'use client';
import { useRef, useState } from 'react';
import { FILING_LABELS } from '@/domain/ar1/build';
import { type ReturnDownload } from '@/domain/ar1/returns';
import { formatDate, Icon, useWorkspace } from '@/components/workspace';
import { newRequestId, postForm, postJson } from '@/components/resolution/api';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { WarningLine } from '@/components/warning-line';
import { StepIssues, type OnFix, type ReturnView } from '../step-parts';

export function CheckStep({
  view,
  onFix,
  onChanged,
}: {
  view: ReturnView;
  onFix: OnFix;
  onChanged: () => Promise<void>;
}) {
  const { data: workspace } = useWorkspace();
  const upload = useAction();
  const make = useAction();
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const record = view.record;
  const check = view.filingCheck;
  const matches = Boolean(record.blank) && check?.length === 0;
  const userName = (id: string) => workspace?.users.find((u) => u.id === id)?.name ?? '';
  const blocked = view.issues.some((i) => i.severity === 'blocker');
  // A stale revision offers Reload; other refusals (a blocker, say) read as plain errors.
  const stale = (action: ReturnType<typeof useAction>) =>
    action.conflict && action.lastCode.current === 'STALE';
  return (
    <>
      <section className="section">
        <h3>Still to fill</h3>
        {view.issues.length ? (
          <>
            <StepIssues issues={view.issues} companyId={view.company.id} onFix={onFix} />
            <p className="muted">
              {blocked
                ? 'The workbook cannot be made until the problems are fixed.'
                : 'You can still download. mTool will list these when you validate the workbook.'}
            </p>
          </>
        ) : (
          <p className="ok-line">Nothing is missing from the records.</p>
        )}
      </section>
      <section className="section">
        <h3>Blank workbook</h3>
        {record.blank ? (
          <>
            <p>
              {record.blank.fileName}, uploaded {formatDate(record.blank.uploadedAt)} by{' '}
              {userName(record.blank.uploadedBy)}
            </p>
            {check && check.length ? (
              <>
                <WarningLine blocking>
                  The blank&apos;s filing information does not match this return. Make a new blank
                  in mTool with the values below, or correct the return.
                </WarningLine>
                <div className="table-wrap">
                  <table className="records-table">
                    <caption className="sr-only">Filing information differences</caption>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>This return</th>
                        <th>In workbook</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.map((d) => (
                        <tr key={d.field}>
                          <td>{FILING_LABELS[d.field]}</td>
                          <td title={d.expected}>{d.expected}</td>
                          <td className="danger-text" title={d.actual}>
                            {d.actual}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="ok-line">Its filing information matches this return.</p>
            )}
          </>
        ) : (
          <ol className="plain-steps">
            <li>
              In mTool, create an AR1 annual return with the filing information on the first step.
            </li>
            <li>Save it without filling anything else.</li>
            <li>Upload the saved .xlsx file here.</li>
          </ol>
        )}
        <form
          className="upload-row"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!file) return;
            const form = new FormData();
            form.set('file', file);
            form.set('requestId', newRequestId());
            form.set('expectedRevision', String(record.revision));
            const ok = await upload.run(
              () => postForm<unknown>(`/api/annual-returns/${record.id}/blank`, form),
              'Blank workbook uploaded',
            );
            if (ok) {
              setFile(null);
              // Clear the chosen file so the same file can be picked and uploaded again.
              if (fileInput.current) fileInput.current.value = '';
              await onChanged();
            }
          }}
        >
          <label>
            {record.blank ? 'Replace blank workbook' : 'Blank workbook from mTool'}
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button disabled={!file || upload.pending}>Upload</button>
          <ActionFeedback
            error={upload.error}
            status={upload.status}
            conflict={stale(upload)}
            onReload={() => void onChanged()}
          />
        </form>
      </section>
      <section className="section">
        <h3>Filled workbook</h3>
        <button
          type="button"
          className="primary"
          disabled={!matches || make.pending}
          onClick={async () => {
            const result = await make.run(() =>
              postJson<{ download: ReturnDownload }>(`/api/annual-returns/${record.id}`, {
                action: 'create_download',
                requestId: newRequestId(),
                expectedRevision: record.revision,
              }),
            );
            if (result) {
              await onChanged();
              window.location.href = `/api/annual-returns/${record.id}/download?version=${result.download.version}`;
            }
          }}
        >
          <Icon kind="download" />
          Download Excel
        </button>
        {!record.blank ? <p className="muted">Upload the blank workbook first.</p> : null}
        <ActionFeedback
          error={make.error}
          status={make.status}
          conflict={stale(make)}
          onReload={() => void onChanged()}
        />
      </section>
      {record.downloads.length ? (
        <section className="section">
          <h3>Downloads</h3>
          <div className="table-wrap">
            <table className="records-table">
              <caption className="sr-only">Downloads</caption>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Blank used</th>
                  <th className="col-date">Made</th>
                  <th>By</th>
                  <th className="num">Missing at the time</th>
                </tr>
              </thead>
              <tbody>
                {[...record.downloads].reverse().map((d) => (
                  <tr key={d.version}>
                    <td title={d.fileName}>
                      <a href={`/api/annual-returns/${record.id}/download?version=${d.version}`}>
                        {d.fileName}
                      </a>
                    </td>
                    <td title={d.blankFileName}>{d.blankFileName}</td>
                    <td>{formatDate(d.createdAt)}</td>
                    <td>{userName(d.createdBy)}</td>
                    <td className="num">{d.missing.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className="section">
        <h3>Then in mTool</h3>
        <ol className="plain-steps">
          <li>
            Open the downloaded workbook from an ordinary folder, not the Downloads temporary view.
          </li>
          <li>Check the filing information, then run Validate.</li>
          <li>Fix anything mTool lists in the app, download again, and Generate XBRL.</li>
        </ol>
      </section>
    </>
  );
}
