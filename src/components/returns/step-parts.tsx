'use client';
import Link from 'next/link';
import type { getReturn } from '@/server/ar1/returns';
import type { ReturnIssue } from '@/domain/ar1/build';
import { newRequestId, postJson } from '@/components/resolution/api';
import { useAction } from '@/components/resolution/use-action';
import { WarningLine } from '@/components/warning-line';
import { issueFix, personIssueCount } from './issue-fix';

/** The annual return as GET /api/annual-returns/:id returns it. */
export type ReturnView = Awaited<ReturnType<typeof getReturn>>;
export type FixTarget = ReturnIssue['target'];
export type OnFix = (target: FixTarget) => void;

/** Issues as one warning line each, with the fix at the end of the line. */
export function StepIssues({
  issues,
  companyId,
  onFix,
}: {
  issues: ReturnIssue[];
  companyId: string;
  onFix: OnFix;
}) {
  if (!issues.length) return null;
  return (
    <ul className="return-issues">
      {issues.map((issue, i) => {
        const fix = issueFix(issue, companyId);
        return (
          <WarningLine
            as="li"
            key={i}
            blocking={issue.severity === 'blocker'}
            action={
              fix.href ? (
                <Link className="section-link" href={fix.href}>
                  {fix.label}
                </Link>
              ) : (
                <button
                  type="button"
                  className="text-button section-link"
                  onClick={() => onFix(issue.target)}
                >
                  {fix.label}
                </button>
              )
            }
          >
            {issue.message}
          </WarningLine>
        );
      })}
    </ul>
  );
}

export type Fact = { label: string; value: React.ReactNode; optional?: boolean };
/** Labelled values; an empty required value reads "Missing", an empty optional one stays blank. */
export function Facts({ rows }: { rows: Fact[] }) {
  return (
    <dl className="facts stacked return-facts">
      {rows.map(({ label, value, optional }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || (optional ? null : <span className="danger-text">Missing</span>)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Save a change to the return's own answers. */
export function useSave(view: ReturnView, onSaved: () => Promise<void>) {
  const action = useAction();
  const save = (patch: Record<string, unknown>) =>
    action.run(async () => {
      await postJson(`/api/annual-returns/${view.record.id}`, {
        action: 'save',
        requestId: newRequestId(),
        expectedRevision: view.record.revision,
        ...patch,
      });
      await onSaved();
    }, 'Saved');
  return { action, save };
}

/** One party's particulars status: "Complete", or what is missing with its fix. */
function PartyStatus({
  view,
  personId,
  onFix,
  prefix,
}: {
  view: ReturnView;
  personId: string;
  onFix: OnFix;
  prefix?: string;
}) {
  const found = view.issues.filter((i) => i.target.kind === 'person' && i.target.id === personId);
  const lead = prefix ? `${prefix}: ` : '';
  if (!found.length) return <>{lead}Complete</>;
  const count = personIssueCount(found, personId);
  // Open the panel for particulars when any are missing; otherwise go to the person's record.
  const withKeys = found.find((i) => i.target.kind === 'person' && i.target.keys.length);
  const fix = issueFix(withKeys ?? found[0], view.company.id);
  const text = `${lead}${count} missing`;
  return fix.href ? (
    <Link href={fix.href}>{text}</Link>
  ) : (
    <button
      type="button"
      className="text-button"
      onClick={() => onFix((withKeys ?? found[0]).target)}
    >
      {text}
    </button>
  );
}

/** The Particulars cell of an officer or member row; a joint holding shows each party in turn. */
export function ParticularsCell({
  view,
  personIds,
  onFix,
}: {
  view: ReturnView;
  personIds: string[];
  onFix: OnFix;
}) {
  if (!personIds.length) return <td />;
  if (personIds.length === 1)
    return (
      <td>
        <PartyStatus view={view} personId={personIds[0]} onFix={onFix} />
      </td>
    );
  const nameOf = (id: string) => view.people.find((p) => p.id === id)?.fullName ?? 'Unknown';
  return (
    <td>
      {personIds.map((id, i) => (
        <span key={id}>
          {i ? ', ' : ''}
          <PartyStatus view={view} personId={id} onFix={onFix} prefix={nameOf(id)} />
        </span>
      ))}
    </td>
  );
}
