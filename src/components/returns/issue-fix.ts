import type { AddressCells, FixTarget, ReturnIssue } from '@/domain/ar1/build';
import { formatAddress } from '@/domain/address';

/**
 * How an issue is fixed: a named button that opens a side panel or moves to a step, or a section
 * link to the record that holds the value. The label says what the fix does.
 */
export type IssueFix = { label: string; href?: string };

export function issueFix(
  issue: Pick<ReturnIssue, 'severity' | 'target'>,
  companyId: string,
): IssueFix {
  const target: FixTarget = issue.target;
  const correcting = issue.severity === 'blocker';
  switch (target.kind) {
    case 'answer':
      return { label: 'Answer' };
    case 'appointment':
      return { label: 'Record designation' };
    case 'shares':
      return { label: 'Open share register', href: `/companies/${companyId}?tab=shares` };
    case 'officers':
      return { label: 'Open officers', href: `/companies/${companyId}?tab=people` };
    case 'company':
      if (target.keys.length) return { label: correcting ? 'Correct record' : 'Add particulars' };
      // Nothing in the particulars panel holds it, such as the registration number.
      return { label: 'Correct record', href: `/companies/${companyId}` };
    case 'person':
      if (target.keys.length) return { label: correcting ? 'Correct record' : 'Add particulars' };
      // A director's other directorship without a registration number, kept on the person.
      return {
        label: 'Add registration number',
        href: `/people?person=${encodeURIComponent(target.id)}`,
      };
  }
}

/** Items still to fill for one person: each missing particular, or one for an issue naming none. */
export function personIssueCount(issues: Pick<ReturnIssue, 'target'>[], personId: string) {
  return issues.reduce(
    (n, i) =>
      i.target.kind === 'person' && i.target.id === personId
        ? n + Math.max(i.target.keys.length, 1)
        : n,
    0,
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one line above the steps: problems that stop the workbook first, then items mTool needs. */
export function issueHeadline(issues: Pick<ReturnIssue, 'severity'>[]) {
  const blockers = issues.filter((i) => i.severity === 'blocker').length;
  const missing = issues.length - blockers;
  if (blockers)
    return {
      blocking: true,
      text:
        `Fix ${plural(blockers, 'problem', 'problems')} before the workbook can be made` +
        (missing ? `, and fill ${plural(missing, 'item', 'items')} mTool will ask for.` : '.'),
    };
  if (missing)
    return {
      blocking: false,
      text: `${plural(missing, 'item needs', 'items need')} filling before mTool will accept the workbook.`,
    };
  return null;
}

/** An address as the workbook holds it, on one line as the screens show addresses. */
export function addressText(cells: AddressCells) {
  const [Line1, Line2, Line3, Postcode, Town, State, Country] = cells;
  return formatAddress({ Line1, Line2, Line3, Postcode, Town, State, Country });
}
