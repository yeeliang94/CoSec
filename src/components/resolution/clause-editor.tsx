'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CLAUSE_CATEGORIES,
  type BlockNode,
  type ClauseCategory,
  type ClauseVersion,
  type FieldDefinition,
  type UsageContext,
} from '@/domain/resolution/model';
import { Icon, useWorkspace } from '@/components/workspace';
import {
  TemplateEditor,
  type SelectionContext,
  type TemplateEditorHandle,
} from '@/components/template-editor/editor';
import { toTiptap, type ConvertIssue } from '@/components/template-editor/convert';
import { FieldInspector } from '@/components/template-editor/field-inspector';
import { ApiError, errorText, latest, USAGE_CONTEXTS, type ClauseWithVersions } from './api';
import { VersionHistory, VersionLifecycle } from './lifecycle';
import {
  AutosaveNotice,
  AutosaveStatus,
  DiffSummary,
  IssueList,
  NoPreview,
  PanePanel,
  PaneTabs,
  ReadOnlyNote,
  SamplePreview,
  goToVersionField,
  useDraftAutosave,
  useTemplateVersion,
  versionStatusText,
} from './template-page';
import { LoadState } from './use-load';
import { ActionFeedback, useAction } from './use-action';
import { confirmAction } from '@/components/edit-guard';

type Draft = {
  wordings: Record<string, BlockNode[]>;
  fields: FieldDefinition[];
  source: string;
  effectiveDate: string | null;
};
type SideTab = 'preview' | 'settings' | 'versions';
const SIDE_TABS: { key: SideTab; label: string }[] = [
  { key: 'preview', label: 'Preview' },
  { key: 'settings', label: 'Settings' },
  { key: 'versions', label: 'Versions' },
];

export function ClauseEditor({ id }: { id: string }) {
  const page = useTemplateVersion('clause', id);
  if (!page.state)
    return (
      <div className="tb-loading">
        <Link href="/templates" className="back-link">
          <Icon kind="back" />
          Templates
        </Link>
        <LoadState
          loading={page.loading}
          error={page.error}
          reload={() => void page.reload()}
          label="wording"
        />
      </div>
    );
  return <ClauseWorkbench key={`${page.state.version.id}:${page.generation}`} page={page} />;
}

function ClauseWorkbench({ page }: { page: ReturnType<typeof useTemplateVersion<'clause'>> }) {
  const { data } = useWorkspace();
  const state = page.state!;
  const { template, version, outputTypes } = state;
  const caps = data?.actor.capabilities ?? [];
  const canManage = caps.includes('manage_templates');
  const editable = canManage && (version.status === 'Draft' || version.status === 'Returned');
  const [draft, setDraft] = useState<Draft>(() => ({
    wordings: structuredClone(version.wordings),
    fields: structuredClone(version.fields),
    source: version.source,
    effectiveDate: version.effectiveDate,
  }));
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const typeList = useMemo(() => {
    const ids = new Set([
      ...outputTypes.filter((t) => t.active).map((t) => t.id),
      ...Object.keys(draft.wordings),
    ]);
    return outputTypes
      .filter((t) => ids.has(t.id))
      .concat(
        [...ids]
          .filter((id) => !outputTypes.some((t) => t.id === id))
          .map((id) => ({ id, name: id, body: 'directors' as const, active: false, order: 999 })),
      );
  }, [outputTypes, draft.wordings]);
  const [tab, setTab] = useState(
    () => typeList.find((t) => draft.wordings[t.id]?.length)?.id || typeList[0]?.id || '',
  );
  const [remount, setRemount] = useState(0);
  const [convertIssues, setConvertIssues] = useState<Record<string, ConvertIssue[]>>(() =>
    Object.fromEntries(
      Object.entries(version.wordings).map(([key, blocks]) => [key, toTiptap(blocks).issues]),
    ),
  );
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const editorRef = useRef<TemplateEditorHandle>(null);
  const newQuestionRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const [side, setSide] = useState<SideTab>('preview');
  const [copyFrom, setCopyFrom] = useState('');

  useEffect(() => {
    if (pendingFocus === null) return;
    const timer = window.setTimeout(() => {
      editorRef.current?.focusBlock(pendingFocus);
      setPendingFocus(null);
    }, 50);
    return () => window.clearTimeout(timer);
  }, [pendingFocus, tab, remount]);

  const typeName = (key: string) => typeList.find((t) => t.id === key)?.name || key;
  const wordingRefs = Object.entries(draft.wordings).map(([key, blocks]) => ({
    key,
    name: typeName(key),
    blocks,
  }));
  const converter = Object.entries(convertIssues).flatMap(([wording, issues]) =>
    issues.map((issue) => ({ wording, name: typeName(wording), issue })),
  );
  const filledWordings = (wordings: Draft['wordings']) =>
    Object.fromEntries(Object.entries(wordings).filter(([, blocks]) => blocks.length));
  const blocked = converter.length > 0;
  const autosave = useDraftAutosave({
    enabled: editable,
    blocked,
    lastSaved: version.updatedAt,
    save: () => {
      const current = draftNow.current;
      return page.saveDraft({
        wordings: filledWordings(current.wordings),
        fields: current.fields,
        source: current.source,
        effectiveDate: current.effectiveDate || null,
      });
    },
  });
  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    autosave.edited();
  };
  const reusable = useMemo(() => {
    const seen = new Set<string>();
    return (state.otherClauses as ClauseWithVersions[])
      .filter((c) => c.id !== template.id && !c.archived)
      .flatMap((c) => {
        const v = latest(c.versions);
        return (v?.fields ?? [])
          .filter((f) => f.scope === 'case' && !seen.has(f.id) && seen.add(f.id))
          .map((f) => ({ ...f, from: c.name }));
      });
  }, [state.otherClauses, template.id]);

  function navigate(target: { wording?: string; block?: number; location: string }) {
    let wording = target.wording;
    if (!wording) {
      const named = /wording "([^"]+)"/.exec(target.location)?.[1];
      wording = typeList.find((t) => t.name === named || t.id === named)?.id;
    }
    if (wording && wording !== tab) setTab(wording);
    if (target.block !== undefined) setPendingFocus(target.block);
    else if (/effective|source/i.test(target.location)) {
      // The field lives on the Settings tab, which has to be showing before it can take focus.
      setSide('settings');
      window.setTimeout(() => goToVersionField(target.location), 30);
    } else if (/field/.test(target.location)) {
      const fields = newQuestionRef.current?.closest('details');
      fields?.setAttribute('open', '');
      fields?.scrollIntoView({ block: 'center' });
    }
  }

  const previous = useMemo(() => {
    const published = template.versions
      .filter((v) => v.status === 'Published' || v.status === 'Superseded')
      .filter((v) => v.id !== version.id && v.version < version.version)
      .sort((a, b) => b.version - a.version)[0];
    return published ?? null;
  }, [template.versions, version]);

  const dirty = autosave.dirty;
  const availability = template.archived
    ? ', archived'
    : template.hidden
      ? ', hidden from new resolutions'
      : '';
  const hasWording = Object.values(draft.wordings).some((blocks) => blocks.length);
  return (
    <div className="tb" data-dirty={dirty ? 'true' : 'false'}>
      <VersionLifecycle
        heading={
          <>
            <Link href="/templates" className="back-link">
              <Icon kind="back" />
              Templates
            </Link>
            <h1>{template.name}</h1>
          </>
        }
        saveControl={
          <>
            <span className="lifecycle-state">
              {versionStatusText(version)}
              {availability}
            </span>
            <AutosaveStatus autosave={autosave} readOnly={!editable} />
          </>
        }
        version={version}
        url={page.versionUrl(version.id)}
        dirty={dirty}
        diff={
          <DiffSummary
            previous={previous}
            current={draft}
            serverChanges={state.changes}
            wordings={typeList.map((t) => ({
              name: t.name,
              before: previous?.wordings[t.id]?.length ? previous.wordings[t.id] : undefined,
              after: draft.wordings[t.id]?.length ? draft.wordings[t.id] : undefined,
            }))}
          />
        }
        onChanged={page.reload}
        onNewVersion={(next) => {
          page.selectVersion(next);
        }}
      />
      <AutosaveNotice autosave={autosave} onReload={() => void page.reload()} />
      <IssueList issues={state.issues} converter={converter} onNavigate={navigate} />
      <div className="tb-panes">
        <section className="tb-fields" aria-label="Fields">
          <FieldInspector
            fields={draft.fields}
            onFieldsChange={(fields) => change({ fields })}
            wordings={wordingRefs}
            selection={selection}
            editor={editorRef}
            readOnly={!editable}
            defaultScope="clause"
            reusable={reusable}
            customDefinitions={state.definitions}
            newQuestionRef={newQuestionRef}
            settingsRef={settingsRef}
          />
        </section>
        <section className="tb-centre" aria-label="Wording">
          <div className="wording-tabs tb-tabs" role="tablist" aria-label="Wording per output type">
            {typeList.map((type) => (
              <button
                type="button"
                role="tab"
                key={type.id}
                id={'wording-tab-' + type.id}
                aria-selected={tab === type.id}
                aria-controls="wording-panel"
                tabIndex={tab === type.id ? 0 : -1}
                className={tab === type.id ? 'active' : ''}
                onKeyDown={(event) => {
                  const index = typeList.findIndex((item) => item.id === type.id);
                  const nextIndex =
                    event.key === 'ArrowRight'
                      ? (index + 1) % typeList.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + typeList.length) % typeList.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? typeList.length - 1
                            : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  const next = typeList[nextIndex];
                  setTab(next.id);
                  setSelection(null);
                  document.getElementById('wording-tab-' + next.id)?.focus();
                }}
                onClick={() => {
                  setTab(type.id);
                  setSelection(null);
                }}
              >
                {type.name}
                {!draft.wordings[type.id]?.length ? (
                  <span className="metadata">, no wording</span>
                ) : null}
              </button>
            ))}
          </div>
          <div
            id="wording-panel"
            role="tabpanel"
            aria-labelledby={'wording-tab-' + tab}
            className="tb-centre-scroll"
          >
            {!editable ? <ReadOnlyNote version={version} canManage={canManage} /> : null}
            {editable ? (
              <div className="wording-actions">
                <label>
                  <span className="sr-only">Copy wording from</span>
                  <select value={copyFrom} onChange={(event) => setCopyFrom(event.target.value)}>
                    <option value="">Copy wording from…</option>
                    {typeList
                      .filter((t) => t.id !== tab && draft.wordings[t.id]?.length)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!copyFrom}
                  onClick={async () => {
                    if (
                      draft.wordings[tab]?.length &&
                      !(await confirmAction({
                        message: `Replace the ${typeName(tab)} wording?`,
                        confirmLabel: 'Replace wording',
                      }))
                    )
                      return;
                    change({
                      wordings: {
                        ...draft.wordings,
                        [tab]: structuredClone(draft.wordings[copyFrom]),
                      },
                    });
                    setConvertIssues((current) => ({
                      ...current,
                      [tab]: current[copyFrom] ?? [],
                    }));
                    setCopyFrom('');
                    setRemount((n) => n + 1);
                  }}
                >
                  Copy
                </button>
                {draft.wordings[tab]?.length ? (
                  <button
                    type="button"
                    className="quiet"
                    onClick={async () => {
                      if (
                        !(await confirmAction({
                          message: `Remove the ${typeName(tab)} wording? This wording will not be offered for that document type.`,
                          confirmLabel: 'Remove wording',
                        }))
                      )
                        return;
                      const next = { ...draft.wordings };
                      delete next[tab];
                      change({ wordings: next });
                      setConvertIssues((current) => ({ ...current, [tab]: [] }));
                      setRemount((n) => n + 1);
                    }}
                  >
                    Remove this wording
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="template-main">
              {tab ? (
                <TemplateEditor
                  key={`${tab}:${remount}`}
                  handleRef={editorRef}
                  mode="clause"
                  label={`${typeName(tab)} wording`}
                  value={draft.wordings[tab] ?? []}
                  fields={draft.fields}
                  readOnly={!editable}
                  onChange={(blocks, issues) => {
                    setDraft((current) => ({
                      ...current,
                      wordings: { ...current.wordings, [tab]: blocks },
                    }));
                    setConvertIssues((current) => ({ ...current, [tab]: issues }));
                    autosave.edited();
                  }}
                  onSelection={setSelection}
                  onRequestField={() => {
                    newQuestionRef.current?.closest('details')?.setAttribute('open', '');
                    newQuestionRef.current?.focus();
                  }}
                  onEditNode={() => window.setTimeout(() => settingsRef.current?.focus(), 30)}
                />
              ) : (
                <p className="metadata">Add a document type first.</p>
              )}
            </div>
          </div>
        </section>
        <section className="tb-side" aria-label="Preview and settings">
          <PaneTabs
            label="Side panel"
            idPrefix="side"
            tabs={SIDE_TABS}
            value={side}
            onChange={setSide}
          />
          <PanePanel idPrefix="side" tabKey="preview" active={side === 'preview'}>
            {hasWording ? (
              <SamplePreview
                kind="clause"
                versionId={version.id}
                outputType={
                  draft.wordings[tab]?.length
                    ? tab
                    : typeList.find((t) => draft.wordings[t.id]?.length)?.id || ''
                }
                draft={
                  editable
                    ? { wordings: filledWordings(draft.wordings), fields: draft.fields }
                    : null
                }
                fields={draft.fields}
                dirty={dirty}
                stuck={autosave.stuck}
                active={side === 'preview'}
              />
            ) : (
              <NoPreview />
            )}
          </PanePanel>
          <PanePanel idPrefix="side" tabKey="settings" active={side === 'settings'}>
            <ClauseDetails page={page} draft={draft} editable={editable} onDraft={change} />
          </PanePanel>
          <PanePanel idPrefix="side" tabKey="versions" active={side === 'versions'}>
            <VersionHistory
              versions={template.versions as ClauseVersion[]}
              currentId={version.id}
              hrefFor={(vid) => `/templates/clauses/${template.id}?version=${vid}`}
            />
          </PanePanel>
        </section>
      </div>
    </div>
  );
}

function ClauseDetails({
  page,
  draft,
  editable,
  onDraft,
}: {
  page: ReturnType<typeof useTemplateVersion<'clause'>>;
  draft: Draft;
  editable: boolean;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const { data } = useWorkspace();
  const template = page.state!.template;
  const canManage = Boolean(data?.actor.capabilities.includes('manage_templates'));
  const [meta, setMeta] = useState({
    name: template.name,
    category: template.category,
    governingAct: template.governingAct,
    usageContexts: template.usageContexts,
    displayOrder: String(template.displayOrder),
    description: template.description,
  });
  const action = useAction();
  const metaDirty =
    meta.name !== template.name ||
    meta.category !== template.category ||
    meta.governingAct !== template.governingAct ||
    meta.usageContexts.join() !== template.usageContexts.join() ||
    meta.displayOrder !== String(template.displayOrder) ||
    meta.description !== template.description;
  return (
    <div className="tb-settings">
      <section aria-label="Details">
        <form
          className="form-grid"
          data-dirty={metaDirty ? 'true' : 'false'}
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(
              () =>
                page
                  .updateTemplate({
                    name: meta.name.trim(),
                    category: meta.category,
                    governingAct: meta.governingAct.trim(),
                    usageContexts: meta.usageContexts,
                    displayOrder: Number(meta.displayOrder) || 0,
                    description: meta.description.trim(),
                  })
                  .then(() => true)
                  .catch((e) => {
                    throw e instanceof ApiError ? e : new Error(errorText(e));
                  }),
              'Details saved',
            );
          }}
        >
          <fieldset className="plain-fieldset full form-grid" disabled={!canManage}>
            <label className="full">
              Name
              <input
                required
                maxLength={160}
                value={meta.name}
                onChange={(event) => setMeta({ ...meta, name: event.target.value })}
              />
            </label>
            <label>
              Category
              <select
                value={meta.category}
                onChange={(event) =>
                  setMeta({ ...meta, category: event.target.value as ClauseCategory })
                }
              >
                {CLAUSE_CATEGORIES.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Governing Act
              <input
                maxLength={160}
                value={meta.governingAct}
                onChange={(event) => setMeta({ ...meta, governingAct: event.target.value })}
              />
            </label>
            <label>
              Display order
              <input
                type="number"
                min={0}
                value={meta.displayOrder}
                onChange={(event) => setMeta({ ...meta, displayOrder: event.target.value })}
              />
            </label>
            <fieldset className="full">
              <legend>Used for</legend>
              {USAGE_CONTEXTS.map((context) => (
                <label className="inline" key={context.value}>
                  <input
                    type="checkbox"
                    checked={meta.usageContexts.includes(context.value)}
                    onChange={(event) =>
                      setMeta({
                        ...meta,
                        usageContexts: event.target.checked
                          ? [...meta.usageContexts, context.value as UsageContext]
                          : meta.usageContexts.filter((v) => v !== context.value),
                      })
                    }
                  />
                  {context.label}
                </label>
              ))}
            </fieldset>
            <label className="full">
              Description
              <input
                maxLength={1000}
                value={meta.description}
                onChange={(event) => setMeta({ ...meta, description: event.target.value })}
              />
            </label>
          </fieldset>
          {canManage ? (
            <div className="full form-footer">
              <ActionFeedback
                error={action.error}
                status={action.status}
                conflict={action.conflict}
                onReload={() => void page.reload()}
              />
              <div className="actions">
                <button disabled={action.pending || !metaDirty || !meta.usageContexts.length}>
                  Save details
                </button>
              </div>
            </div>
          ) : null}
        </form>
      </section>
      <section id="version-source" aria-label="Version source">
        <fieldset className="plain-fieldset form-grid" disabled={!editable}>
          <label className="full">
            Source or basis of wording{editable ? ' (required for review)' : ''}
            <textarea
              maxLength={2000}
              value={draft.source}
              onChange={(event) => onDraft({ source: event.target.value })}
            />
          </label>
          <label>
            Effective date{editable ? ' (required for review)' : ''}
            <input
              type="date"
              value={draft.effectiveDate || ''}
              onChange={(event) => onDraft({ effectiveDate: event.target.value || null })}
            />
          </label>
        </fieldset>
      </section>
    </div>
  );
}
