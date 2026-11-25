'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  AssemblyVersion,
  ClauseVersion,
  FieldDefinition,
  OutputType,
  RecordFieldDefinition,
  ResolvedDocument,
} from '@/domain/resolution/model';
import type { ConvertIssue } from '@/components/template-editor/convert';
import { plainText } from '@/components/template-editor/convert';
import { confirmAction } from '@/components/edit-guard';
import { Empty, formatDate, Icon } from '@/components/workspace';
import {
  ApiError,
  download,
  errorText,
  getJson,
  latest,
  newRequestId,
  plainIssue,
  postJson,
  type AssemblyWithVersions,
  type ClauseWithVersions,
  type Issue,
} from './api';
import { DocumentPreview } from './document-preview';
import { TabPanel, Tabs } from '@/components/tabs';

type Kind = 'clause' | 'assembly';
type Template<K extends Kind> = K extends 'clause' ? ClauseWithVersions : AssemblyWithVersions;
type Version<K extends Kind> = K extends 'clause' ? ClauseVersion : AssemblyVersion;
export type Change = { path: string; before: unknown; after: unknown };

/** A stored date as people read it, or the word "blank" when none was entered. */
const dayOrBlank = (value: string | null | undefined) => (value ? formatDate(value) : 'blank');

const AUTOSAVE_DELAY = 1000;
const PREVIEW_DELAY = 800;

const base = (kind: Kind) =>
  kind === 'clause' ? '/api/clause-templates' : '/api/resolution-assemblies';

export function useTemplateVersion<K extends Kind>(kind: K, id: string) {
  const router = useRouter();
  // Read reactively so same-route `?version=` links (the version history) switch versions.
  const versionParam = useSearchParams().get('version');
  const [versionId, setVersionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<{
    template: Template<K>;
    all: Template<K>[];
    version: Version<K>;
    issues: Issue[];
    changes: Change[];
    outputTypes: OutputType[];
    definitions: RecordFieldDefinition[];
    otherClauses: ClauseWithVersions[];
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** Increments when content is reloaded from the server, so editors remount. */
  const [generation, setGeneration] = useState(0);
  // Read straight after a save resolves, before React has re-rendered with the new version.
  const revision = useRef(0);

  useEffect(() => {
    setVersionId(versionParam);
    setReady(true);
  }, [versionParam]);

  // Only the newest load may apply its reply; an older one finishing late is ignored.
  const loadTicket = useRef(0);
  const load = useCallback(
    async (target: string | null) => {
      const ticket = ++loadTicket.current;
      const current = () => ticket === loadTicket.current;
      setLoading(true);
      setError('');
      try {
        const listUrl = base(kind) + '?includeHidden=true';
        const [list, types, definitions, clauses] = await Promise.all([
          getJson<Record<string, Template<K>[]>>(listUrl),
          getJson<{ outputTypes: OutputType[] }>('/api/output-types'),
          getJson<{ definitions: RecordFieldDefinition[] }>('/api/record-fields').catch(() => ({
            definitions: [] as RecordFieldDefinition[],
          })),
          kind === 'clause'
            ? null
            : getJson<{ clauses: ClauseWithVersions[] }>(
                '/api/clause-templates?includeHidden=true',
              ),
        ]);
        const all = (kind === 'clause' ? list.clauses : list.assemblies) as Template<K>[];
        const template = all.find((t) => t.id === id);
        if (!template) throw new ApiError('This template is unavailable.', 404);
        const versions = template.versions as Version<K>[];
        const chosen =
          versions.find((v) => v.id === target) || (latest(versions) as Version<K> | undefined);
        if (!chosen) throw new ApiError('This template has no versions.', 404);
        const detail = await getJson<{ version: Version<K>; issues: Issue[]; changes: Change[] }>(
          `${base(kind)}/${id}/versions/${chosen.id}`,
        );
        if (!current()) return;
        revision.current = detail.version.revision;
        setState({
          template,
          all,
          version: detail.version,
          issues: detail.issues ?? [],
          changes: detail.changes ?? [],
          outputTypes: [...types.outputTypes].sort((a, b) => a.order - b.order),
          definitions: definitions.definitions,
          otherClauses:
            kind === 'clause' ? (all as ClauseWithVersions[]) : (clauses?.clauses ?? []),
        });
        setGeneration((n) => n + 1);
      } catch (e) {
        if (current()) setError(errorText(e));
      } finally {
        if (current()) setLoading(false);
      }
    },
    [id, kind],
  );

  useEffect(() => {
    if (ready) void load(versionId);
  }, [ready, versionId, load]);

  const selectVersion = (next: string) => {
    router.replace(
      `/templates/${kind === 'clause' ? 'clauses' : 'assemblies'}/${id}?version=${next}`,
    );
    setVersionId(next);
  };

  async function saveDraft(content: Record<string, unknown>) {
    if (!state) throw new Error('Not loaded');
    const result = await postJson<{ version: Version<K>; issues: Issue[] }>(
      `${base(kind)}/${id}/versions/${state.version.id}`,
      {
        action: 'save_draft',
        expectedRevision: revision.current,
        requestId: newRequestId(),
        ...content,
      },
    );
    revision.current = result.version.revision;
    // A late reply must not replace another version the author has since opened.
    setState((current) =>
      current && current.version.id === result.version.id
        ? {
            ...current,
            version: result.version,
            issues: result.issues ?? [],
            template: {
              ...current.template,
              versions: (current.template.versions as Version<K>[]).map((v) =>
                v.id === result.version.id ? result.version : v,
              ),
            } as Template<K>,
          }
        : current,
    );
    return result;
  }

  async function updateTemplate(patch: Record<string, unknown>) {
    if (!state) return;
    const next = await postJson<Template<K>>(base(kind), {
      action: 'update',
      requestId: newRequestId(),
      id,
      expectedRevision: state.template.revision,
      ...patch,
    });
    setState((current) =>
      current ? { ...current, template: { ...current.template, ...next } } : current,
    );
  }

  return {
    state,
    error,
    loading,
    generation,
    reload: () => load(state?.version.id ?? versionId),
    selectVersion,
    saveDraft,
    updateTemplate,
    versionUrl: (versionId: string) => `${base(kind)}/${id}/versions/${versionId}`,
  };
}

/**
 * Saves a draft about a second after the last edit. Saves never overlap: an edit made during a
 * save starts another one afterwards. `dirty` stays true until the server holds the latest edit,
 * so the edit guards keep working. A rejected save waits for the next edit or Try again; a
 * conflict stops saving and keeps the local edits until the author reloads.
 */
export function useDraftAutosave({
  enabled,
  blocked,
  lastSaved,
  save,
}: {
  enabled: boolean;
  /** Content that cannot be converted safely must not overwrite the stored draft. */
  blocked: boolean;
  lastSaved: string;
  save: () => Promise<unknown>;
}) {
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState(lastSaved);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const edits = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const latestProps = useRef({ enabled, blocked, save });
  latestProps.current = { enabled, blocked, save };

  const flush = useCallback(async function flushDraft() {
    window.clearTimeout(timer.current);
    const { enabled: canSave, blocked: mustWait, save: send } = latestProps.current;
    if (!canSave || mustWait || inFlight.current || stopped.current) return;
    inFlight.current = true;
    const started = edits.current;
    try {
      await send();
      if (!mounted.current) return;
      setError('');
      setSavedAt(new Date().toISOString());
      if (edits.current === started) setDirty(false);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status === 409) {
        stopped.current = true;
        setConflict(true);
      }
      setError(errorText(e));
    } finally {
      inFlight.current = false;
    }
    if (edits.current !== started && !stopped.current)
      timer.current = window.setTimeout(() => void flushDraft(), AUTOSAVE_DELAY);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const edited = useCallback(() => {
    edits.current += 1;
    setDirty(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY);
  }, [flush]);

  return {
    dirty,
    savedAt,
    error,
    conflict,
    /** Saving is held back for a reason the author has to clear. */
    stuck: dirty && (Boolean(error) || blocked),
    edited,
    retry: flush,
  };
}

function savedLabel(savedAt: string) {
  return `Saved ${formatDate(savedAt)}`;
}

/** The header's save state; read-only versions show none. */
export function AutosaveStatus({
  autosave,
  readOnly,
}: {
  autosave: ReturnType<typeof useDraftAutosave>;
  readOnly: boolean;
}) {
  if (readOnly) return null;
  return (
    <span
      className={'tb-save-state' + (autosave.stuck ? ' failed' : '')}
      role="status"
      aria-live="polite"
    >
      {autosave.stuck ? 'Not saved' : autosave.dirty ? 'Saving…' : savedLabel(autosave.savedAt)}
    </span>
  );
}

/** One line under the header when a save failed; local edits are always kept. */
export function AutosaveNotice({
  autosave,
  onReload,
}: {
  autosave: ReturnType<typeof useDraftAutosave>;
  onReload: () => void;
}) {
  if (!autosave.error) return null;
  return (
    <p className="tb-notice" role="alert">
      <Icon kind="warning" />
      <span>
        {autosave.error}
        {autosave.conflict ? ' Your edits are still here.' : ''}
      </span>
      {autosave.conflict ? (
        <button
          type="button"
          className="tb-link"
          onClick={async () => {
            if (
              await confirmAction({
                message: 'Reload the latest version and discard your unsaved edits?',
                confirmLabel: 'Reload latest',
              })
            )
              onReload();
          }}
        >
          Reload latest
        </button>
      ) : (
        <button type="button" className="tb-link" onClick={() => void autosave.retry()}>
          Try again
        </button>
      )}
    </p>
  );
}

/** The header's plain-text status, such as "Version 2, in review". */
export function versionStatusText(version: { version: number; status: string }) {
  return `Version ${version.version}, ${version.status.toLowerCase()}`;
}

/** Why a version cannot be edited; one quiet line above the wording. */
export function ReadOnlyNote({
  version,
  canManage,
}: {
  version: { version: number; status: string };
  canManage: boolean;
}) {
  const name = `Version ${version.version}`;
  const fixed = version.status === 'Published' || version.status === 'Superseded';
  const text = fixed
    ? `${name} is ${version.status.toLowerCase()}.${canManage ? ' Create a new version to change it.' : ''}`
    : version.status === 'In review'
      ? `${name} is in review. Editing is paused.`
      : `${name} is a draft. You do not have permission to edit it.`;
  return (
    <p className="tb-read-only">
      <Icon kind="warning" />
      {text}
    </p>
  );
}

/** Underlined tabs for one pane of an editor, with roving keyboard focus. */
export function PaneTabs<T extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
}: {
  label: string;
  idPrefix: string;
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <Tabs
      className="tb-tabs"
      ariaLabel={label}
      idPrefix={idPrefix}
      tabs={tabs.map((tab) => ({ id: tab.key, label: tab.label }))}
      selected={value}
      onChange={onChange}
    />
  );
}

/** A panel stays mounted while hidden, so unsaved settings and the preview keep their state. */
export function PanePanel({
  idPrefix,
  tabKey,
  active,
  children,
}: {
  idPrefix: string;
  tabKey: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <TabPanel className="tb-side-panel" idPrefix={idPrefix} tabKey={tabKey} hidden={!active}>
      {children}
    </TabPanel>
  );
}

/** Takes the author from a validation issue to the version field it names. */
export function goToVersionField(location: string) {
  const selector = /effective/i.test(location)
    ? '#version-source input'
    : /source/i.test(location)
      ? '#version-source textarea'
      : '';
  const field = selector ? document.querySelector<HTMLElement>(selector) : null;
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
  return Boolean(field);
}

/** Validation issues; each navigates to its location when possible. */
export function IssueList({
  issues,
  converter,
  onNavigate,
  title = 'Validation',
}: {
  issues: Issue[];
  converter: { wording: string; name: string; issue: ConvertIssue }[];
  onNavigate: (target: { wording?: string; block?: number; location: string }) => void;
  title?: string;
}) {
  if (!issues.length && !converter.length) return null;
  const errors = issues.filter((i) => i.severity !== 'warning');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const blocking = errors.length + converter.length;
  return (
    <details
      className={'tb-issues' + (blocking ? ' blocking' : '')}
      role="region"
      aria-label={title}
      open={converter.length > 0}
    >
      <summary>
        <Icon kind="warning" />
        {blocking ? `${blocking} to fix` : 'No blocking issues'}
        {warnings.length ? `, ${warnings.length} to check` : ''}
      </summary>
      <ul>
        {converter.map((item, i) => (
          <li key={'c' + i}>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onNavigate({
                  wording: item.wording,
                  block: item.issue.blockIndex,
                  location: item.name,
                })
              }
            >
              {item.issue.message}
            </button>
            <span className="metadata">
              , {item.name}, block {item.issue.blockIndex + 1}, not saved until removed
            </span>
          </li>
        ))}
        {[...errors, ...warnings].map((issue, i) => {
          const block = /block (\d+)/.exec(issue.location);
          return (
            <li key={i} className={issue.severity === 'warning' ? 'muted' : undefined}>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  onNavigate({
                    block: block ? Number(block[1]) - 1 : undefined,
                    location: issue.location,
                  })
                }
              >
                {issue.severity === 'warning' ? 'Check: ' : ''}
                {issue.message}
              </button>
              {issue.location ? <span className="metadata">, {issue.location}</span> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** The fictional answers behind a sample preview, matched to the fields they fill. */
function sampleAnswerRows(fields: FieldDefinition[], values: Record<string, string>) {
  const entries = Object.entries(values);
  return fields.flatMap((field) => {
    const pattern = new RegExp(`(^|[.:])${field.id}($|[.[])`);
    const found = entries.filter(([key]) => pattern.test(key)).map(([, value]) => value);
    return found.length
      ? [{ id: field.id, label: field.label, value: [...new Set(found)].join(', ') }]
      : [];
  });
}

/**
 * Sample preview: refreshes by itself shortly after the draft changes, because the preview API
 * accepts unsaved content. The last good page stays visible while a mid-edit draft is rejected.
 */
export function SamplePreview({
  kind,
  versionId,
  outputType,
  draft,
  fields,
  dirty,
  stuck,
  active,
}: {
  kind: Kind;
  versionId: string;
  /** Follows the wording tab on a clause; a layout has one document type. */
  outputType: string;
  draft: Record<string, unknown> | null;
  fields: FieldDefinition[];
  dirty: boolean;
  /** The draft is not being saved, so a download would miss the latest edits. */
  stuck: boolean;
  /** Off while another side tab is open; a stale preview catches up when reopened. */
  active: boolean;
}) {
  const signature = `${outputType}|${JSON.stringify(draft)}`;
  const [result, setResult] = useState<{
    resolved: ResolvedDocument;
    issues: Issue[];
    values?: Record<string, string>;
  } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const requested = useRef<{ signature: string; outputType: string } | null>(null);
  const ticket = useRef(0);
  /** Bumped by Try again, so a failed preview can be asked for again without editing. */
  const [attempt, setAttempt] = useState(0);
  /** Try again is offered only for a failed preview; a failed download is retried with its own link. */
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    if (!active || requested.current?.signature === signature) return;
    // A first load or a new document type should not wait for the typing delay.
    const immediate = requested.current?.outputType !== outputType;
    const timer = window.setTimeout(
      async () => {
        const id = ++ticket.current;
        requested.current = { signature, outputType };
        setPending(true);
        try {
          const next = await postJson<NonNullable<typeof result>>('/api/templates/preview', {
            kind,
            versionId,
            ...(outputType ? { outputTypeId: outputType } : {}),
            ...(draft ? { draft } : {}),
          });
          if (id !== ticket.current) return;
          setResult(next);
          setError('');
          setPreviewFailed(false);
        } catch (e) {
          if (id === ticket.current) {
            setError(errorText(e));
            setPreviewFailed(true);
            // Forget the failed request so reopening the tab or Try again asks again at once.
            requested.current = null;
          }
        } finally {
          if (id === ticket.current) setPending(false);
        }
      },
      immediate ? 0 : PREVIEW_DELAY,
    );
    return () => window.clearTimeout(timer);
    // The signature covers the draft and the document type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, active, attempt]);
  const answers = sampleAnswerRows(fields, result?.values ?? {});
  return (
    <section className="tb-preview" aria-label="Sample preview" aria-busy={pending}>
      {answers.length ? (
        <details className="tb-disclosure">
          <summary>Sample answers</summary>
          <dl className="record-meta">
            {answers.map((answer) => (
              <div key={answer.id}>
                <dt>{answer.label}</dt>
                <dd>{answer.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {result?.issues.length ? (
        <details className="tb-disclosure">
          <summary>To resolve before generating</summary>
          <ul className="compact-list">
            {result.issues.map((issue, index) => (
              <li key={index}>{plainIssue(issue, fields)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? (
        <p className="tb-notice" role="alert">
          <Icon kind="warning" />
          <span>{error}</span>
          {previewFailed ? (
            <button
              type="button"
              className="tb-link"
              disabled={pending}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {result ? <DocumentPreview document={result.resolved} /> : null}
      <p className="tb-preview-actions">
        <button
          type="button"
          className="tb-link"
          disabled={downloading || (dirty && !stuck)}
          onClick={async () => {
            setDownloading(true);
            setError('');
            setPreviewFailed(false);
            try {
              const params = new URLSearchParams({ kind, versionId, format: 'docx' });
              if (outputType) params.set('outputTypeId', outputType);
              await download('/api/templates/preview?' + params, undefined, 'sample.docx');
            } catch (e) {
              setError(errorText(e));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? 'Preparing…' : 'Download sample .docx'}
        </button>
        {stuck ? <span className="metadata">Download uses the last saved draft.</span> : null}
      </p>
    </section>
  );
}

/** Shown instead of the preview until a clause has wording to preview. */
export function NoPreview() {
  return <Empty>Add wording to see the preview</Empty>;
}

/** Plain-language summary of what changed against the previous published version. */
export function DiffSummary({
  previous,
  current,
  wordings,
  serverChanges,
}: {
  previous: {
    version: number;
    fields: FieldDefinition[];
    source: string;
    effectiveDate: string | null;
  } | null;
  current: { fields: FieldDefinition[]; source: string; effectiveDate: string | null };
  wordings: { name: string; before: unknown[] | undefined; after: unknown[] | undefined }[];
  serverChanges: Change[];
}) {
  if (!previous) return <p>First version.</p>;
  const lines: string[] = [];
  for (const w of wordings) {
    const before = w.before ? plainText(w.before as never) : null;
    const after = w.after ? plainText(w.after as never) : null;
    if (before === null && after !== null) lines.push(`Added wording: ${w.name}`);
    else if (before !== null && after === null) lines.push(`Removed wording: ${w.name}`);
    else if (before !== after) lines.push(`Changed wording: ${w.name}`);
    else if (JSON.stringify(w.before) !== JSON.stringify(w.after))
      lines.push(`Changed formatting: ${w.name}`);
  }
  const ids = new Set([...previous.fields, ...current.fields].map((f) => f.id));
  for (const id of ids) {
    const a = previous.fields.find((f) => f.id === id);
    const b = current.fields.find((f) => f.id === id);
    if (!a && b) lines.push(`Added field: ${b.label}`);
    else if (a && !b) lines.push(`Removed field: ${a.label}`);
    else if (a && b && JSON.stringify(a) !== JSON.stringify(b))
      lines.push(
        a.label !== b.label
          ? `Renamed field: ${a.label} → ${b.label}`
          : `Changed field: ${b.label}`,
      );
  }
  if (previous.source !== current.source) lines.push('Changed source or basis');
  if (previous.effectiveDate !== current.effectiveDate)
    lines.push(
      `Effective date: ${dayOrBlank(current.effectiveDate)} (was ${dayOrBlank(previous.effectiveDate)})`,
    );
  return (
    <>
      <p>Compared with published v{previous.version}:</p>
      {lines.length ? (
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>No content changes.</p>
      )}
      {serverChanges.length ? (
        <details className="advanced-filters">
          <summary>{serverChanges.length} detailed changes</summary>
          <ul className="compact-list">
            {serverChanges.slice(0, 60).map((change, i) => (
              <li key={i}>
                <code>{change.path}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
