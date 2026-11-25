'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  AssemblyVersion,
  BlockNode,
  FieldDefinition,
  PageLayout,
  SignatureSettings,
} from '@/domain/resolution/model';
import { Icon, useWorkspace } from '@/components/workspace';
import {
  TemplateEditor,
  type SelectionContext,
  type TemplateEditorHandle,
} from '@/components/template-editor/editor';
import { tokensToFields, toTiptap, type ConvertIssue } from '@/components/template-editor/convert';
import { FieldInspector } from '@/components/template-editor/field-inspector';
import { InlineEditor } from '@/components/template-editor/inline-editor';
import { latest } from './api';
import { VersionHistory, VersionLifecycle } from './lifecycle';
import {
  AutosaveNotice,
  AutosaveStatus,
  DiffSummary,
  IssueList,
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
import { AssemblyDetails } from './assembly-details';

type Part = 'header' | 'closing';
export type Draft = {
  header: BlockNode[];
  closing: BlockNode[];
  signature: SignatureSettings;
  starterClauseIds: string[];
  fields: FieldDefinition[];
  layout: PageLayout;
  source: string;
  effectiveDate: string | null;
};
/** Canvases the field list can insert into: the two wording parts and the running lines. */
type Target = Part | 'pageHeader' | 'pageFooter';

type SideTab = 'preview' | 'settings' | 'versions';
const SIDE_TABS: { key: SideTab; label: string }[] = [
  { key: 'preview', label: 'Preview' },
  { key: 'settings', label: 'Settings' },
  { key: 'versions', label: 'Versions' },
];

export function AssemblyEditor({ id }: { id: string }) {
  const page = useTemplateVersion('assembly', id);
  if (!page.state)
    return (
      <div className="tb-loading">
        <Link href="/templates?tab=layouts" className="back-link">
          <Icon kind="back" />
          Templates
        </Link>
        <LoadState
          loading={page.loading}
          error={page.error}
          reload={() => void page.reload()}
          label="layout"
        />
      </div>
    );
  return <AssemblyWorkbench key={`${page.state.version.id}:${page.generation}`} page={page} />;
}

function AssemblyWorkbench({ page }: { page: ReturnType<typeof useTemplateVersion<'assembly'>> }) {
  const { data } = useWorkspace();
  const state = page.state!;
  const { template, version } = state;
  const canManage = Boolean(data?.actor.capabilities.includes('manage_templates'));
  const editable = canManage && (version.status === 'Draft' || version.status === 'Returned');
  const [draft, setDraft] = useState<Draft>(() => ({
    header: structuredClone(version.header),
    closing: structuredClone(version.closing),
    signature: { ...version.signature },
    starterClauseIds: [...version.starterClauseIds],
    fields: structuredClone(version.fields),
    // Running lines typed with {{field_id}} tokens open as field chips.
    layout: {
      ...structuredClone(version.layout),
      header: tokensToFields(version.layout.header),
      footer: tokensToFields(version.layout.footer),
    },
    source: version.source,
    effectiveDate: version.effectiveDate,
  }));
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const [convertIssues, setConvertIssues] = useState<Record<Part, ConvertIssue[]>>(() => ({
    header: toTiptap(version.header, 'assembly').issues,
    closing: toTiptap(version.closing, 'assembly').issues,
  }));
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [active, setActive] = useState<Part>('header');
  const headerRef = useRef<TemplateEditorHandle>(null);
  const closingRef = useRef<TemplateEditorHandle>(null);
  const pageHeaderRef = useRef<TemplateEditorHandle>(null);
  const pageFooterRef = useRef<TemplateEditorHandle>(null);
  const activePart = useRef<Target>('header');
  // The inspector inserts into whichever canvas was used last.
  const activeRef = useMemo(
    () =>
      ({
        get current() {
          return {
            header: headerRef,
            closing: closingRef,
            pageHeader: pageHeaderRef,
            pageFooter: pageFooterRef,
          }[activePart.current].current;
        },
      }) as React.RefObject<TemplateEditorHandle | null>,
    [],
  );
  const [runningIssues, setRunningIssues] = useState<Record<'header' | 'footer', ConvertIssue[]>>({
    header: [],
    footer: [],
  });
  const runningEditor = (key: 'header' | 'footer') => {
    const target: Target = key === 'header' ? 'pageHeader' : 'pageFooter';
    return (
      <InlineEditor
        handleRef={key === 'header' ? pageHeaderRef : pageFooterRef}
        label={key === 'header' ? 'Running header' : 'Running footer'}
        value={draft.layout[key]}
        fields={draft.fields}
        readOnly={!editable}
        onFocus={() => {
          activePart.current = target;
        }}
        onSelection={(context) => {
          activePart.current = target;
          setSelection(context);
        }}
        onChange={(nodes, issues) => {
          setDraft((current) => ({ ...current, layout: { ...current.layout, [key]: nodes } }));
          setRunningIssues((current) => ({ ...current, [key]: issues }));
          autosave.edited();
        }}
      />
    );
  };
  const newQuestionRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const [side, setSide] = useState<SideTab>('preview');
  const converter = (['header', 'closing'] as Part[]).flatMap((part) =>
    convertIssues[part].map((issue) => ({
      wording: part,
      name: part === 'header' ? 'Header' : 'Closing',
      issue,
    })),
  );
  const autosave = useDraftAutosave({
    enabled: editable,
    blocked:
      converter.length > 0 || runningIssues.header.length > 0 || runningIssues.footer.length > 0,
    lastSaved: version.updatedAt,
    save: () =>
      page.saveDraft({
        ...draftNow.current,
        effectiveDate: draftNow.current.effectiveDate || null,
      }),
  });
  const dirty = autosave.dirty;
  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    autosave.edited();
  };
  // Running page header and footer count as uses too, so their fields cannot be deleted.
  const wordingRefs = [
    { key: 'header', name: 'Header', blocks: draft.header },
    { key: 'closing', name: 'Closing', blocks: draft.closing },
    {
      key: 'page_header',
      name: 'Page header',
      blocks: [{ type: 'paragraph' as const, content: draft.layout.header }],
    },
    {
      key: 'page_footer',
      name: 'Page footer',
      blocks: [{ type: 'paragraph' as const, content: draft.layout.footer }],
    },
  ];
  const editorFor = (part: Part) => (
    <TemplateEditor
      handleRef={part === 'header' ? headerRef : closingRef}
      mode="assembly"
      label={part === 'header' ? 'Header wording' : 'Closing wording'}
      value={draft[part]}
      fields={draft.fields}
      readOnly={!editable}
      onChange={(blocks, issues) => {
        setDraft((current) => ({ ...current, [part]: blocks }));
        setConvertIssues((current) => ({ ...current, [part]: issues }));
        autosave.edited();
      }}
      onSelection={(context) => {
        activePart.current = part;
        setActive(part);
        setSelection(context);
      }}
      onRequestField={() => {
        activePart.current = part;
        setActive(part);
        newQuestionRef.current?.closest('details')?.setAttribute('open', '');
        newQuestionRef.current?.focus();
      }}
      onEditNode={() => {
        activePart.current = part;
        setActive(part);
        window.setTimeout(() => settingsRef.current?.focus(), 30);
      }}
    />
  );
  const previous = useMemo(
    () =>
      template.versions
        .filter(
          (v) =>
            (v.status === 'Published' || v.status === 'Superseded') && v.version < version.version,
        )
        .sort((a, b) => b.version - a.version)[0] ?? null,
    [template.versions, version.version],
  );

  const clauses = state.otherClauses.filter((c) => !c.archived);
  const clauseName = (cid: string) =>
    state.otherClauses.find((c) => c.id === cid)?.name || 'Unavailable wording';
  const [adding, setAdding] = useState('');
  const [starterStatus, setStarterStatus] = useState('');
  /**
   * Rows are keyed by clause id, so the pressed control stays mounted. Keep focus on it; when it
   * becomes disabled at the list edge, fall back to the opposite move button.
   */
  const moveStarter = (index: number, to: number, pressed?: HTMLButtonElement) => {
    if (to < 0 || to >= draft.starterClauseIds.length) return;
    const next = [...draft.starterClauseIds];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    change({ starterClauseIds: next });
    setStarterStatus(`${clauseName(item)} moved to position ${to + 1} of ${next.length}.`);
    if (!pressed) return;
    window.setTimeout(() => {
      if (!pressed.disabled) return pressed.focus();
      const row = document.getElementById(`starter-${item}`);
      const fallback = [
        ...(row?.querySelectorAll<HTMLButtonElement>('.reorder-controls button') ?? []),
      ]
        .slice(0, 2)
        .find((button) => !button.disabled);
      (fallback ?? row)?.focus();
    }, 20);
  };

  return (
    <div className="tb" data-dirty={dirty ? 'true' : 'false'}>
      <VersionLifecycle
        heading={
          <>
            <Link href="/templates?tab=layouts" className="back-link">
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
              {template.archived ? ', archived' : ''}
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
            wordings={[
              { name: 'Header', before: previous?.header, after: draft.header },
              { name: 'Closing', before: previous?.closing, after: draft.closing },
            ]}
          />
        }
        onChanged={page.reload}
        onNewVersion={(next) => page.selectVersion(next)}
      />
      <AutosaveNotice autosave={autosave} onReload={() => void page.reload()} />
      <IssueList
        issues={state.issues}
        converter={converter}
        onNavigate={(target) => {
          const part: Part | undefined =
            target.wording === 'closing' || /closing/i.test(target.location)
              ? 'closing'
              : target.wording === 'header' || /header/i.test(target.location)
                ? 'header'
                : undefined;
          if (part) {
            window.setTimeout(() => {
              const ref = part === 'header' ? headerRef : closingRef;
              if (target.block !== undefined) ref.current?.focusBlock(target.block);
              else ref.current?.focus();
            }, 60);
          } else if (/effective|source/i.test(target.location)) {
            // The field lives on the Settings tab, which has to be showing to take focus.
            setSide('settings');
            window.setTimeout(() => goToVersionField(target.location), 30);
          } else if (/signature/i.test(target.location)) {
            setSide('settings');
            window.setTimeout(
              () =>
                document.getElementById('signature-settings')?.scrollIntoView({ block: 'center' }),
              30,
            );
          } else if (/starter/i.test(target.location)) {
            document.getElementById('starters-title')?.scrollIntoView({ block: 'center' });
          } else if (/field/i.test(target.location)) {
            const fields = newQuestionRef.current?.closest('details');
            fields?.setAttribute('open', '');
            fields?.scrollIntoView({ block: 'center' });
          }
        }}
      />
      <div className="tb-panes">
        <section className="tb-fields" aria-label="Shared questions">
          <FieldInspector
            title="Shared questions"
            fields={draft.fields}
            onFieldsChange={(fields) => change({ fields })}
            wordings={wordingRefs}
            selection={selection}
            editor={activeRef}
            readOnly={!editable}
            defaultScope="case"
            customDefinitions={state.definitions}
            newQuestionRef={newQuestionRef}
            settingsRef={settingsRef}
          />
        </section>
        <section className="tb-centre" aria-label="Layout wording">
          <div className="tb-centre-scroll tb-parts">
            {!editable ? <ReadOnlyNote version={version} canManage={canManage} /> : null}
            <div className="template-main">
              <h2 className="canvas-label" data-active={active === 'header'}>
                Header
              </h2>
              {editorFor('header')}
              {[...draft.header, ...draft.closing].some((b) => b.type === 'clauseSlot') ? null : (
                <div className="selected-wording-slot">Selected wording appears here</div>
              )}
              <h2 className="canvas-label" data-active={active === 'closing'}>
                Closing
              </h2>
              {editorFor('closing')}
            </div>
            <section className="section" aria-labelledby="starters-title">
              <h2 id="starters-title">Starting wording</h2>
              <p className="sr-only" role="status" aria-live="polite">
                {starterStatus}
              </p>
              {draft.starterClauseIds.length ? (
                <ol className="selected-clause-list starter-list">
                  {draft.starterClauseIds.map((cid, index) => (
                    <li
                      key={cid}
                      id={`starter-${cid}`}
                      tabIndex={editable ? 0 : undefined}
                      aria-label={`${index + 1}. ${clauseName(cid)}${editable ? '. Alt plus arrow keys move it.' : ''}`}
                      onKeyDown={(event) => {
                        if (!editable || !event.altKey) return;
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          moveStarter(index, index - 1);
                        } else if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          moveStarter(index, index + 1);
                        }
                      }}
                    >
                      <div className="selected-clause-row">
                        <span className="clause-index" aria-hidden="true">
                          {index + 1}
                        </span>
                        <div className="clause-meta">
                          <strong>{clauseName(cid)}</strong>
                          <div className="metadata">
                            {state.otherClauses.find((c) => c.id === cid)?.category}
                            {(() => {
                              const c = state.otherClauses.find((x) => x.id === cid);
                              const v = c && latest(c.versions);
                              return v ? `, latest v${v.version} ${v.status.toLowerCase()}` : '';
                            })()}
                          </div>
                        </div>
                        {editable ? (
                          <div className="reorder-controls">
                            <button
                              type="button"
                              className="quiet"
                              aria-label={`Move ${clauseName(cid)} up`}
                              disabled={index === 0}
                              onClick={(event) =>
                                moveStarter(index, index - 1, event.currentTarget)
                              }
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="quiet"
                              aria-label={`Move ${clauseName(cid)} down`}
                              disabled={index === draft.starterClauseIds.length - 1}
                              onClick={(event) =>
                                moveStarter(index, index + 1, event.currentTarget)
                              }
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="quiet"
                              aria-label={`Remove ${clauseName(cid)}`}
                              onClick={() =>
                                change({
                                  starterClauseIds: draft.starterClauseIds.filter((x) => x !== cid),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="metadata">No starting wording</p>
              )}
              {editable ? (
                <div className="toolbar add-starter">
                  <label className="wide-select">
                    Add from library
                    <select value={adding} onChange={(event) => setAdding(event.target.value)}>
                      <option value="">Choose wording…</option>
                      {clauses
                        .filter((c) => !draft.starterClauseIds.includes(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.category}, {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={!adding}
                    onClick={() => {
                      change({ starterClauseIds: [...draft.starterClauseIds, adding] });
                      setAdding('');
                    }}
                  >
                    Add wording
                  </button>
                </div>
              ) : null}
            </section>
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
            <SamplePreview
              kind="assembly"
              versionId={version.id}
              outputType={template.outputTypeId}
              draft={
                editable
                  ? {
                      header: draft.header,
                      closing: draft.closing,
                      signature: draft.signature,
                      fields: draft.fields,
                      layout: draft.layout,
                      starterClauseIds: draft.starterClauseIds,
                    }
                  : null
              }
              fields={draft.fields}
              dirty={dirty}
              stuck={autosave.stuck}
              active={side === 'preview'}
            />
          </PanePanel>
          <PanePanel idPrefix="side" tabKey="settings" active={side === 'settings'}>
            <div className="tb-settings">
              <AssemblyDetails page={page} draft={draft} editable={editable} onDraft={change} />
              <fieldset className="plain-fieldset" disabled={!editable}>
                <section className="section" aria-labelledby="signature-settings">
                  <h2 id="signature-settings">Signatures</h2>
                  <div className="form-grid">
                    <label>
                      Columns
                      <select
                        value={draft.signature.columns}
                        onChange={(event) =>
                          change({
                            signature: {
                              ...draft.signature,
                              columns: Number(event.target.value) as 1 | 2 | 3,
                            },
                          })
                        }
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                    </label>
                    <label>
                      Label under each line
                      <input
                        value={draft.signature.label}
                        onChange={(event) =>
                          change({ signature: { ...draft.signature, label: event.target.value } })
                        }
                      />
                    </label>
                    <details className="advanced-filters full">
                      <summary>Signature placeholders</summary>
                      <dl className="record-meta">
                        <div>
                          <dt>Name</dt>
                          <dd>
                            <code>{'{name}'}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Capacity</dt>
                          <dd>
                            <code>{'{capacity}'}</code>
                          </dd>
                        </div>
                      </dl>
                    </details>
                    <label className="inline full">
                      <input
                        type="checkbox"
                        checked={draft.signature.showDate}
                        onChange={(event) =>
                          change({
                            signature: { ...draft.signature, showDate: event.target.checked },
                          })
                        }
                      />
                      Show a date line under each signature
                    </label>
                  </div>
                  <dl className="record-meta">
                    <div>
                      <dt>Roles in use</dt>
                      <dd>
                        {[...draft.header, ...draft.closing]
                          .filter((b) => b.type === 'signatureBlock')
                          .map((b) => (b.type === 'signatureBlock' ? b.role : ''))
                          .join(', ') || 'None'}
                      </dd>
                    </div>
                  </dl>
                </section>
                <section className="section" aria-labelledby="layout-settings">
                  <h2 id="layout-settings">Page layout</h2>
                  <div className="form-grid">
                    <div className="field-pair full">
                      <label>
                        Page size
                        <select
                          value={draft.layout.pageSize}
                          onChange={(event) =>
                            change({
                              layout: {
                                ...draft.layout,
                                pageSize: event.target.value as 'A4' | 'Letter',
                              },
                            })
                          }
                        >
                          <option>A4</option>
                          <option>Letter</option>
                        </select>
                      </label>
                      <label>
                        Font
                        <select
                          value={draft.layout.fontFamily}
                          onChange={(event) =>
                            change({
                              layout: {
                                ...draft.layout,
                                fontFamily: event.target.value as PageLayout['fontFamily'],
                              },
                            })
                          }
                        >
                          <option>Arial</option>
                          <option>Times New Roman</option>
                          <option>Calibri</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      Font size (pt)
                      <input
                        type="number"
                        min={8}
                        max={16}
                        value={draft.layout.fontSizePt}
                        onChange={(event) =>
                          change({
                            layout: {
                              ...draft.layout,
                              fontSizePt: Number(event.target.value) || 11,
                            },
                          })
                        }
                      />
                    </label>
                    <fieldset className="full margins">
                      <legend>Margins (mm)</legend>
                      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                        <label key={side}>
                          {side[0].toUpperCase() + side.slice(1)}
                          <input
                            type="number"
                            min={5}
                            max={60}
                            value={draft.layout.marginsMm[side]}
                            onChange={(event) =>
                              change({
                                layout: {
                                  ...draft.layout,
                                  marginsMm: {
                                    ...draft.layout.marginsMm,
                                    [side]: Number(event.target.value) || 5,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                    </fieldset>
                    <div className="full running-line">
                      <span className="running-line-label">Running header</span>
                      {runningEditor('header')}
                    </div>
                    <div className="full running-line">
                      <span className="running-line-label">Running footer</span>
                      {runningEditor('footer')}
                    </div>
                    <label className="inline full">
                      <input
                        type="checkbox"
                        checked={draft.layout.pageNumbers}
                        onChange={(event) =>
                          change({ layout: { ...draft.layout, pageNumbers: event.target.checked } })
                        }
                      />
                      Page numbers (&ldquo;Page X of Y&rdquo;)
                    </label>
                  </div>
                </section>
              </fieldset>
            </div>
          </PanePanel>
          <PanePanel idPrefix="side" tabKey="versions" active={side === 'versions'}>
            <VersionHistory
              versions={template.versions as AssemblyVersion[]}
              currentId={version.id}
              hrefFor={(vid) => `/templates/assemblies/${template.id}?version=${vid}`}
            />
          </PanePanel>
        </section>
      </div>
    </div>
  );
}
