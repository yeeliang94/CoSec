'use client';
import { useMemo, useRef, useState } from 'react';
import { buildForm, signersOf, type CaseInput } from '@/domain/resolution/form';
import type { AnswerValue, Answers, SignerSelection } from '@/domain/resolution/model';
import {
  ApiError,
  getJson,
  issueFields,
  newRequestId,
  plainIssue,
  postJson,
  type ClausesResponse,
  type FormField,
  type FormModel,
  type Issue,
  type IssueField,
} from './api';
import type { CaseApi } from './case-workspace';
import { useCaseAutosave } from './use-case-autosave';
import { LoadState, useLoad } from './use-load';
import { currentDate, Empty } from '@/components/workspace';
import { PerRowTable, Question, SignerList } from './case-question';

type Draft = { shared: Answers; clauses: Record<string, Answers>; signers: SignerSelection };

type QuestionStep = 'answers' | 'signers' | 'all';

export function CaseQuestions({ api, step }: { api: CaseApi; step: QuestionStep }) {
  const id = api.detail.case.id;
  // On the single Prepare page the wording sits above; reload when its saved selection changes.
  const selection = api.detail.case.selection;
  const load = useLoad(
    () => getJson<ClausesResponse>(`/api/resolution-cases/${id}/clauses`),
    // The resolution date decides who is a director or member, so a new date reloads the lists.
    [
      id,
      selection?.revision ?? 0,
      selection?.assemblyVersionId ?? '',
      api.detail.case.resolutionDate ?? '',
    ],
  );
  if (!load.data)
    return (
      <LoadState
        loading={load.loading}
        error={load.error}
        reload={() => void load.reload()}
        label="questions"
      />
    );
  if (!load.data.selection || !load.data.form || !load.data.formInput)
    return (
      <Empty>
        Choose a layout first
        <div>
          <button type="button" onClick={() => api.ui.goToWording()}>
            Go to Wording
          </button>
        </div>
      </Empty>
    );
  return (
    // Not keyed on the selection revision: remounting would drop keyboard focus to <body>.
    // QuestionForm re-initialises its draft itself when the revision changes.
    <QuestionForm
      api={api}
      step={step}
      initialForm={load.data.form}
      formInput={load.data.formInput}
      selectionRevision={load.data.selection.revision}
      reload={load.reload}
    />
  );
}

/** The resolution date question takes the date from Details while it is unanswered. */
const isResolutionDate = (field: FormField) =>
  field.valueType === 'date' &&
  (field.id === 'resolution_date' || field.label.trim().toLowerCase() === 'resolution date');

/** Moves answers still holding the previous Details date to the new one. */
export function refreshCopiedDate(
  draft: Draft,
  form: FormModel,
  previous: string | null,
  next: string | null,
) {
  let prefilled = false;
  let changed = false;
  const refresh = (fields: FormField[], answers: Answers) => {
    const updated = { ...answers };
    for (const field of fields) {
      if (field.readOnly || !isResolutionDate(field)) continue;
      // An earlier copy is saved like any answer, so a saved value equal to the old date still follows.
      const saved = field.value;
      if (saved !== null && saved !== undefined && saved !== '' && saved !== previous) continue;
      const current = answers[field.id];
      if (current !== null && current !== undefined && current !== '' && current !== previous)
        continue;
      if ((current ?? null) !== (next ?? null)) changed = true;
      updated[field.id] = next;
      if (next) prefilled = true;
    }
    return updated;
  };
  return {
    draft: {
      ...draft,
      shared: refresh(form.shared, draft.shared),
      clauses: Object.fromEntries(
        form.clauses.map((clause) => [
          clause.key,
          refresh(clause.fields, draft.clauses[clause.key] ?? {}),
        ]),
      ),
    } as Draft,
    prefilled,
    changed,
  };
}

function initial(form: FormModel, signers: SignerSelection, resolutionDate: string | null) {
  let prefilled = false;
  const collect = (fields: FormField[]) =>
    Object.fromEntries(
      fields
        .filter((f) => !f.readOnly)
        .map((f) => {
          const value = f.value ?? null;
          if ((value === null || value === '') && resolutionDate && isResolutionDate(f)) {
            prefilled = true;
            return [f.id, resolutionDate];
          }
          return [f.id, value];
        }),
    ) as Answers;
  const draft: Draft = {
    shared: collect(form.shared),
    clauses: Object.fromEntries(form.clauses.map((c) => [c.key, collect(c.fields)])),
    signers: {
      directors: [...(signers.directors ?? [])],
      members: [...(signers.members ?? [])],
      certifiers: [...(signers.certifiers ?? [])],
      subject: [...(signers.subject ?? [])],
    },
  };
  return { draft, prefilled };
}

/** `fresh` with the unsaved answers from `draft` for the fields `fresh` still has. */
export function carryOver(fresh: Draft, draft: Draft): Draft {
  const keep = (next: Answers, old: Answers | undefined) =>
    Object.fromEntries(
      Object.entries(next).map(([id, value]) => [id, old && id in old ? old[id] : value]),
    ) as Answers;
  return {
    shared: keep(fresh.shared, draft.shared),
    clauses: Object.fromEntries(
      Object.entries(fresh.clauses).map(([key, answers]) => [
        key,
        keep(answers, draft.clauses[key]),
      ]),
    ),
    signers: draft.signers,
  };
}

function QuestionForm({
  api,
  step,
  initialForm,
  formInput,
  selectionRevision,
  reload,
}: {
  api: CaseApi;
  step: QuestionStep;
  initialForm: FormModel;
  formInput: CaseInput;
  selectionRevision: number;
  reload: () => Promise<void>;
}) {
  const item = api.detail.case;
  // A read-only case keeps its stored answers; only an editable one copies the date from step 1.
  const copiedDate = api.canEdit ? item.resolutionDate : null;
  const start = () => initial(initialForm, item.signers, copiedDate);
  const [draft, setDraft] = useState<Draft>(() => start().draft);
  const [dirty, setDirty] = useState(false);
  // A date copied on opening goes out with the next save; it never starts one on its own,
  // so opening a resolution writes nothing and nobody has edited anything to lose by leaving.
  // A copy caused by a Details edit is different: it is unsaved work and saves like an answer.
  const [saveIssues, setSaveIssues] = useState<Issue[]>([]);
  // Counts edits so a save only clears `dirty` when nothing changed while it was in flight.
  const edits = useRef(0);
  const markDirty = () => {
    edits.current += 1;
    setDirty(true);
    setSaveIssues([]);
  };
  // Rebuild the questions while retaining unsaved answers to fields that are still asked.
  const [seenRevision, setSeenRevision] = useState(selectionRevision);
  if (seenRevision !== selectionRevision) {
    setSeenRevision(selectionRevision);
    const next = start();
    setDraft(dirty ? carryOver(next.draft, draft) : next.draft);
    setSaveIssues([]);
  }
  // Step 1's date changed: untouched copies follow it, and answers someone typed stay.
  const [seenDate, setSeenDate] = useState(copiedDate);
  if (seenDate !== copiedDate) {
    setSeenDate(copiedDate);
    const next = refreshCopiedDate(draft, initialForm, seenDate, copiedDate);
    if (next.changed) {
      setDraft(next.draft);
      markDirty();
    }
  }
  const formRef = useRef<HTMLFormElement>(null);
  const editable = api.canEdit;
  const setAnswer = (unit: string, fieldId: string, value: AnswerValue | Answers) => {
    markDirty();
    setDraft((current) =>
      unit === '@shared'
        ? { ...current, shared: { ...current.shared, [fieldId]: value as AnswerValue } }
        : {
            ...current,
            clauses: {
              ...current.clauses,
              [unit]: { ...current.clauses[unit], [fieldId]: value as AnswerValue },
            },
          },
    );
  };
  const form = useMemo(
    () => buildForm({ ...formInput, answers: draft, signers: draft.signers }),
    [formInput, draft],
  );
  const allFields = issueFields(form);
  // Automatic saves only show what the server refused; missing answers are listed in the preview.
  const issuesFor = (field: FormField, unit: string) =>
    saveIssues.filter(
      (issue) =>
        issue.fieldId === field.id &&
        (!issue.unit || issue.unit === unit || (unit === '@shared' && issue.unit === 'case')),
    );

  async function save() {
    setSaveIssues([]);
    const started = edits.current;
    await api.enqueue(async () => {
      await postJson(`/api/resolution-cases/${item.id}/clauses`, {
        action: 'save_answers',
        expectedRevision: api.revision(),
        requestId: newRequestId(),
        selectionRevision: api.selectionRevision(),
        shared: draft.shared,
        clauses: draft.clauses,
        signers: draft.signers,
      }).catch((e: unknown) => {
        if (e instanceof ApiError) setSaveIssues(e.issues);
        throw e;
      });
      await api.refresh();
    });
    if (edits.current === started) {
      setDirty(false);
    }
    await reload();
  }
  useCaseAutosave({ api, form: 'answers', pending: dirty, deps: [draft], save });

  const held = (fields: FormField[]) => fields.filter((f) => f.active !== false);
  const fromRecord = (field: FormField, fields: FormField[]) =>
    Boolean(field.readOnly) &&
    !field.repeatScope &&
    !fields.some((other) => other.repeatScope === field.id);
  // Values worked out from another answer show in the document, not as a second question.
  const fromAnswer = (field: FormField) =>
    field.source?.kind === 'binding' && field.source.path.startsWith('selection.');
  const recordFields = [
    ...held(form.shared)
      .filter((f) => fromRecord(f, form.shared) && !fromAnswer(f))
      .map((field) => ({ field, unit: '@shared' })),
    ...form.clauses.flatMap((clause) =>
      held(clause.fields)
        .filter((f) => fromRecord(f, clause.fields) && !fromAnswer(f))
        .map((field) => ({ field, unit: clause.key })),
    ),
  ];
  const sharedAsked = form.shared.filter((f) => !fromRecord(f, form.shared));
  const clausesAsked = form.clauses
    .map((clause, index) => ({
      clause,
      index,
      fields: clause.fields.filter((f) => !fromRecord(f, clause.fields)),
    }))
    .filter(({ fields }) => held(fields).length);
  const nothingAsked = !held(sharedAsked).length && !clausesAsked.length;
  const missingRecordValue = recordFields.some(
    ({ field }) => field.value === null || field.value === undefined || field.value === '',
  );

  return (
    <form
      ref={formRef}
      className="question-form"
      noValidate
      data-dirty={dirty ? 'true' : 'false'}
      aria-label="Answers"
      onSubmit={(event) => event.preventDefault()}
      onFocusCapture={(event) => {
        const ids = (event.target as HTMLElement)
          .closest<HTMLElement>('[data-field-ids]')
          ?.dataset.fieldIds?.split(' ');
        if (ids)
          api.ui.setActiveFieldIds([
            ...ids,
            ...allFields
              .filter((f) => ids.includes(f.source?.path?.split('.')[1] ?? ''))
              .map((f) => f.id),
          ]);
      }}
      onBlurCapture={(event) => {
        if (!formRef.current?.contains(event.relatedTarget as Node | null))
          api.ui.setActiveFieldIds([]);
      }}
    >
      <fieldset className="plain-fieldset" disabled={!editable}>
        <div hidden={step === 'signers'}>
          {nothingAsked ? <Empty>Nothing to answer</Empty> : null}
          {held(sharedAsked).length ? (
            <section
              className="question-section"
              data-unit="@shared"
              aria-labelledby="shared-questions"
            >
              <h3 id="shared-questions">For the whole resolution</h3>
              <FieldGroup
                unit="@shared"
                fields={sharedAsked}
                values={draft.shared}
                onChange={setAnswer}
                issuesFor={(field) => issuesFor(field, '@shared')}
                fieldsForIssues={allFields}
              />
            </section>
          ) : null}
          {clausesAsked.map(({ clause, index, fields }) => (
            <section
              className="question-section"
              key={clause.key}
              data-unit={clause.key}
              aria-labelledby={`clause-${clause.key}`}
            >
              <h3 id={`clause-${clause.key}`}>
                {index + 1}. {clause.clauseName}
              </h3>
              <FieldGroup
                unit={clause.key}
                fields={fields}
                values={draft.clauses[clause.key] || {}}
                onChange={setAnswer}
                issuesFor={(field) => issuesFor(field, clause.key)}
                fieldsForIssues={allFields}
              />
            </section>
          ))}
          {recordFields.length ? (
            <details className="disclosure from-record" open={missingRecordValue || undefined}>
              <summary>From the company record</summary>
              <div className="question-grid">
                {recordFields.map(({ field, unit }) => (
                  <div
                    key={unit + field.id}
                    className="question"
                    data-unit={unit}
                    data-field-ids={field.id}
                  >
                    <Question
                      field={field}
                      value={field.value as AnswerValue}
                      onChange={() => {}}
                      issues={[]}
                    />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
        {form.signers.length ? (
          <section
            className="question-section"
            hidden={step === 'answers'}
            data-signers
            aria-label="Signers"
          >
            {step === 'all' ? <h3>Signers</h3> : null}
            {form.signers.map((role) => (
              <SignerList
                key={role.role}
                role={role.role}
                label={role.label}
                pool={role.pool}
                value={signersOf(draft.signers, role.role)}
                companyId={item.companyId}
                asAt={item.resolutionDate ?? currentDate()}
                onChange={(ids) => {
                  markDirty();
                  setDraft((current) => ({
                    ...current,
                    signers: { ...current.signers, [role.role]: ids },
                  }));
                }}
              />
            ))}
          </section>
        ) : step === 'signers' ? (
          <Empty>This layout has no signers</Empty>
        ) : null}
      </fieldset>
    </form>
  );
}

/** Under its own field the label is already visible: "Choose a person". */
function besideField(text: string, label: string) {
  const rest = text.startsWith(label + ': ') ? text.slice(label.length + 2) : text;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function FieldGroup({
  unit,
  fields,
  values,
  onChange,
  issuesFor,
  fieldsForIssues,
}: {
  unit: string;
  fields: FormField[];
  values: Answers;
  onChange: (unit: string, fieldId: string, value: AnswerValue | Answers) => void;
  issuesFor: (field: FormField) => Issue[];
  fieldsForIssues: IssueField[];
}) {
  const visible = fields.filter((f) => f.active !== false);
  const perRow = visible.filter((f) => f.repeatScope);
  return (
    <div className="question-grid">
      {visible
        .filter((f) => !f.repeatScope)
        .map((field) => {
          const rows = perRow.filter((f) => f.repeatScope === field.id);
          return (
            <div
              key={field.id}
              className={
                field.valueType === 'multiline' ||
                field.valueType === 'recordList' ||
                field.valueType === 'multiChoice' ||
                rows.length
                  ? 'question full'
                  : 'question'
              }
              data-field-ids={[field.id, ...rows.map((r) => r.id)].join(' ')}
            >
              <Question
                field={field}
                value={
                  field.readOnly ? (field.value as AnswerValue) : (values[field.id] as AnswerValue)
                }
                onChange={(value) => onChange(unit, field.id, value)}
                issues={issuesFor(field).map((issue) => ({
                  ...issue,
                  message: besideField(plainIssue(issue, fieldsForIssues), field.label),
                }))}
              />
              {rows.length ? (
                <PerRowTable
                  list={field}
                  selected={
                    (Array.isArray(values[field.id])
                      ? (values[field.id] as string[])
                      : Array.isArray(field.value)
                        ? (field.value as string[])
                        : []) as string[]
                  }
                  fields={rows}
                  values={values}
                  onChange={(fieldId, value) => onChange(unit, fieldId, value)}
                />
              ) : null}
            </div>
          );
        })}
      {perRow
        .filter((f) => !visible.some((v) => v.id === f.repeatScope))
        .map((field) => (
          <p key={field.id} className="metadata">
            {field.label} is asked for each selected person once the list is answered.
          </p>
        ))}
    </div>
  );
}
