'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CANDIDATE_KEY, type ResolvedDocument } from '@/domain/resolution/model';
import { Empty, Icon } from '@/components/workspace';
import {
  getJson,
  issueFields,
  postJson,
  type ClausesResponse,
  type Issue,
  type IssueField,
} from './api';
import type { CaseApi } from './case-workspace';
import { DocumentPreview } from './document-preview';
import { LoadState, useLoad } from './use-load';

type Preview = { resolved: ResolvedDocument | null; issues: Issue[]; fields: IssueField[] };

// A per-person question can have a separate gap for each person, so the row is part of the key.
const issueKey = (issue: Issue) =>
  (issue.fieldId ? `${issue.unit ?? ''}:${issue.fieldId}` : issue.message + issue.location) +
  (issue.itemId ? `#${issue.itemId}` : '');

/** The always-visible document: follows every save and links values to their questions. */
export function CasePreview({ api }: { api: CaseApi }) {
  const item = api.detail.case;
  const ui = api.ui;
  const hasSelection = Boolean(item.selection);
  const [shaded, setShaded] = useState(true);
  const [actualSize, setActualSize] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  // Nothing to preview until a layout is chosen; asking the server would only return an error.
  const load = useLoad<Preview | null>(async () => {
    if (!hasSelection) return null;
    const [preview, clauses] = await Promise.all([
      postJson<{ resolved: ResolvedDocument | null; issues: Issue[] }>(
        `/api/resolution-cases/${item.id}/preview`,
        {},
      ),
      // The form names each field, so issues can be phrased against what the reader sees.
      getJson<ClausesResponse>(`/api/resolution-cases/${item.id}/clauses`).catch(() => null),
    ]);
    const form = clauses?.form;
    // What the document shows as missing, plus anything else generating would refuse.
    const seen = new Set<string>();
    const issues = [...preview.issues, ...(clauses?.issues ?? [])].filter((issue) => {
      const key = issueKey(issue);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const fields = form ? issueFields(form) : [];
    // A value worked out from a missing answer is the same gap, reported once at that answer.
    const fromMissingAnswer = (issue: Issue) => {
      const path = fields.find((f) => f.id === issue.fieldId)?.source?.path ?? '';
      return (
        path.startsWith('selection.') &&
        issues.some((other) => other.fieldId === path.split('.')[1])
      );
    };
    return { ...preview, issues: issues.filter((issue) => !fromMissingAnswer(issue)), fields };
  }, [item.id, item.revision, hasSelection]);

  const { setGaps } = ui;
  const gaps = load.data?.issues;
  const fields = load.data?.fields;
  useEffect(() => {
    setGaps(gaps ?? [], fields ?? []);
  }, [gaps, fields, setGaps]);

  // Wording being tried out shows in the page; the saved document returns as soon as it stops.
  // A trial is tied to the saved revision it was built from, so a later save never shows stale answers.
  const [trial, setTrial] = useState<{
    id: string;
    revision: number;
    resolved: ResolvedDocument | null;
  } | null>(null);
  const revision = item.revision;
  const candidate = ui.candidateVersionId;
  useEffect(() => {
    if (!candidate || !hasSelection) return;
    let active = true;
    const timer = window.setTimeout(() => {
      postJson<{ resolved: ResolvedDocument | null }>(`/api/resolution-cases/${item.id}/preview`, {
        candidateVersionId: candidate,
      })
        .then((value) => {
          if (active) setTrial({ id: candidate, revision, resolved: value.resolved });
        })
        .catch(() => {});
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [candidate, hasSelection, item.id, revision]);
  const trying = Boolean(candidate && trial?.id === candidate && trial.revision === revision);
  const shown = trying ? trial?.resolved : load.data?.resolved;

  // Keep what is being answered or tried in view without moving the panel otherwise.
  const activeKey = ui.activeFieldIds.join(' ');
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const target = trying
      ? page.querySelector('.doc-candidate')
      : activeKey
        ? page.querySelector(`.doc-field.active`)
        : null;
    target?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, trying, shown]);

  const links = useMemo(
    () => ({
      activeFieldIds: ui.activeFieldIds,
      highlightClause: ui.highlightClause,
      candidateKey: CANDIDATE_KEY,
      onField: api.canEdit ? ui.goToField : undefined,
      onSignatures: api.canEdit ? ui.goToSigners : undefined,
    }),
    [ui.activeFieldIds, ui.highlightClause, ui.goToField, ui.goToSigners, api.canEdit],
  );

  const count = load.data?.issues.length ?? 0;
  const allAnswers = load.data?.issues.every((issue) => issue.fieldId);
  const noun = allAnswers ? 'answer' : 'item';
  return (
    <section className="case-preview-pane" aria-label="Live preview">
      <div className="case-preview-bar">
        <h2>Preview</h2>
        {api.canEdit && count ? (
          <span className="case-preview-gaps">
            <Icon kind="warning" />
            {count} {noun}
            {count === 1 ? '' : 's'} missing
            <button type="button" className="section-link" onClick={ui.nextGap}>
              Go to next
            </button>
          </span>
        ) : null}
        <span className="case-preview-tools">
          {load.data ? (
            <>
              <button type="button" className="quiet-link" onClick={() => setShaded(!shaded)}>
                {shaded ? 'Hide field shading' : 'Show field shading'}
              </button>
              <button
                type="button"
                className="quiet-link"
                onClick={() => setActualSize(!actualSize)}
              >
                {actualSize ? 'Fit to panel' : 'Actual size'}
              </button>
            </>
          ) : null}
        </span>
      </div>
      <div
        ref={pageRef}
        className={`case-preview-page${shaded ? ' shaded' : ''}${actualSize ? ' actual-size' : ''}`}
      >
        {!hasSelection ? (
          <Empty>Choose a layout to see the document</Empty>
        ) : load.data ? (
          <DocumentPreview document={shown ?? null} links={links} plain />
        ) : (
          <LoadState
            loading={load.loading}
            error={load.error}
            reload={() => void load.reload()}
            label="preview"
          />
        )}
        {load.data && load.error ? (
          <p className="feedback error" role="alert">
            {load.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
