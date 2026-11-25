import { describe, expect, it } from 'vitest';
import type { ReturnIssue } from '@/domain/ar1/build';
import {
  addressText,
  issueFix,
  issueHeadline,
  personIssueCount,
} from '@/components/returns/issue-fix';

const issue = (
  target: ReturnIssue['target'],
  severity: ReturnIssue['severity'] = 'missing',
): Pick<ReturnIssue, 'severity' | 'target'> => ({ severity, target });

describe('issue fixes', () => {
  it('words each fix by what it does', () => {
    expect(issueFix(issue({ kind: 'answer', field: 'sharesQuoted' }), 'c1')).toEqual({
      label: 'Answer',
    });
    expect(issueFix(issue({ kind: 'appointment', relationshipId: 'r1' }), 'c1').label).toBe(
      'Record designation',
    );
    expect(
      issueFix(issue({ kind: 'person', id: 'p1', keys: ['race'], roles: ['director'] }), 'c1'),
    ).toEqual({ label: 'Add particulars' });
    expect(issueFix(issue({ kind: 'company', keys: ['companyType'] }, 'blocker'), 'c1')).toEqual({
      label: 'Correct record',
    });
  });

  it('links to the record that holds the value', () => {
    expect(issueFix(issue({ kind: 'shares' }), 'c1')).toEqual({
      label: 'Open share register',
      href: '/companies/c1?tab=shares',
    });
    expect(issueFix(issue({ kind: 'officers' }), 'c1')).toEqual({
      label: 'Open officers',
      href: '/companies/c1?tab=people',
    });
    expect(issueFix(issue({ kind: 'company', keys: [] }), 'c1').href).toBe('/companies/c1');
  });

  it('sends an issue naming no particular to the person record', () => {
    expect(
      issueFix(issue({ kind: 'person', id: 'p 1', keys: [], roles: ['director'] }), 'c1'),
    ).toEqual({ label: 'Add registration number', href: '/people?person=p%201' });
  });
});

describe('person issue count', () => {
  it('counts each missing particular, and an issue naming none as one', () => {
    const issues = [
      issue({ kind: 'person', id: 'p1', keys: ['race', 'gender'], roles: ['director'] }),
      issue({ kind: 'person', id: 'p1', keys: [], roles: ['director'] }),
      issue({ kind: 'person', id: 'p2', keys: ['race'], roles: ['member'] }),
      issue({ kind: 'shares' }),
    ];
    expect(personIssueCount(issues, 'p1')).toBe(3);
    expect(personIssueCount(issues, 'p2')).toBe(1);
    expect(personIssueCount(issues, 'p3')).toBe(0);
  });
});

describe('issue headline', () => {
  it('leads with problems that stop the workbook', () => {
    expect(issueHeadline([{ severity: 'blocker' }])).toEqual({
      blocking: true,
      text: 'Fix 1 problem before the workbook can be made.',
    });
    expect(
      issueHeadline([{ severity: 'blocker' }, { severity: 'blocker' }, { severity: 'missing' }]),
    ).toEqual({
      blocking: true,
      text: 'Fix 2 problems before the workbook can be made, and fill 1 item mTool will ask for.',
    });
  });

  it('counts items to fill when nothing blocks', () => {
    expect(issueHeadline([{ severity: 'missing' }])?.text).toBe(
      '1 item needs filling before mTool will accept the workbook.',
    );
    expect(issueHeadline([{ severity: 'missing' }, { severity: 'missing' }])?.text).toBe(
      '2 items need filling before mTool will accept the workbook.',
    );
    expect(issueHeadline([])).toBeNull();
  });
});

describe('address text', () => {
  it('reads workbook address cells on one line', () => {
    expect(
      addressText(['1 Jalan Example', '', '', '47000', 'Sungai Buloh', 'SELANGOR', 'MALAYSIA']),
    ).toBe('1 Jalan Example, 47000 Sungai Buloh, SELANGOR, MALAYSIA');
    expect(addressText(['', '', '', '', '', '', ''])).toBe('');
  });
});
