'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { ResolutionCase } from '@/domain/resolution/model';
import { confirmAction } from '@/components/edit-guard';
import { formatDate, useWorkspace } from '@/components/workspace';
import { plainIssue } from './api';
import { CaseDocuments } from './case-documents';
import type { CaseApi } from './case-workspace';
import { ActionFeedback, useAction } from './use-action';

/** The last step: what is still missing, review, the Word document, the signed copy. */
export function Finish({ api }: { api: CaseApi }) {
  const item = api.detail.case;
  const { gaps, gapFields, goToIssue } = api.ui;
  return (
    <div className="case-finish">
      {item.state === 'Cancelled' && item.cancellationReason ? (
        <p>Cancelled: {item.cancellationReason}</p>
      ) : null}
      {api.canEdit
        ? gaps.map((issue, index) => (
            <div className="warning" key={index}>
              {plainIssue(issue, gapFields)}{' '}
              <button type="button" className="section-link" onClick={() => goToIssue(issue)}>
                Go to it
              </button>
            </div>
          ))
        : null}
      <DirectorRecordReminder item={item} />
      <ReviewStatus api={api} />
      <CaseDocuments api={api} />
      {item.state === 'Open' || item.decision.status !== 'Not recorded' ? (
        <details className="disclosure">
          <summary>Signed copy and outcome</summary>
          <DecisionRecord api={api} />
        </details>
      ) : null}
      <CancelResolution api={api} />
    </div>
  );
}

function ReviewStatus({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const item = api.detail.case;
  const send = useAction();
  const action = useAction();
  const [reviewerId, setReviewerId] = useState('');
  if (!data) return null;
  const review = item.review;
  const name = (id: string) => data.users.find((u) => u.id === id)?.name || id;
  const canTakeBack = data.actor.id === review?.sentBy || data.actor.id === review?.reviewerId;
  if (item.state === 'Open' && review?.status === 'Approved')
    return (
      <section aria-labelledby="case-review">
        <h2 id="case-review">Review</h2>
        <div className="case-approved">
          <span>
            Approved by {name(review.reviewerId)}
            {review.comment ? `: ${review.comment}` : ''}
          </span>
          {canTakeBack ? (
            <button
              type="button"
              className="section-link"
              disabled={action.pending}
              onClick={() => void action.run(() => api.act('reopen'), 'Reopened for changes')}
            >
              Reopen for changes
            </button>
          ) : null}
        </div>
        <ActionFeedback
          error={action.error}
          status={action.status}
          conflict={action.conflict}
          onReload={() => void api.reload()}
        />
      </section>
    );
  if (!api.canEdit) return null;
  const reviewers = data.users.filter(
    (user) => user.id !== data.actor.id && user.companyIds.includes(item.companyId),
  );
  return (
    <section aria-labelledby="case-review">
      <h2 id="case-review">Review</h2>
      <form
        className="send-review-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send.run(() => api.act('send_for_review', { reviewerId }), 'Sent for review');
        }}
      >
        <label>
          Reviewer
          <select required value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            <option value="">Choose a colleague</option>
            {reviewers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={send.pending || !item.selection || !reviewerId}>
          {send.pending ? 'Sending…' : 'Send for review'}
        </button>
      </form>
      <ActionFeedback
        error={send.error}
        status={send.status}
        conflict={send.conflict}
        onReload={() => void api.reload()}
      />
    </section>
  );
}

function CancelResolution({ api }: { api: CaseApi }) {
  const closing = useAction();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  if (!api.canEdit) return null;
  return cancelling ? (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void closing.run(() => api.act('cancel', { reason }), 'Resolution cancelled');
      }}
    >
      <label>
        Reason for cancelling
        <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="actions">
        <button disabled={closing.pending || !reason.trim()}>Cancel resolution</button>
        <button type="button" onClick={() => setCancelling(false)}>
          Keep it
        </button>
      </div>
      <ActionFeedback
        error={closing.error}
        status={closing.status}
        conflict={closing.conflict}
        onReload={() => void api.reload()}
      />
    </form>
  ) : (
    <button type="button" className="quiet cancel-link" onClick={() => setCancelling(true)}>
      Cancel this resolution
    </button>
  );
}

/** The reviewer's own decision; the preview beside it is what they are checking. */
export function YourReview({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const item = api.detail.case;
  const action = useAction();
  const [comment, setComment] = useState('');
  if (!data || !item.review) return null;
  const sender = data.users.find((u) => u.id === item.review?.sentBy)?.name || item.review.sentBy;
  return (
    <section className="your-review" aria-labelledby="your-review">
      <h2 id="your-review">Your review</h2>
      <p>
        {sender} sent this on {formatDate(item.review.sentAt)}.
      </p>
      <form className="form-stack" onSubmit={(event) => event.preventDefault()}>
        <label>
          Comment
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={action.pending}
            onClick={() =>
              void action.run(
                () => api.act('review', { decision: 'Approved', comment }),
                'Approved',
              )
            }
          >
            Approve
          </button>
          <button
            type="button"
            disabled={action.pending || !comment.trim()}
            onClick={() =>
              void action.run(
                () => api.act('review', { decision: 'Returned', comment }),
                'Sent back for changes',
              )
            }
          >
            Send back for changes
          </button>
        </div>
      </form>
      <ActionFeedback
        error={action.error}
        status={action.status}
        conflict={action.conflict}
        onReload={() => void api.reload()}
      />
    </section>
  );
}

/** With someone else for review: editing waits, and the preview stays readable. */
export function Paused({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const review = api.detail.case.review;
  const action = useAction();
  if (!data || !review) return null;
  const reviewer = data.users.find((u) => u.id === review.reviewerId)?.name || review.reviewerId;
  return (
    <div className="case-paused" role="status">
      <h2>With {reviewer} for review</h2>
      <p>Sent {formatDate(review.sentAt)}. Editing is paused meanwhile.</p>
      {data.actor.id === review.sentBy ? (
        <button
          type="button"
          disabled={action.pending}
          onClick={() => void action.run(() => api.act('reopen'), 'Taken back')}
        >
          Take back to edit
        </button>
      ) : null}
      <ActionFeedback
        error={action.error}
        status={action.status}
        conflict={action.conflict}
        onReload={() => void api.reload()}
      />
    </div>
  );
}

/**
 * A director resolution records the decision only; the company's director list changes when
 * someone adds or ends the director on the company page.
 */
function DirectorRecordReminder({ item }: { item: ResolutionCase }) {
  if (item.kind === 'board' || item.state === 'Cancelled') return null;
  const change =
    item.kind === 'director_appointment'
      ? 'add the new director'
      : 'end the director’s appointment';
  return (
    <div className="warning">
      {item.state === 'Complete'
        ? 'This resolution does not change the company’s director list. '
        : 'Completing this resolution does not change the company’s director list. '}
      To record it, {change} under People on the{' '}
      <Link href={'/companies/' + item.companyId}>company page</Link>.
    </div>
  );
}

export function CompleteResolution({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const action = useAction();
  if (
    api.detail.case.state !== 'Open' ||
    api.detail.case.review?.status === 'With reviewer' ||
    !data?.actor.capabilities.some((cap) => cap === 'prepare_job' || cap === 'generate_documents')
  )
    return null;
  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={action.pending}
        onClick={async () => {
          // Completion is final: a completed resolution can no longer be edited or reopened.
          const ready = api.detail.generations.some((g) => g.status === 'Ready');
          const confirmed = await confirmAction({
            message: ready
              ? 'Mark this resolution complete? It can no longer be changed afterwards.'
              : 'This resolution has no Word document yet. Mark it complete anyway? It can no longer be changed afterwards.',
            confirmLabel: 'Mark complete',
            cancelLabel: 'Not yet',
          });
          if (confirmed) void action.run(() => api.act('complete'), 'Resolution completed');
        }}
      >
        {action.pending ? 'Completing…' : 'Mark complete'}
      </button>
      <ActionFeedback
        error={action.error}
        status={action.status}
        conflict={action.conflict}
        onReload={() => void api.reload()}
      />
    </>
  );
}

function DecisionRecord({ api }: { api: CaseApi }) {
  const { data } = useWorkspace();
  const item = api.detail.case;
  const decision = useAction();
  const [record, setRecord] = useState({
    status: item.decision.status,
    date: item.decision.date || '',
    note: item.decision.note,
    evidenceIds: item.decision.evidenceIds,
  });
  if (!data) return null;
  const evidence = data.documents.filter((d) => d.companyId === item.companyId);
  const decisionDirty =
    record.status !== item.decision.status ||
    record.date !== (item.decision.date || '') ||
    record.note !== item.decision.note ||
    record.evidenceIds.join() !== item.decision.evidenceIds.join();
  const canRecord = item.state === 'Open';
  return (
    <section className="section" aria-labelledby="case-decision">
      <h2 id="case-decision" className="sr-only">
        Signed copy and outcome
      </h2>
      <form
        className="form-grid"
        data-dirty={decisionDirty ? 'true' : 'false'}
        inert={decision.pending}
        onSubmit={(event) => {
          event.preventDefault();
          void decision.run(
            () =>
              api.act('record_decision', {
                status: record.status,
                date: record.date || null,
                note: record.note,
                evidenceIds: record.evidenceIds,
              }),
            'Decision recorded',
          );
        }}
      >
        <fieldset className="plain-fieldset full form-grid" disabled={!canRecord}>
          <label>
            Outcome
            <select
              value={record.status}
              onChange={(event) =>
                setRecord({
                  ...record,
                  status: event.target.value as typeof record.status,
                })
              }
            >
              <option>Not recorded</option>
              <option>Passed</option>
              <option>Not passed</option>
            </select>
          </label>
          <label>
            Decision date
            <input
              type="date"
              value={record.date}
              onChange={(event) => setRecord({ ...record, date: event.target.value })}
            />
          </label>
          <label className="full">
            Note
            <textarea
              value={record.note}
              maxLength={4000}
              onChange={(event) => setRecord({ ...record, note: event.target.value })}
            />
          </label>
          <fieldset className="full">
            <legend>Evidence</legend>
            {evidence.length ? (
              evidence.map((doc) => (
                <label className="inline" key={doc.id}>
                  <input
                    type="checkbox"
                    checked={record.evidenceIds.includes(doc.id)}
                    onChange={(event) =>
                      setRecord({
                        ...record,
                        evidenceIds: event.target.checked
                          ? [...record.evidenceIds, doc.id]
                          : record.evidenceIds.filter((value) => value !== doc.id),
                      })
                    }
                  />
                  {doc.title}
                </label>
              ))
            ) : (
              <p className="metadata">No company evidence uploaded.</p>
            )}
          </fieldset>
        </fieldset>
        {canRecord ? (
          <div className="full form-footer">
            <ActionFeedback
              error={decision.error}
              status={decision.status}
              conflict={decision.conflict}
              onReload={() => void api.reload()}
            />
            <div className="actions">
              <button disabled={decision.pending || !decisionDirty}>
                {decision.pending ? 'Saving…' : 'Save outcome'}
              </button>
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}
