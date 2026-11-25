'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  BackLink,
  Empty,
  formatDay,
  PageHeader,
  useDocumentTitle,
  useWorkspace,
} from '@/components/workspace';
import { WarningLine } from '@/components/warning-line';
import { errorText, getJson, postJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { StrayFiles } from '@/components/imports/stray-files';
import type { ImportView, RowSummary } from '@/components/imports/types';
import type { FileResult } from '@/domain/imports';

const GROUPS: { title: string; match: (r: RowSummary) => boolean }[] = [
  { title: 'Needs your answer', match: (r) => r.status === 'Needs answer' },
  { title: 'Ready for review', match: (r) => r.status === 'Ready' },
  { title: 'Could not finish', match: (r) => r.status === 'Could not finish' },
  { title: 'In progress', match: (r) => ['Reading', 'Waiting', 'Uploading'].includes(r.status) },
  { title: 'Applied', match: (r) => r.status === 'Applied' },
  { title: 'Left out', match: (r) => r.status === 'Left out' },
];
function rowStatus(r: RowSummary) {
  switch (r.status) {
    case 'Needs answer':
      return `${r.openQuestions} ${r.openQuestions === 1 ? 'question' : 'questions'}`;
    case 'Ready':
      return 'All files read';
    case 'Reading':
      return `${r.filesRead} of ${r.files} files read`;
    case 'Waiting':
      return r.error ?? 'Waiting to be read';
    case 'Uploading':
      return 'Uploading files';
    case 'Could not finish':
      return r.error ?? 'Could not finish';
    case 'Applied':
      return `Applied ${formatDay(r.applied?.at)}`;
    default:
      return 'Left out';
  }
}
function fileResult(f: { result: FileResult; note: string; otherCompany?: string }) {
  if (f.result === 'Used') return `Used for ${f.note}`;
  if (f.result === 'Another company') return `Looks like ${f.otherCompany ?? 'another company'}`;
  if (f.result === 'Waiting') return 'Not read yet';
  return f.note ? `${f.result}: ${f.note}` : f.result;
}
const RESULT_FILTERS: [string, string][] = [
  ['', 'All files'],
  ['Used', 'Used'],
  ['Not used', 'Not used'],
  ['Another company', 'Looks like another company'],
  ['Could not read', 'Could not read'],
];

export default function ImportPageRoute() {
  return (
    <Suspense fallback={null}>
      <ImportPage />
    </Suspense>
  );
}

function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const tab = search.get('tab') === 'files' ? 'files' : 'companies';
  const { data } = useWorkspace();
  const view = useLoad(() => getJson<ImportView>(`/api/imports/${id}`), [id]);
  const [sorting, setSorting] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState('');
  const [actionError, setActionError] = useState('');
  useDocumentTitle(view.data?.batch.name);
  const active = Boolean(
    view.data && (view.data.reading || view.data.waiting) && view.data.batch.status === 'Running',
  );
  // While companies are being read, the page refreshes itself.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void view.reload(), 5000);
    return () => clearInterval(timer);
  }, [active, view]);
  if (!data) return null;
  const v = view.data;
  const stray = v?.files.filter((f) => f.result === 'Another company') ?? [];
  const next = v?.companies.find((c) => c.status === 'Needs answer' || c.status === 'Ready');
  async function act(action: 'pause' | 'resume') {
    setActionError('');
    try {
      await postJson(`/api/imports/${id}`, { action });
      await view.reload();
    } catch (e) {
      setActionError(errorText(e));
    }
  }
  const setTab = (t: string) =>
    router.replace(`/companies/imports/${id}${t === 'files' ? '?tab=files' : ''}`);
  return (
    <>
      <BackLink href="/companies/imports" label="Imports" />
      <PageHeader title={v?.batch.name ?? 'Import'}>
        {v ? (
          <div className="header-actions">
            {v.batch.status === 'Running' ? (
              <button type="button" onClick={() => void act('pause')}>
                Pause reading
              </button>
            ) : v.batch.status === 'Paused' ? (
              <button type="button" onClick={() => void act('resume')}>
                Resume reading
              </button>
            ) : null}
            {next ? (
              <Link className="button primary" href={`/companies/imports/${id}/${next.id}`}>
                Review next company
              </Link>
            ) : null}
          </div>
        ) : null}
      </PageHeader>
      <LoadState
        loading={view.loading && !v}
        error={view.error}
        reload={() => void view.reload()}
        label="this import"
      />
      {actionError ? (
        <p className="feedback error" role="alert">
          {actionError}
        </p>
      ) : null}
      {v ? (
        <>
          <p className="import-status-line">
            {v.batch.status === 'Uploading'
              ? 'The upload did not finish. Start a new import to send the files again.'
              : v.batch.status === 'Paused'
                ? `Paused. ${v.waiting} ${v.waiting === 1 ? 'company' : 'companies'} waiting.`
                : v.batch.status === 'Finished'
                  ? 'Finished. Every company is applied or left out.'
                  : v.reading || v.waiting
                    ? `Reading ${v.reading} ${v.reading === 1 ? 'company' : 'companies'}, ${v.waiting} waiting.`
                    : v.companies.some((c) => c.status === 'Could not finish')
                      ? 'Reading stopped for some companies. Open one to see why and run it again.'
                      : 'All companies have been read.'}
          </p>
          {v.gatewayProblem && v.batch.status !== 'Finished' ? (
            <WarningLine blocking>{v.gatewayProblem}</WarningLine>
          ) : null}
          {stray.length ? (
            <WarningLine
              action={
                <button type="button" className="section-link" onClick={() => setSorting(true)}>
                  Review files
                </button>
              }
            >
              {stray.length} {stray.length === 1 ? 'file looks' : 'files look'} like{' '}
              {stray.length === 1 ? 'it belongs' : 'they belong'} to another company.
            </WarningLine>
          ) : null}
          <div className="import-tabs" role="tablist" aria-label="Import views">
            {[
              ['companies', 'Companies'],
              ['files', 'Files'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'companies' ? (
            <table className="records-table import-table">
              <caption className="sr-only">Companies in this import</caption>
              <colgroup>
                <col style={{ width: '28%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '11%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Registration no.</th>
                  <th>In the app</th>
                  <th className="num">Files</th>
                  <th className="num">Suggestions</th>
                  <th>Status</th>
                </tr>
              </thead>
              {GROUPS.map((group) => {
                const rows = v.companies.filter(group.match);
                if (!rows.length) return null;
                return (
                  <tbody key={group.title}>
                    <tr className="group-row">
                      <th colSpan={6} scope="colgroup">
                        {group.title}
                      </th>
                    </tr>
                    {rows.map((r) => {
                      const reviewable = !['Reading', 'Waiting', 'Uploading', 'Left out'].includes(
                        r.status,
                      );
                      return (
                        <tr key={r.id}>
                          <td title={r.name}>
                            {r.status === 'Applied' && r.applied ? (
                              <Link href={`/companies/${r.applied.companyId}`}>{r.name}</Link>
                            ) : reviewable ? (
                              <Link href={`/companies/imports/${id}/${r.id}`}>{r.name}</Link>
                            ) : (
                              <strong>{r.name}</strong>
                            )}
                          </td>
                          <td className="tabular">{r.registrationNumber}</td>
                          <td>
                            {r.target.mode === 'existing'
                              ? 'Existing company'
                              : r.target.mode === 'new'
                                ? 'New company'
                                : 'Left out'}
                          </td>
                          <td className="num">{r.files}</td>
                          <td className="num">
                            {r.status === 'Applied' || !r.suggestions ? '' : r.suggestions}
                          </td>
                          <td
                            title={rowStatus(r)}
                            className={r.status === 'Could not finish' ? 'blocked' : undefined}
                          >
                            {rowStatus(r)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          ) : (
            <>
              <div className="import-filters">
                <label className="search">
                  <span className="sr-only">Search files</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search file or company"
                  />
                </label>
                <label>
                  <span className="sr-only">Result</span>
                  <select value={result} onChange={(e) => setResult(e.target.value)}>
                    {RESULT_FILTERS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {(() => {
                const term = query.trim().toLowerCase();
                const files = v.files.filter(
                  (f) =>
                    (!result || f.result === result) &&
                    `${f.path} ${f.companyName} ${f.readAs}`.toLowerCase().includes(term),
                );
                if (!files.length)
                  return (
                    <Empty>
                      No matching files
                      <button
                        type="button"
                        onClick={() => {
                          setQuery('');
                          setResult('');
                        }}
                      >
                        Clear filters
                      </button>
                    </Empty>
                  );
                return (
                  <table className="records-table import-table">
                    <caption className="sr-only">Files in this import</caption>
                    <colgroup>
                      <col style={{ width: '27%' }} />
                      <col style={{ width: '23%' }} />
                      <col style={{ width: '22%' }} />
                      <col style={{ width: '7%' }} />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Read as</th>
                        <th>Company folder</th>
                        <th className="num">Pages</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => (
                        <tr key={f.id}>
                          <td title={f.path}>{f.name}</td>
                          <td title={f.readAs}>{f.readAs}</td>
                          <td title={f.companyName}>{f.companyName}</td>
                          <td className="num">{f.pages ?? ''}</td>
                          <td
                            title={fileResult(f)}
                            className={f.result === 'Could not read' ? 'blocked' : undefined}
                          >
                            {fileResult(f)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </>
          )}
          {sorting ? (
            <StrayFiles
              view={v}
              onClose={() => setSorting(false)}
              onSaved={async () => {
                setSorting(false);
                await view.reload();
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
