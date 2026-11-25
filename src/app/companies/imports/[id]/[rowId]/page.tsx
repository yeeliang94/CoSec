'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { BackLink, formatDay, useDocumentTitle, useWorkspace } from '@/components/workspace';
import { WarningLine } from '@/components/warning-line';
import { errorText, getJson, postJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import type { CompanyDetail } from '@/components/imports/types';
import {
  COMPANY_ADDRESS_GROUPS,
  COMPANY_PARTICULAR_KEYS,
  companyParticularLabel,
  type CompanyParticularKey,
} from '@/domain/ar1/company';
import { openQuestions, type Source, type Suggestion } from '@/domain/imports';
import { particularLabel, particularOptions } from '@/domain/resolution/particulars';
import { Drawer } from '@/components/resolution/drawer';
import type { ParticularKey } from '@/domain/resolution/model';

const CORE_LABELS: Record<string, string> = {
  name: 'Legal name',
  registrationNumber: 'Registration number',
  incorporationDate: 'Incorporation date',
  financialYearEnd: 'Financial year end',
  industry: 'Industry',
  activity: 'Business activity',
};
const BUSINESS = new Set(['natureOfBusiness', 'msic1', 'msic2', 'msic3', 'industry', 'activity']);
const isAddress = (key: string) => COMPANY_ADDRESS_GROUPS.some((g) => key.startsWith(g));
const fieldLabel = (key: string) =>
  CORE_LABELS[key] ?? companyParticularLabel(key as CompanyParticularKey);
const ROLE_LABELS: Record<string, string> = {
  director: 'Director',
  secretary: 'Secretary',
  manager: 'Manager',
  auditor: 'Auditor',
  other: 'Other',
};

type Step =
  'questions' | 'company' | 'addresses' | 'business' | 'people' | 'shares' | 'charges' | 'files';
const STEPS: [Step, string][] = [
  ['questions', 'Questions'],
  ['company', 'Company details'],
  ['addresses', 'Addresses'],
  ['business', 'Business activity'],
  ['people', 'People and roles'],
  ['shares', 'Shares'],
  ['charges', 'Charges'],
  ['files', 'Files used'],
];
function inStep(step: Step, s: Suggestion) {
  if (s.kind === 'company') {
    if (step === 'addresses') return isAddress(s.key);
    if (step === 'business') return BUSINESS.has(s.key);
    return step === 'company' && !isAddress(s.key) && !BUSINESS.has(s.key);
  }
  if (step === 'people') return s.kind === 'person' || s.kind === 'role';
  if (step === 'shares') return s.kind === 'shares';
  if (step === 'charges') return s.kind === 'charge';
  return false;
}
const yearEnd = (v: string) => {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  return m ? formatDay(`2000-${m[1]}-${m[2]}`).replace(/ 2000$/, '') : v;
};
const day = (v: string | null | undefined) => (v ? formatDay(v) : '');
const key_core = (key: string) => key in CORE_LABELS;
/** The company fields each step shows, in the app's own order. */
function stepKeys(step: Step) {
  const all = [...Object.keys(CORE_LABELS), ...COMPANY_PARTICULAR_KEYS];
  return all.filter((key) =>
    step === 'addresses'
      ? isAddress(key)
      : step === 'business'
        ? BUSINESS.has(key)
        : !isAddress(key) && !BUSINESS.has(key),
  );
}
const display = (key: string, v: string | undefined) =>
  !v
    ? ''
    : key === 'financialYearEnd'
      ? yearEnd(v)
      : key === 'incorporationDate'
        ? formatDay(v)
        : v;

export default function ReviewRoute() {
  return (
    <Suspense fallback={null}>
      <Review />
    </Suspense>
  );
}

function Review() {
  const { id, rowId } = useParams<{ id: string; rowId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { data, refresh } = useWorkspace();
  const url = `/api/imports/${id}/companies/${rowId}`;
  const detail = useLoad(() => getJson<CompanyDetail>(url), [url]);
  const d = detail.data;
  const open = d ? openQuestions(d.row) : [];
  const asked = search.get('step');
  // An unknown step in the address falls back to the first useful one.
  const step: Step = STEPS.some(([s]) => s === asked)
    ? (asked as Step)
    : open.length
      ? 'questions'
      : 'company';
  const [source, setSource] = useState<Source | null>(null);
  const [applying, setApplying] = useState(false);
  const [correcting, setCorrecting] = useState<Suggestion | null>(null);
  const [error, setError] = useState('');
  useDocumentTitle(d?.row.name);
  const files = useMemo(() => new Map((d?.row.files ?? []).map((f) => [f.id, f])), [d]);
  // Show the first value's source when a step opens.
  useEffect(() => {
    if (!d) return;
    const first = d.row.suggestions.find((s) => inStep(step, s));
    setSource(first?.source ?? null);
  }, [d, step]);
  if (!data) return null;
  const goto = (s: Step) => router.replace(`/companies/imports/${id}/${rowId}?step=${s}`);
  const index = STEPS.findIndex(([s]) => s === step);
  /** Sends one change; true when it was saved. */
  async function act(body: Record<string, unknown>) {
    setError('');
    try {
      await postJson(url, body);
      await detail.reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  const setUse = (ids: string[], use: boolean) =>
    act({ action: 'set_use', expectedRevision: d!.row.revision, suggestionIds: ids, use });
  const reviewable = d && ['Ready', 'Needs answer'].includes(d.row.status);
  const unplaced = d?.row.files.some((f) => f.result === 'Another company');
  const changedSince =
    d?.current &&
    d.row.run.seen &&
    (d.current.revisions.company !== d.row.run.seen.company ||
      d.current.revisions.profile !== d.row.run.seen.profile);

  return (
    <div className="import-review">
      <header className="import-review-header">
        <BackLink href={`/companies/imports/${id}`} label={d?.batch.name ?? 'Import'} />
        <div className="import-review-title">
          <h1>
            {d?.row.name ?? 'Company'}
            {d?.row.registrationNumber ? (
              <span className="record-number">{d.row.registrationNumber}</span>
            ) : null}
          </h1>
          {d ? (
            <div className="header-actions">
              <Link className="button" href={`/companies/imports/${id}`}>
                Leave for later
              </Link>
              <button
                type="button"
                className="primary"
                disabled={!reviewable || open.length > 0 || d.row.status !== 'Ready' || unplaced}
                onClick={() => setApplying(true)}
              >
                Apply to records
              </button>
            </div>
          ) : null}
        </div>
        {d && open.length ? (
          <WarningLine
            action={
              step !== 'questions' ? (
                <button type="button" className="section-link" onClick={() => goto('questions')}>
                  Answer
                </button>
              ) : null
            }
          >
            {open.length} {open.length === 1 ? 'question needs' : 'questions need'} your answer
            before this company can be applied.
          </WarningLine>
        ) : null}
        {d && (d.row.status === 'Waiting' || d.row.status === 'Reading') ? (
          <WarningLine
            action={
              <button type="button" className="section-link" onClick={() => void detail.reload()}>
                Refresh
              </button>
            }
          >
            This company is being read again with your answers or new files.
          </WarningLine>
        ) : null}
        {d?.row.status === 'Could not finish' ? (
          <WarningLine
            blocking
            action={
              <button
                type="button"
                className="section-link"
                onClick={() => void act({ action: 'run_again', expectedRevision: d.row.revision })}
              >
                Run again
              </button>
            }
          >
            {d.row.run.error ?? 'Reading could not finish.'}
          </WarningLine>
        ) : null}
        {unplaced ? (
          <WarningLine
            blocking
            action={
              <Link className="section-link" href={`/companies/imports/${id}`}>
                Place files
              </Link>
            }
          >
            Some files look like they belong to another company. Place them before applying.
          </WarningLine>
        ) : null}
        {changedSince ? (
          <WarningLine>
            The company record changed in the app after these files were read. Check the In the app
            column.
          </WarningLine>
        ) : null}
        {error ? (
          <p className="feedback error" role="alert">
            {error}
          </p>
        ) : null}
      </header>
      <LoadState
        loading={detail.loading && !d}
        error={detail.error}
        reload={() => void detail.reload()}
        label="this company"
      />
      {d ? (
        <div className="import-review-body">
          <nav className="import-steps" aria-label="Import sections">
            {STEPS.map(([key, label]) => {
              const warn =
                key === 'questions'
                  ? open.length > 0
                  : key === 'people'
                    ? Object.values(d.matches).some((m) => m.some((x) => !x.visible))
                    : false;
              return (
                <button
                  key={key}
                  type="button"
                  aria-current={key === step ? 'step' : undefined}
                  onClick={() => goto(key)}
                >
                  {label}
                  {warn ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      role="img"
                      aria-label="Needs your attention"
                    >
                      <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <section className="import-review-main" aria-label={STEPS[index][1]}>
            <div className="import-review-scroll">
              <StepBody
                step={step}
                d={d}
                files={files}
                source={source}
                setSource={setSource}
                setUse={setUse}
                act={act}
                reviewable={Boolean(reviewable)}
                onCorrect={reviewable ? setCorrecting : null}
              />
            </div>
            <footer className="import-review-footer">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => goto(STEPS[index - 1][0])}
              >
                Back
              </button>
              <button
                type="button"
                disabled={index === STEPS.length - 1}
                onClick={() => goto(STEPS[index + 1][0])}
              >
                Continue
              </button>
            </footer>
          </section>
          <SourcePanel
            importId={id}
            source={source}
            file={source ? files.get(source.fileId) : undefined}
          />
        </div>
      ) : null}
      {correcting && d ? (
        <CorrectDrawer
          s={correcting}
          d={d}
          files={files}
          canSeeIdentity={data.actor.capabilities.includes('view_identity')}
          onClose={() => setCorrecting(null)}
          save={async (fields) => {
            const ok = await act({
              action: 'correct',
              expectedRevision: d.row.revision,
              suggestionId: correcting.id,
              fields,
            });
            if (ok) setCorrecting(null);
            return ok;
          }}
        />
      ) : null}
      {applying && d ? (
        <ApplyDialog
          d={d}
          url={url}
          onClose={() => setApplying(false)}
          onApplied={async () => {
            // A new company joins the people who can open it, so the workspace list reloads.
            await refresh();
            router.push(`/companies/imports/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

type Files = Map<string, CompanyDetail['row']['files'][number]>;
function SourceCell({
  s,
  files,
  setSource,
}: {
  s: Suggestion | { source: Source };
  files: Files;
  setSource: (s: Source) => void;
}) {
  const file = files.get(s.source.fileId);
  // A value the reviewer typed in has no file to show.
  if (!s.source.fileId)
    return (
      <td className="source muted" title={s.source.quote}>
        {s.source.quote}
      </td>
    );
  const label = `${file?.name ?? 'File'}${s.source.page ? `, p. ${s.source.page}` : ''}`;
  const corrected = 'correctedBy' in s && s.correctedBy;
  return (
    <td className="source" title={corrected ? `${label}, corrected by ${corrected}` : label}>
      <button type="button" onClick={() => setSource(s.source)}>
        {label}
      </button>
      {corrected ? ', corrected' : null}
    </td>
  );
}

function CheckCell({
  s,
  setUse,
  reviewable,
}: {
  s: Suggestion;
  setUse: (ids: string[], use: boolean) => void;
  reviewable: boolean;
}) {
  return (
    <td>
      <input
        type="checkbox"
        aria-label="Use this value"
        checked={s.use}
        disabled={!reviewable}
        onChange={(e) => setUse([s.id], e.target.checked)}
      />
    </td>
  );
}
function AllCheck({
  items,
  setUse,
  reviewable,
}: {
  items: Suggestion[];
  setUse: (ids: string[], use: boolean) => void;
  reviewable: boolean;
}) {
  const all = items.length > 0 && items.every((s) => s.use);
  return (
    <th>
      <input
        type="checkbox"
        aria-label="Use all"
        checked={all}
        disabled={!reviewable || !items.length}
        onChange={(e) =>
          setUse(
            items.map((s) => s.id),
            e.target.checked,
          )
        }
      />
    </th>
  );
}

function StepBody({
  step,
  d,
  files,
  source,
  setSource,
  setUse,
  act,
  reviewable,
  onCorrect,
}: {
  step: Step;
  d: CompanyDetail;
  files: Files;
  source: Source | null;
  setSource: (s: Source) => void;
  setUse: (ids: string[], use: boolean) => void;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  reviewable: boolean;
  onCorrect: ((s: Suggestion) => void) | null;
}) {
  const nameCell = (s: Suggestion, text: string) => (
    <td title={text}>
      {onCorrect ? (
        <button type="button" className="import-name-link" onClick={() => onCorrect(s)}>
          {text}
        </button>
      ) : (
        text
      )}
    </td>
  );
  const items = d.row.suggestions.filter((s) => inStep(step, s));
  const existing = d.row.target.mode === 'existing';
  const selected = (s: Suggestion) => (source && s.source === source ? 'selected' : undefined);
  const empty = <p className="import-note">The files did not give any values for this section.</p>;

  if (step === 'questions')
    return d.row.questions.length ? (
      <section>
        <h2>Questions</h2>
        {d.row.questions.map((q) => (
          <Question
            key={q.id}
            q={q}
            files={files}
            setSource={setSource}
            reviewable={reviewable}
            answer={(choice, text) =>
              act({
                action: 'answer',
                expectedRevision: d.row.revision,
                questionId: q.id,
                choice,
                text,
              })
            }
          />
        ))}
      </section>
    ) : (
      <section>
        <h2>Questions</h2>
        <p className="import-note">The agent had no questions about this company.</p>
      </section>
    );

  if (step === 'company' || step === 'addresses' || step === 'business') {
    const title =
      step === 'company'
        ? 'Company details'
        : step === 'addresses'
          ? 'Addresses'
          : 'Business activity';
    const company = items.filter(
      (s): s is Extract<Suggestion, { kind: 'company' }> => s.kind === 'company',
    );
    const fixed = (key: string) => existing && key in CORE_LABELS;
    const usable = company.filter((s) => !fixed(s.key));
    const missing = existing || step !== 'company' ? [] : d.plan.missing;
    const differs = company.some(
      (s) => fixed(s.key) && d.current?.company[s.key] && d.current.company[s.key] !== s.value,
    );
    return (
      <>
        <section>
          <h2>{title}</h2>
          {company.length ? (
            <table className="records-table import-values">
              <caption className="sr-only">{title}</caption>
              <colgroup>
                <col className="check" />
                <col style={{ width: '24%' }} />
                <col style={{ width: '17%' }} />
                <col style={{ width: '19%' }} />
                <col style={{ width: '15%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <AllCheck items={usable} setUse={setUse} reviewable={reviewable} />
                  <th>Field</th>
                  <th>In the app</th>
                  <th>Suggested</th>
                  <th>Applies from</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {company.map((s) => {
                  const now = d.current?.company[s.key];
                  const same = now !== undefined && now === s.value;
                  return (
                    <tr key={s.id} className={selected(s)}>
                      {fixed(s.key) ? (
                        <td>
                          {now !== s.value ? (
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              role="img"
                              aria-label="Not changed by the import"
                            >
                              <path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" />
                            </svg>
                          ) : null}
                        </td>
                      ) : (
                        <CheckCell s={s} setUse={setUse} reviewable={reviewable} />
                      )}
                      <td title={fieldLabel(s.key)}>{fieldLabel(s.key)}</td>
                      <td title={now}>{display(s.key, now)}</td>
                      <td title={s.value} className={same ? 'same' : undefined}>
                        {same ? 'Same' : display(s.key, s.value)}
                      </td>
                      <td className={s.effectiveDate ? undefined : 'muted'}>
                        {fixed(s.key) || key_core(s.key)
                          ? ''
                          : s.effectiveDate
                            ? day(s.effectiveDate)
                            : existing
                              ? 'Today'
                              : 'Incorporation'}
                      </td>
                      <SourceCell s={s} files={files} setSource={setSource} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            empty
          )}
          {differs ? (
            <WarningLine>
              The name, number, dates and activity of an existing company are not changed by an
              import. Check any difference on the company page.
            </WarningLine>
          ) : null}
          {missing.length ? (
            <WarningLine blocking>A new company needs: {missing.join(', ')}.</WarningLine>
          ) : null}
          {reviewable ? (
            <ValueForm
              key={step}
              keys={stepKeys(step).filter((k) => !fixed(k))}
              save={(key, value, effectiveDate) =>
                act({
                  action: 'set_value',
                  expectedRevision: d.row.revision,
                  key,
                  value,
                  effectiveDate,
                })
              }
            />
          ) : null}
        </section>
        {step === 'company' && d.row.run.notFound.length ? (
          <section>
            <h3>Not found in the files</h3>
            <table className="records-table import-values">
              <caption className="sr-only">Not found in the files</caption>
              <tbody>
                {d.row.run.notFound.map((n) => (
                  <tr key={n}>
                    <td title={n}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </>
    );
  }

  if (step === 'people') {
    const people = items.filter(
      (s): s is Extract<Suggestion, { kind: 'person' }> => s.kind === 'person',
    );
    const roles = items.filter(
      (s): s is Extract<Suggestion, { kind: 'role' }> => s.kind === 'role',
    );
    const nameOf = (ref: string) => people.find((p) => p.ref === ref)?.fullName ?? null;
    const inApp = (p: (typeof people)[number]) => {
      const m = d.matches[p.ref] ?? [];
      if (m.some((x) => !x.visible)) return 'In a company you cannot open';
      if (m.length) return 'Same person';
      return p.personKind === 'organisation' ? 'New organisation' : 'New person';
    };
    const sameName = (p: (typeof people)[number]) => d.nameMatches[p.ref] ?? [];
    return (
      <>
        <section>
          <h2>People</h2>
          {people.length ? (
            <table className="records-table import-values">
              <caption className="sr-only">People</caption>
              <colgroup>
                <col className="check" />
                <col style={{ width: '30%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '24%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <AllCheck items={people} setUse={setUse} reviewable={reviewable} />
                  <th>Name</th>
                  <th>Identity no.</th>
                  <th>In the app</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className={selected(p)}>
                    <CheckCell s={p} setUse={setUse} reviewable={reviewable} />
                    {nameCell(p, p.fullName)}
                    <td className="tabular">{p.values.identityNumber ?? ''}</td>
                    {sameName(p).length && !(d.matches[p.ref] ?? []).length ? (
                      <td>
                        <select
                          aria-label={`Is ${p.fullName} someone already in the app?`}
                          value={p.linkTo === undefined ? '' : (p.linkTo ?? 'new')}
                          disabled={!reviewable}
                          onChange={(e) =>
                            void act({
                              action: 'set_link',
                              expectedRevision: d.row.revision,
                              suggestionId: p.id,
                              personId: e.target.value === 'new' ? null : e.target.value,
                            })
                          }
                        >
                          {p.linkTo === undefined ? (
                            <option value="">Same name in the app</option>
                          ) : null}
                          {sameName(p).map((m) => (
                            <option key={m.personId} value={m.personId}>
                              Same as {m.fullName}
                            </option>
                          ))}
                          <option value="new">
                            {p.personKind === 'organisation' ? 'New organisation' : 'New person'}
                          </option>
                        </select>
                      </td>
                    ) : (
                      <td className={inApp(p).startsWith('In a company') ? 'blocked' : undefined}>
                        {inApp(p)}
                      </td>
                    )}
                    <SourceCell s={p} files={files} setSource={setSource} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty
          )}
          {people.some((p) => inApp(p).startsWith('In a company')) ? (
            <WarningLine blocking>
              Someone here is already in the app, linked to a company you cannot open. Ask an admin
              for access before applying.
            </WarningLine>
          ) : null}
        </section>
        <PersonDetails people={people} d={d} />
        <section>
          <h2>Roles</h2>
          {roles.length ? (
            <table className="records-table import-values">
              <caption className="sr-only">Roles</caption>
              <colgroup>
                <col className="check" />
                <col style={{ width: '28%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '15%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <AllCheck items={roles} setUse={setUse} reviewable={reviewable} />
                  <th>Person</th>
                  <th>Role</th>
                  <th>From</th>
                  <th>Until</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id} className={selected(r)}>
                    <CheckCell s={r} setUse={setUse} reviewable={reviewable} />
                    {nameOf(r.personRef) ? (
                      nameCell(r, nameOf(r.personRef)!)
                    ) : (
                      <td className="blocked">Person not found in the files</td>
                    )}
                    <td>{ROLE_LABELS[r.role] ?? r.role}</td>
                    <td>{day(r.startDate)}</td>
                    <td>{day(r.endDate)}</td>
                    <SourceCell s={r} files={files} setSource={setSource} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty
          )}
          {roles.some((r) => !nameOf(r.personRef)) ? (
            <WarningLine blocking>
              A role names a person the files did not describe. Untick it, or run this company
              again.
            </WarningLine>
          ) : null}
        </section>
      </>
    );
  }

  if (step === 'shares') {
    const holdings = items.filter(
      (s): s is Extract<Suggestion, { kind: 'shares' }> => s.kind === 'shares',
    );
    const people = d.row.suggestions.filter(
      (s): s is Extract<Suggestion, { kind: 'person' }> => s.kind === 'person',
    );
    const holder = (refs: string[]) =>
      refs.map((r) => people.find((p) => p.ref === r)?.fullName ?? r).join(' and ');
    return (
      <section>
        <h2>Shares</h2>
        {d.current?.shareEntries ? (
          <WarningLine>
            This company already keeps a share register, so these holdings will not be added.
          </WarningLine>
        ) : null}
        {holdings.length ? (
          <table className="records-table import-values">
            <caption className="sr-only">Shareholdings</caption>
            <colgroup>
              <col className="check" />
              <col style={{ width: '24%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '14%' }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <AllCheck items={holdings} setUse={setUse} reviewable={reviewable} />
                <th>Holder</th>
                <th>Class</th>
                <th className="num">Shares</th>
                <th className="num">Paid (MYR)</th>
                <th>As at</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.id} className={selected(h)}>
                  <CheckCell s={h} setUse={setUse} reviewable={reviewable} />
                  {nameCell(h, holder(h.personRefs))}
                  <td>{h.className}</td>
                  <td className="num">{Number(h.shares).toLocaleString('en-MY')}</td>
                  <td className="num">{h.amountPaid ?? ''}</td>
                  <td>{day(h.date)}</td>
                  <SourceCell s={h} files={files} setSource={setSource} />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          empty
        )}
      </section>
    );
  }

  if (step === 'charges') {
    const charges = items.filter(
      (s): s is Extract<Suggestion, { kind: 'charge' }> => s.kind === 'charge',
    );
    return (
      <section>
        <h2>Charges</h2>
        {charges.length ? (
          <table className="records-table import-values">
            <caption className="sr-only">Charges</caption>
            <colgroup>
              <col className="check" />
              <col style={{ width: '16%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '14%' }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <AllCheck items={charges} setUse={setUse} reviewable={reviewable} />
                <th>Charge no.</th>
                <th>Registered</th>
                <th>Chargee</th>
                <th className="num">Amount (MYR)</th>
                <th>Discharged</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.id} className={selected(c)}>
                  <CheckCell s={c} setUse={setUse} reviewable={reviewable} />
                  {nameCell(c, c.registeredNumber)}
                  <td>{day(c.registeredOn)}</td>
                  <td title={c.chargee}>{c.chargee}</td>
                  <td className="num">{c.amount}</td>
                  <td>{day(c.dischargedOn)}</td>
                  <SourceCell s={c} files={files} setSource={setSource} />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          empty
        )}
      </section>
    );
  }

  return (
    <section>
      <h2>Files used</h2>
      <table className="records-table import-values">
        <caption className="sr-only">Files in this company folder</caption>
        <colgroup>
          <col style={{ width: '32%' }} />
          <col style={{ width: '28%' }} />
          <col style={{ width: '8%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>File</th>
            <th>Read as</th>
            <th className="num">Pages</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {d.row.files.map((f) => (
            <tr key={f.id}>
              <td title={f.path}>
                {f.storageKey ? (
                  <button
                    type="button"
                    className="section-link"
                    onClick={() => setSource({ fileId: f.id, page: 1, quote: '' })}
                  >
                    {f.name}
                  </button>
                ) : (
                  f.name
                )}
              </td>
              <td title={f.readAs}>{f.readAs}</td>
              <td className="num">{f.pages ?? ''}</td>
              <td className={f.result === 'Could not read' ? 'blocked' : undefined} title={f.note}>
                {f.result === 'Used'
                  ? `Used for ${f.note}`
                  : f.result === 'Another company'
                    ? `Looks like ${f.otherCompany}`
                    : f.note
                      ? `${f.result}: ${f.note}`
                      : f.result}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Question({
  q,
  files,
  setSource,
  reviewable,
  answer,
}: {
  q: CompanyDetail['row']['questions'][number];
  files: Files;
  setSource: (s: Source) => void;
  reviewable: boolean;
  answer: (choice: number | null, text: string) => Promise<unknown>;
}) {
  const [choice, setChoice] = useState<number | null>(q.answer?.choice ?? q.suggested);
  const [text, setText] = useState(q.answer?.text ?? '');
  const [pending, setPending] = useState(false);
  return (
    <div className="import-question">
      <p>{q.text}</p>
      <fieldset className="option-list" disabled={!reviewable || pending}>
        <legend className="sr-only">{q.text}</legend>
        {q.choices.map((c, i) => (
          <div className="option-row" key={i}>
            <label className="inline">
              <input
                type="radio"
                name={q.id}
                checked={choice === i}
                onChange={() => setChoice(i)}
              />
              {c.label}
              {q.suggested === i ? ' (suggested)' : ''}
            </label>
            {c.source ? (
              <button
                type="button"
                className="section-link evidence"
                onClick={() => setSource(c.source!)}
              >
                {files.get(c.source.fileId)?.name ?? 'Source'}
                {c.source.page ? `, p. ${c.source.page}` : ''}
              </button>
            ) : null}
          </div>
        ))}
        <label>
          <span className="sr-only">Or write your answer</span>
          <textarea
            rows={2}
            placeholder="Or write your answer"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </fieldset>
      <div className="actions">
        <button
          type="button"
          disabled={!reviewable || pending || (choice === null && !text.trim())}
          onClick={async () => {
            setPending(true);
            await answer(text.trim() && choice === null ? null : choice, text.trim());
            setPending(false);
          }}
        >
          {q.answer ? 'Change answer' : 'Save answer'}
        </button>
        {q.answer ? <span className="metadata">Answered {formatDay(q.answer.at)}</span> : null}
      </div>
    </div>
  );
}

type PageText = { pages: number; page: number; text: string; visual: boolean };
function SourcePanel({
  importId,
  source,
  file,
}: {
  importId: string;
  source: Source | null;
  file?: CompanyDetail['row']['files'][number];
}) {
  const [page, setPage] = useState<PageText | null>(null);
  const [error, setError] = useState('');
  const key = source && file ? `${file.id}:${source.page ?? 1}` : '';
  useEffect(() => {
    setPage(null);
    setError('');
    if (!source || !file?.storageKey) return;
    let live = true;
    getJson<PageText>(`/api/imports/${importId}/files/${file.id}?page=${source.page ?? 1}`)
      .then((p) => live && setPage(p))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, importId]);
  const fileUrl = file ? `/api/imports/${importId}/files/${file.id}` : '';
  return (
    <aside className="import-source" aria-label="Source">
      {source && file ? (
        <>
          <div className="import-source-head">
            <strong title={file.name}>{file.name}</strong>
            <span>
              {[
                file.readAs,
                source.page ? `page ${source.page}${file.pages ? ` of ${file.pages}` : ''}` : '',
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          </div>
          <div className="import-source-body">
            {!file.storageKey ? (
              <p className="import-source-empty">This file is no longer kept.</p>
            ) : error ? (
              <p className="feedback error">{error}</p>
            ) : !page ? (
              <p className="import-source-empty">Opening the page…</p>
            ) : page.visual && file.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl} alt={`${file.name}`} />
            ) : page.visual ? (
              <iframe
                title={`${file.name}, page ${source.page ?? 1}`}
                src={`${fileUrl}#page=${source.page ?? 1}`}
              />
            ) : (
              <Highlighted text={page.text} quote={source.quote} />
            )}
          </div>
          {source.quote ? (
            <p className="import-source-quote">Read as: &ldquo;{source.quote}&rdquo;</p>
          ) : null}
        </>
      ) : (
        <p className="import-source-empty">Choose a source to see the page it came from.</p>
      )}
    </aside>
  );
}

/** The page text with the quoted value marked, matching across spaces and line breaks. */
function Highlighted({ text, quote }: { text: string; quote: string }) {
  const ref = useRef<HTMLElement>(null);
  const parts = useMemo(() => {
    const q = quote.trim();
    if (!q) return [text];
    const pattern = new RegExp(
      q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
      'i',
    );
    const m = pattern.exec(text);
    return m ? [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)] : [text];
  }, [text, quote]);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center' });
  }, [parts]);
  return (
    <pre>
      {parts[0]}
      {parts.length === 3 ? (
        <>
          <mark ref={ref}>{parts[1]}</mark>
          {parts[2]}
        </>
      ) : null}
    </pre>
  );
}

function ApplyDialog({
  d,
  url,
  onClose,
  onApplied,
}: {
  d: CompanyDetail;
  url: string;
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const p = d.plan;
  const rows: [string, number][] = [
    ['Company values', p.company],
    ['People', p.people],
    ['Roles', p.roles],
    ['Share holdings, as drafts', p.shares],
    ['Charges', p.charges],
    ['Source files saved to Documents', p.files],
  ];
  const isNew = d.row.target.mode === 'new';
  return (
    <dialog
      ref={ref}
      className="import-apply"
      aria-labelledby="apply-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="import-apply-body">
        <h2 id="apply-title">Apply to records</h2>
        <table className="records-table">
          <caption className="sr-only">What will be written</caption>
          <tbody>
            {rows
              .filter(([, n]) => n > 0)
              .map(([label, n]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{n}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {p.missing.length ? (
          <WarningLine blocking>A new company needs: {p.missing.join(', ')}.</WarningLine>
        ) : null}
        <p>
          {isNew
            ? 'The new company stays Unverified until someone else does the opening review. Ask an admin to give that person access to the company.'
            : 'Each change is recorded in the company history with this import and its source file.'}
        </p>
        <p>Either everything here is saved or nothing is.</p>
        {error ? (
          <p className="feedback error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="import-apply-actions">
        <button type="button" disabled={pending} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={pending || p.missing.length > 0}
          onClick={async () => {
            setPending(true);
            setError('');
            try {
              await postJson(url, {
                action: 'apply',
                expectedRevision: d.row.revision,
                requestId: requestId.current,
              });
              await onApplied();
            } catch (e) {
              setError(errorText(e));
              setPending(false);
            }
          }}
        >
          {pending ? 'Applying…' : 'Apply to records'}
        </button>
      </div>
    </dialog>
  );
}

/** Adds a value the files did not give, or corrects one; it is saved as entered by the reviewer. */
function ValueForm({
  keys,
  save,
}: {
  keys: string[];
  save: (key: string, value: string, effectiveDate: string | null) => Promise<boolean>;
}) {
  const [picked, setKey] = useState(keys[0] ?? '');
  const key = keys.includes(picked) ? picked : (keys[0] ?? '');
  const [value, setValue] = useState('');
  const [date, setDate] = useState('');
  const [pending, setPending] = useState(false);
  if (!keys.length) return null;
  return (
    <form
      className="import-value-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        // The typed value stays when the save fails, so nothing has to be typed again.
        if (await save(key, value, date || null)) {
          setValue('');
          setDate('');
        }
        setPending(false);
      }}
    >
      <label>
        Field
        <select value={key} onChange={(e) => setKey(e.target.value)}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {fieldLabel(k)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Value
        <input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={2000} />
      </label>
      <label>
        Applies from
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <button type="submit" disabled={pending || !value.trim()}>
        {pending ? 'Saving…' : 'Save value'}
      </button>
    </form>
  );
}

/** Every particular a ticked person would carry into the app, beside what the app holds now. */
function PersonDetails({
  people,
  d,
}: {
  people: Extract<Suggestion, { kind: 'person' }>[];
  d: CompanyDetail;
}) {
  const rows = people.flatMap((p) =>
    Object.entries(p.values)
      .filter(([key]) => key !== 'identityNumber')
      .map(([key, value]) => ({ p, key, value, now: d.personValues[p.ref]?.[key] })),
  );
  if (!rows.length) return null;
  return (
    <section>
      <h2>Particulars</h2>
      <table className="records-table import-values">
        <caption className="sr-only">Particulars of the people</caption>
        <colgroup>
          <col style={{ width: '26%' }} />
          <col style={{ width: '24%' }} />
          <col style={{ width: '25%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Person</th>
            <th>Field</th>
            <th>In the app</th>
            <th>Suggested</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, key, value, now }) => {
            const label = particularLabel(key as ParticularKey, p.personKind) ?? key;
            // A hidden value is never shown as matching: the two dates may differ.
            const same = now !== undefined && now === value && value !== 'Hidden';
            return (
              <tr key={`${p.id}:${key}`} className={p.use ? undefined : 'muted'}>
                <td title={p.fullName}>{p.fullName}</td>
                <td title={label}>{label}</td>
                <td title={now}>{now ?? ''}</td>
                <td title={value} className={same ? 'same' : undefined}>
                  {same ? 'Same' : value}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

type FieldDef = {
  key: string;
  label: string;
  type?: 'date' | 'select';
  options?: readonly string[];
  wide?: boolean;
  disabled?: boolean;
};
const PERSON_KEYS = ['identityType', 'identityNumber', 'dateOfBirth', 'nationality', 'occupation'];
const IDENTITY_KEYS = ['identityType', 'identityNumber', 'dateOfBirth', 'passportExpiry'];
const DATE_KEYS = ['dateOfBirth', 'passportExpiry'];

/** The fields a correction offers for each kind of suggestion, with their current values. */
function correctionFields(
  s: Suggestion,
  canSeeIdentity: boolean,
): [FieldDef[], Record<string, string>] {
  if (s.kind === 'person') {
    const keys = [...new Set([...PERSON_KEYS, ...Object.keys(s.values)])].filter(
      (k) => s.personKind === 'individual' || k !== 'dateOfBirth',
    );
    // Identity particulars arrive masked without view_identity, so they cannot be corrected.
    const locked = !canSeeIdentity;
    return [
      [
        { key: 'fullName', label: 'Full name', wide: true },
        ...keys.map((k) => {
          const options = particularOptions(k as ParticularKey, s.personKind);
          const disabled = locked && IDENTITY_KEYS.includes(k);
          return {
            key: k,
            label: particularLabel(k as ParticularKey, s.personKind) ?? k,
            type: disabled
              ? undefined
              : options
                ? ('select' as const)
                : DATE_KEYS.includes(k)
                  ? ('date' as const)
                  : undefined,
            options: options ?? undefined,
            disabled,
          };
        }),
        { key: 'effectiveDate', label: 'Applies from', type: 'date' },
      ],
      { fullName: s.fullName, ...s.values, effectiveDate: s.effectiveDate ?? '' },
    ];
  }
  if (s.kind === 'role')
    return [
      [
        { key: 'role', label: 'Role', type: 'select', options: Object.keys(ROLE_LABELS) },
        {
          key: 'cessation',
          label: 'Reason for leaving',
          type: 'select',
          options: ['', ...Object.keys(CESSATION_LABELS)],
        },
        { key: 'startDate', label: 'From', type: 'date' },
        { key: 'endDate', label: 'Until', type: 'date' },
      ],
      {
        role: s.role,
        startDate: s.startDate ?? '',
        endDate: s.endDate ?? '',
        cessation: s.cessation ?? '',
      },
    ];
  if (s.kind === 'shares')
    return [
      [
        { key: 'className', label: 'Class' },
        {
          key: 'classKind',
          label: 'Kind',
          type: 'select',
          options: ['Ordinary', 'Preference', 'Other'],
        },
        { key: 'shares', label: 'Shares' },
        { key: 'date', label: 'As at', type: 'date' },
        { key: 'amountPaid', label: 'Amount paid (MYR)' },
        { key: 'amountPayable', label: 'Amount payable (MYR)' },
        {
          key: 'consideration',
          label: 'Consideration',
          type: 'select',
          options: ['', 'Cash', 'Otherwise than cash'],
        },
      ],
      {
        className: s.className,
        classKind: s.classKind,
        shares: s.shares,
        date: s.date,
        amountPaid: s.amountPaid ?? '',
        amountPayable: s.amountPayable ?? '',
        consideration: s.consideration ?? '',
      },
    ];
  if (s.kind === 'charge')
    return [
      [
        { key: 'registeredNumber', label: 'Charge number' },
        { key: 'registeredOn', label: 'Registered on', type: 'date' },
        { key: 'chargee', label: 'Chargee', wide: true },
        { key: 'nature', label: 'Nature', wide: true },
        { key: 'amount', label: 'Amount (MYR)' },
        { key: 'dischargedOn', label: 'Discharged on', type: 'date' },
      ],
      {
        registeredNumber: s.registeredNumber,
        registeredOn: s.registeredOn,
        chargee: s.chargee,
        nature: s.nature,
        amount: s.amount,
        dischargedOn: s.dischargedOn ?? '',
      },
    ];
  return [[], {}];
}
const CESSATION_LABELS: Record<string, string> = {
  resignation: 'Resignation',
  removal: 'Removal',
  other_cessation: 'Other cessation',
};
const optionLabel = (key: string, o: string) =>
  key === 'role' ? (ROLE_LABELS[o] ?? o) : key === 'cessation' ? (CESSATION_LABELS[o] ?? o) : o;

/** Corrects one person, role, holding or charge the agent suggested; the source stays with it. */
function CorrectDrawer({
  s,
  d,
  files,
  canSeeIdentity,
  onClose,
  save,
}: {
  s: Suggestion;
  d: CompanyDetail;
  files: Files;
  canSeeIdentity: boolean;
  onClose: () => void;
  save: (fields: Record<string, string | null>) => Promise<boolean>;
}) {
  const [defs, initial] = useMemo(() => correctionFields(s, canSeeIdentity), [s, canSeeIdentity]);
  const [values, setValues] = useState(initial);
  const [pending, setPending] = useState(false);
  const people = d.row.suggestions.filter(
    (x): x is Extract<Suggestion, { kind: 'person' }> => x.kind === 'person',
  );
  const nameOf = (ref: string) => people.find((p) => p.ref === ref)?.fullName ?? ref;
  const title =
    s.kind === 'person'
      ? `Correct ${s.fullName}`
      : s.kind === 'role'
        ? `Correct role of ${nameOf(s.personRef)}`
        : s.kind === 'shares'
          ? `Correct holding of ${s.personRefs.map(nameOf).join(' and ')}`
          : s.kind === 'charge'
            ? `Correct charge ${s.registeredNumber}`
            : 'Correct';
  const file = files.get(s.source.fileId);
  const dirty = defs.some((f) => (values[f.key] ?? '') !== (initial[f.key] ?? ''));
  return (
    <Drawer title={title} onClose={onClose}>
      <form
        className="import-correct-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          await save(
            Object.fromEntries(
              defs.filter((f) => !f.disabled).map((f) => [f.key, values[f.key] || null]),
            ),
          );
          setPending(false);
        }}
      >
        {defs.map((f) => (
          <label key={f.key} className={f.wide ? 'wide' : undefined}>
            {f.label}
            {f.type === 'select' ? (
              <select
                value={values[f.key] ?? ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              >
                {f.options!.includes(values[f.key] ?? '') ? null : (
                  <option value={values[f.key] ?? ''}>{values[f.key] ?? ''}</option>
                )}
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {optionLabel(f.key, o)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type === 'date' ? 'date' : 'text'}
                value={values[f.key] ?? ''}
                disabled={f.disabled}
                maxLength={2000}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        {file ? (
          <p className="import-correct-source wide">
            From {file.name}
            {s.source.page ? `, page ${s.source.page}` : ''}
          </p>
        ) : null}
        <div className="import-drawer-actions wide">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
