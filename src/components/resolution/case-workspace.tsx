'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ResolutionCase } from '@/domain/resolution/model';
import { caseStatus, isEditable } from '@/domain/resolution/cases';
import { canLeaveEditing, hasUnsavedEdits } from '@/components/edit-guard';
import {
  Empty,
  formatDate,
  formatDay,
  formatDatesIn,
  Icon,
  useWorkspace,
} from '@/components/workspace';
import {
  ApiError,
  CASE_DETAILS_PATHS,
  errorText,
  isSignerIssue,
  getJson,
  kindLabel,
  newRequestId,
  postJson,
  type CaseDetail,
  type Issue,
  type IssueField,
} from './api';
import { LoadState, useLoad } from './use-load';
import { CaseClauses } from './case-clauses';
import { CaseQuestions } from './case-questions';
import { CasePreview } from './case-preview';
import { CompleteResolution, Finish, Paused, YourReview } from './case-finish';
import { Drawer } from './drawer';
import { RowMenu } from '@/components/menu';
import { useCaseAutosave, type UnsavedState } from './use-case-autosave';

/** What links the working pane and the preview pane. */
export type CaseUi = {
  activeFieldIds: string[];
  setActiveFieldIds: (ids: string[]) => void;
  highlightClause: string | null;
  setHighlightClause: (key: string | null) => void;
  candidateVersionId: string | null;
  setCandidateVersionId: (id: string | null) => void;
  gaps: Issue[];
  gapFields: IssueField[];
  setGaps: (gaps: Issue[], fields: IssueField[]) => void;
  goToField: (field: { unit?: string; id: string }) => void;
  goToSigners: () => void;
  goToWording: () => void;
  goToIssue: (issue: Issue) => void;
  nextGap: () => void;
};

export type CaseApi = {
  detail: CaseDetail;
  act: (action: string, payload?: Record<string, unknown>) => Promise<ResolutionCase>;
  /** Waits for earlier saves, then loads the latest case. */
  reload: () => Promise<void>;
  /** Loads the latest case now; for use inside `enqueue`. */
  refresh: () => Promise<void>;
  setCase: (next: ResolutionCase) => void;
  canEdit: boolean;
  /** Saves run one at a time, so each sends the revision the previous one produced. */
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  revision: () => number;
  selectionRevision: () => number;
  /** Reports an automatic save in the header; true when it succeeded. */
  track: (form: string, fn: () => Promise<unknown>) => Promise<boolean>;
  /** Tells the header whether a form has changes that are not saved yet, and why if they cannot be. */
  reportUnsaved: (form: string, state: UnsavedState) => void;
  /** Goes up after Reload latest, so forms still holding changes save them again. */
  retry: number;
  ui: CaseUi;
};

/** The header's save status: a refused or held-back save, a save pending, or when the server last took one. */
export function saveStatusText({
  canEdit,
  failed,
  saving,
  savedAt,
}: {
  canEdit: boolean;
  failed: boolean;
  saving: boolean;
  savedAt: string;
}) {
  if (!canEdit) return '';
  if (failed) return 'Not saved';
  if (saving) return 'Saving…';
  return 'Saved ' + formatDate(savedAt);
}

const STEPS = [
  ['details', 'Details'],
  ['wording', 'Wording'],
  ['answers', 'Answers'],
  ['signers', 'Signers'],
  ['finish', 'Finish'],
] as const;
type Step = (typeof STEPS)[number][0];
/** Links to the old tabs and page sections land on the matching step. */
const OLD_LINKS: Record<string, Step> = {
  overview: 'details',
  prepare: 'answers',
  steps: 'details',
  clauses: 'wording',
  questions: 'answers',
  preview: 'answers',
  documents: 'finish',
};

/** History entries in words; the stored action names are internal. */
const HISTORY_LABELS: Record<string, string> = {
  created: 'Created',
  create: 'Created',
  link_job: 'Linked director change',
  update_details: 'Updated details',
  add_step: 'Added step',
  update_step: 'Updated step',
  record_decision: 'Recorded outcome',
  cancel: 'Cancelled',
  complete: 'Marked complete',
  send_for_review: 'Sent for review',
  review: 'Reviewed',
  reopen: 'Reopened for changes',
  set_custom: 'Changed company value',
  set_selection: 'Selected layout and wording',
  save_answers: 'Saved answers',
  accept_version: 'Updated wording version',
  family_created: 'Started a Word document',
  document_generated: 'Created Word document',
  resolution_attached: 'Attached to job',
};
export function historyLabel(action: string) {
  if (HISTORY_LABELS[action]) return HISTORY_LABELS[action];
  const words = action
    .replace(/^resolution_case\./, '')
    .replaceAll(/[_.]/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isStep = (value: string | null): value is Step => STEPS.some(([key]) => key === value);

export function CaseWorkspace({ id }: { id: string }) {
  const { data } = useWorkspace();
  const router = useRouter();
  const [requested, setRequested] = useState<Step | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeFieldIds, setActiveFieldIds] = useState<string[]>([]);
  const [highlightClause, setHighlightClause] = useState<string | null>(null);
  const [candidateVersionId, setCandidateVersionId] = useState<string | null>(null);
  const [gapState, setGapState] = useState<{ gaps: Issue[]; fields: IssueField[] }>({
    gaps: [],
    fields: [],
  });
  const [saving, setSaving] = useState(0);
  // Per form, so one form saving never hides another form's refused save.
  const [saveErrors, setSaveErrors] = useState<
    Record<string, { message: string; conflict: boolean }>
  >({});
  const [unsavedForms, setUnsavedForms] = useState<Record<string, UnsavedState>>({});
  const [retry, setRetry] = useState(0);
  const [jump, setJump] = useState<{
    fieldId: string;
    unit?: string;
    itemId?: string;
    signers?: boolean;
  } | null>(null);
  const load = useLoad(() => getJson<CaseDetail>('/api/resolution-cases/' + id), [id]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latestRevision = useRef(0);
  const latestSelectionRevision = useRef(0);
  const gapIndex = useRef(-1);
  const gapRef = useRef(gapState);
  gapRef.current = gapState;
  const unsavedRef = useRef(unsavedForms);
  unsavedRef.current = unsavedForms;

  useEffect(() => {
    // The open step lives in the address (?step=finish) so reloads and shared links return to it.
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const param = params.get('step');
      const old = params.get('section') || window.location.hash.slice(1);
      if (isStep(param)) setRequested(param);
      else if (old === 'history') setHistoryOpen(true);
      else if (OLD_LINKS[old]) setRequested(OLD_LINKS[old]);
    };
    read();
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);

  const choose = useCallback((key: Step) => {
    setRequested(key);
    const params = new URLSearchParams(window.location.search);
    params.delete('section');
    params.set('step', key);
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + '?' + params.toString(),
    );
  }, []);

  // Runs after the target step is showing, so the field can take focus.
  useEffect(() => {
    if (!jump) return;
    const root = document.querySelector('.question-form');
    const selector = (value: string) => `[data-field-ids~="${CSS.escape(value)}"]`;
    const target = jump.signers
      ? root?.querySelector<HTMLElement>('[data-signers]')
      : ((jump.unit
          ? root?.querySelector<HTMLElement>(
              `[data-unit="${CSS.escape(jump.unit)}"] ${selector(jump.fieldId)}`,
            )
          : null) ?? root?.querySelector<HTMLElement>(selector(jump.fieldId)));
    if (!target) return;
    // A per-person gap opens that person's cell, not the first one in the table.
    const cell = jump.itemId
      ? target.querySelector<HTMLElement>(
          `[data-item-id="${CSS.escape(jump.itemId)}"] [data-field-id="${CSS.escape(jump.fieldId)}"]`,
        )
      : null;
    const focus = cell ?? target;
    focus.closest('details')?.setAttribute('open', '');
    focus.scrollIntoView({ block: 'center' });
    focus.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }, [jump]);

  const goToField = useCallback(
    (field: { unit?: string; id: string; itemId?: string }) => {
      const known = gapRef.current.fields.find(
        (f) =>
          f.id === field.id &&
          (!field.unit || f.unit === field.unit || (field.unit === '@shared' && f.unit === 'case')),
      );
      const path = known?.source?.path ?? '';
      if (CASE_DETAILS_PATHS.includes(path)) {
        choose('details');
        return;
      }
      // A value worked out from another answer is changed at that answer.
      const id = path.startsWith('selection.') ? path.split('.')[1] : field.id;
      choose('answers');
      setActiveFieldIds([id, field.id]);
      setJump({ fieldId: id, unit: field.unit, itemId: field.itemId });
    },
    [choose],
  );
  const goToSigners = useCallback(() => {
    choose('signers');
    setJump({ fieldId: '', signers: true });
  }, [choose]);
  const goToIssue = useCallback(
    (issue: Issue) => {
      const label = /field "([^"]+)"/.exec(issue.location || '')?.[1];
      const fieldId =
        issue.fieldId ?? gapRef.current.fields.find((f) => f.label === label)?.id ?? null;
      if (fieldId)
        goToField({
          id: fieldId,
          unit: issue.unit === 'case' ? '@shared' : issue.unit,
          itemId: issue.itemId,
        });
      else if (isSignerIssue(issue)) goToSigners();
      else choose('finish');
    },
    [choose, goToField, goToSigners],
  );
  const nextGap = useCallback(() => {
    const { gaps } = gapRef.current;
    if (!gaps.length) return;
    gapIndex.current = (gapIndex.current + 1) % gaps.length;
    goToIssue(gaps[gapIndex.current]);
  }, [goToIssue]);
  const setGaps = useCallback((gaps: Issue[], fields: IssueField[]) => {
    setGapState({ gaps, fields });
  }, []);

  const enqueue = useCallback(<T,>(fn: () => Promise<T>) => {
    const run = queue.current.then(fn, fn);
    queue.current = run.catch(() => {});
    return run;
  }, []);
  const refresh = useCallback(async () => {
    const fresh = await getJson<CaseDetail>('/api/resolution-cases/' + id);
    latestRevision.current = fresh.case.revision;
    latestSelectionRevision.current = fresh.case.selection?.revision ?? 0;
    load.setData(fresh);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const reportUnsaved = useCallback((form: string, state: UnsavedState) => {
    setUnsavedForms((current) => {
      const previous = current[form] ?? { state: 'clean' };
      if (
        previous.state === state.state &&
        (state.state !== 'blocked' ||
          previous.state !== 'blocked' ||
          previous.reason === state.reason)
      )
        return current;
      if (state.state === 'clean') {
        const { [form]: _cleared, ...rest } = current;
        return rest;
      }
      return { ...current, [form]: state };
    });
  }, []);
  const track = useCallback(async (form: string, fn: () => Promise<unknown>) => {
    setSaving((n) => n + 1);
    try {
      await fn();
      setSaveErrors(({ [form]: _cleared, ...rest }) => rest);
      return true;
    } catch (e) {
      setSaveErrors((current) => ({
        ...current,
        [form]: {
          message: errorText(e),
          conflict: e instanceof ApiError && e.status === 409,
        },
      }));
      return false;
    } finally {
      setSaving((n) => n - 1);
    }
  }, []);

  if (!data) return null;
  if (!load.data)
    return (
      <div className="case-loading">
        <Link href="/resolutions" className="back-link">
          <Icon kind="back" />
          Resolutions
        </Link>
        <LoadState
          loading={load.loading}
          error={load.error}
          reload={() => void load.reload()}
          label="resolution"
        />
      </div>
    );
  const detail = load.data;
  const item = detail.case;
  latestRevision.current = Math.max(latestRevision.current, item.revision);
  latestSelectionRevision.current = Math.max(
    latestSelectionRevision.current,
    item.selection?.revision ?? 0,
  );
  const company = data.companies.find((c) => c.id === item.companyId);
  const caps = data.actor.capabilities;
  const canEdit =
    isEditable(item) && (caps.includes('generate_documents') || caps.includes('prepare_job'));
  const userName = (userId: string) => data.users.find((u) => u.id === userId)?.name || userId;
  const review = item.review;
  const me = data.actor.id;
  const closed = item.state !== 'Open';
  const withReviewer = !closed && review?.status === 'With reviewer';
  const myReview = withReviewer && review?.reviewerId === me;
  const approved = !closed && review?.status === 'Approved';
  const showSteps = !closed && !withReviewer && !approved;
  const step: Step = requested ?? (item.selection ? 'answers' : 'wording');
  const api: CaseApi = {
    detail,
    canEdit,
    reload: () => enqueue(refresh),
    refresh,
    enqueue,
    track,
    reportUnsaved,
    retry,
    revision: () => latestRevision.current,
    selectionRevision: () => latestSelectionRevision.current,
    setCase: (next) => load.setData((current) => (current ? { ...current, case: next } : current)),
    act: (action, payload = {}) =>
      enqueue(async () => {
        if (action === 'send_for_review' || action === 'complete') {
          const blocked = Object.values(unsavedRef.current).find((f) => f.state === 'blocked');
          if (blocked && blocked.state === 'blocked') throw new Error(blocked.reason);
          if (hasUnsavedEdits())
            throw new Error(
              Object.keys(unsavedRef.current).length
                ? 'Wait for your changes to save, then try again.'
                : 'Save your changes before sending for review or marking complete.',
            );
        }
        const next = await postJson<ResolutionCase>('/api/resolution-cases/' + id, {
          action,
          expectedRevision: latestRevision.current,
          requestId: newRequestId(),
          ...payload,
        });
        latestRevision.current = next.revision;
        load.setData((current) => (current ? { ...current, case: next } : current));
        return next;
      }),
    ui: {
      activeFieldIds,
      setActiveFieldIds,
      highlightClause,
      setHighlightClause,
      candidateVersionId,
      setCandidateVersionId,
      gaps: gapState.gaps,
      gapFields: gapState.fields,
      setGaps,
      goToField,
      goToSigners,
      goToWording: () => choose('wording'),
      goToIssue,
      nextGap,
    },
  };
  const stepIndex = STEPS.findIndex(([key]) => key === step);
  const entersInDetails = (issue: Issue) =>
    CASE_DETAILS_PATHS.includes(
      gapState.fields.find((f) => f.id === issue.fieldId)?.source?.path ?? '',
    );
  const detailsGap = gapState.gaps.some(entersInDetails);
  const signersGap = gapState.gaps.some(isSignerIssue);
  const answersGap = gapState.gaps.some((i) => !isSignerIssue(i) && !entersInDetails(i));
  const warned = (key: Step) =>
    canEdit &&
    ((key === 'details' && detailsGap) ||
      (key === 'wording' && !item.selection) ||
      (key === 'answers' && answersGap) ||
      (key === 'signers' && signersGap));
  const errors = Object.values(saveErrors);
  const forms = Object.values(unsavedForms);
  const saveText = saveStatusText({
    canEdit,
    failed: errors.length > 0 || forms.some((f) => f.state === 'blocked'),
    saving: saving > 0 || forms.length > 0,
    savedAt: item.updatedAt,
  });
  return (
    <div className="case-frame">
      <header className="case-header">
        <div className="case-header-title">
          <Link href="/resolutions" className="back-link">
            <Icon kind="back" />
            Resolutions
          </Link>
          <h1 title={item.title}>{item.title}</h1>
          <p className="record-number">
            <Link href={'/companies/' + item.companyId}>{company?.name || 'Company'}</Link>{' '}
            {company?.registrationNumber}
          </p>
        </div>
        <div className="case-header-state">
          <span>{myReview ? 'Waiting for your review' : caseStatus(item, userName)}</span>
          <span className="metadata" role="status" aria-live="polite">
            {saveText}
          </span>
          <RowMenu
            name="this resolution"
            items={[
              { label: 'History', onSelect: () => setHistoryOpen(true) },
              {
                label: 'Company details used in resolutions',
                // A direct push skips the link guard, so ask before unsaved entries are dropped.
                onSelect: async () => {
                  if (await canLeaveEditing())
                    router.push('/companies/' + item.companyId + '?tab=settings');
                },
              },
            ]}
          />
        </div>
      </header>
      <div className="case-panes">
        <section className="case-pane" aria-label="Prepare">
          {showSteps ? (
            <nav className="section-nav case-steps" aria-label="Steps">
              {STEPS.map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  className={step === key ? 'active' : ''}
                  aria-current={step === key ? 'step' : undefined}
                  onClick={() => choose(key)}
                >
                  {label}
                  {warned(key) ? (
                    <span role="img" aria-label="Something missing" className="step-warning">
                      <Icon kind="warning" />
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
          ) : null}
          <div className="case-pane-body">
            {errors.map((error, index) => (
              <div className="warning" role="alert" key={index}>
                {error.message}
                {error.conflict ? (
                  <>
                    {' '}
                    Someone else changed this record. Your entries are kept here.{' '}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setSaveErrors({});
                        void api.reload().then(() => setRetry((n) => n + 1));
                      }}
                    >
                      Reload latest
                    </button>
                  </>
                ) : null}
              </div>
            ))}
            {!closed && review?.status === 'Returned' ? (
              <div className="warning" role="status">
                Returned by {userName(review.reviewerId)}: {review.comment}
              </div>
            ) : null}
            {showSteps ? (
              <>
                <div hidden={step !== 'details'}>
                  <Details api={api} />
                </div>
                <div hidden={step !== 'wording'}>
                  <CaseClauses api={api} />
                </div>
                <div hidden={step !== 'answers' && step !== 'signers'}>
                  <CaseQuestions api={api} step={step === 'signers' ? 'signers' : 'answers'} />
                </div>
                <div hidden={step !== 'finish'}>
                  <Finish api={api} />
                </div>
              </>
            ) : myReview ? (
              <>
                <YourReview api={api} />
                <h2 className="case-answers-heading">Answers</h2>
                <CaseQuestions api={api} step="all" />
              </>
            ) : withReviewer ? (
              <Paused api={api} />
            ) : (
              <Finish api={api} />
            )}
          </div>
          {showSteps ? (
            <div className="case-pane-bar">
              <button
                type="button"
                disabled={stepIndex === 0}
                onClick={() => choose(STEPS[stepIndex - 1][0])}
              >
                Back
              </button>
              {step === 'finish' ? (
                <CompleteResolution api={api} />
              ) : (
                <button type="button" onClick={() => choose(STEPS[stepIndex + 1][0])}>
                  Continue to {STEPS[stepIndex + 1][1]}
                </button>
              )}
            </div>
          ) : approved ? (
            <div className="case-pane-bar end">
              <CompleteResolution api={api} />
            </div>
          ) : null}
        </section>
        <CasePreview api={api} />
      </div>
      {historyOpen ? (
        <Drawer title="History" onClose={() => setHistoryOpen(false)}>
          {item.history.length ? (
            <ul className="list-plain case-history">
              {[...item.history].reverse().map((event) => (
                <li key={event.id}>
                  <strong>{historyLabel(event.action)}</strong>
                  <p className="metadata">
                    {userName(event.actorId)}, {formatDay(event.at)}
                  </p>
                  {event.detail ? <p>{formatDatesIn(event.detail)}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No history yet</Empty>
          )}
        </Drawer>
      ) : null}
    </div>
  );
}

function Details({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const item = api.detail.case;
  const saved = {
    title: item.title,
    ownerId: item.ownerId,
    instructionDate: item.instructionDate || '',
    resolutionDate: item.resolutionDate || '',
    effectiveDate: item.effectiveDate || '',
  };
  type Field = keyof typeof saved;
  const [form, setForm] = useState(saved);
  // Fields the user has typed in keep what was typed. When the case changes elsewhere (another
  // tab, or a save's own reply), only untouched fields follow the latest values, so a letter
  // deleted while a save was in flight never comes back. A touched field is released once the
  // server holds what was typed.
  const touched = useRef(new Set<Field>());
  const edit = (key: Field, value: string) => {
    touched.current.add(key);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const [base, setBase] = useState(saved);
  const savedKey = JSON.stringify(saved);
  if (savedKey !== JSON.stringify(base)) {
    setBase(saved);
    setForm((current) => {
      const next = { ...current };
      for (const key of Object.keys(saved) as Field[]) {
        if (touched.current.has(key) && current[key] === saved[key]) touched.current.delete(key);
        if (!touched.current.has(key)) next[key] = saved[key];
      }
      return next;
    });
  }
  const dirty =
    form.title.trim() !== item.title ||
    form.ownerId !== item.ownerId ||
    form.instructionDate !== (item.instructionDate || '') ||
    form.resolutionDate !== (item.resolutionDate || '') ||
    form.effectiveDate !== (item.effectiveDate || '');
  const titleMissing = !form.title.trim();
  useCaseAutosave({
    api,
    form: 'details',
    pending: dirty,
    blocked: titleMissing ? 'Enter a title in Details first.' : '',
    deps: [form],
    save: () =>
      api.act('update_details', {
        title: form.title.trim(),
        ownerId: form.ownerId,
        instructionDate: form.instructionDate || null,
        resolutionDate: form.resolutionDate || null,
        effectiveDate: form.effectiveDate || null,
      }),
  });
  if (!data) return null;
  return (
    <section aria-label="Details">
      <form
        className="form-grid case-details"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={(event) => event.preventDefault()}
      >
        <fieldset className="plain-fieldset full form-grid" disabled={!api.canEdit}>
          <label className="full">
            Title
            <input
              required
              maxLength={300}
              value={form.title}
              onChange={(event) => edit('title', event.target.value)}
            />
            {titleMissing ? <span className="field-error">Enter a title</span> : null}
          </label>
          <label className="full">
            Owner
            <select value={form.ownerId} onChange={(event) => edit('ownerId', event.target.value)}>
              {data.users
                .filter(
                  (user) => user.companyIds.includes(item.companyId) || user.id === form.ownerId,
                )
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="full form-grid form-pair compact-pair">
            <label>
              Resolution date
              <input
                type="date"
                value={form.resolutionDate}
                onChange={(event) => edit('resolutionDate', event.target.value)}
              />
            </label>
            <label>
              Effective date
              <input
                type="date"
                value={form.effectiveDate}
                onChange={(event) => edit('effectiveDate', event.target.value)}
              />
            </label>
          </div>
          <label className="full">
            Instruction date
            <input
              type="date"
              value={form.instructionDate}
              onChange={(event) => edit('instructionDate', event.target.value)}
            />
          </label>
        </fieldset>
      </form>
      <dl className="facts case-facts">
        <div>
          <dt>Kind</dt>
          <dd>{kindLabel(item.kind)}</dd>
        </div>
      </dl>
    </section>
  );
}
