import { describe, expect, it } from 'vitest';
import {
  holderKey,
  memberIntervals,
  replay,
  ringgit,
  sen,
  transfersBetween,
  typesOfSharesWording,
  validateShareEntry,
  type ShareEntry,
} from '../src/domain/ar1/shares';

let n = 0;
const entry = (fields: Partial<ShareEntry>): ShareEntry => ({
  id: `e${++n}`,
  companyId: 'c',
  kind: 'allotment',
  date: '2020-01-01',
  classId: 'ord',
  shares: '100',
  from: null,
  to: null,
  amountPayable: null,
  amountPaid: null,
  consideration: null,
  sourceDocumentId: 'doc',
  sourceCaseId: null,
  note: '',
  status: 'Posted',
  predecessorId: null,
  voids: false,
  preparedBy: 'a',
  preparedAt: `2026-01-01T00:00:0${n % 10}Z`,
  reviewerId: 'b',
  postedAt: `2026-01-01T00:00:0${n % 10}Z`,
  revision: 2,
  ...fields,
});
const tan = { partyIds: ['tan'] };
const lee = { partyIds: ['lee'] };
const allot = (to: typeof tan, shares: string, date = '2020-01-01', paid = shares) =>
  entry({
    kind: 'allotment',
    to,
    shares,
    date,
    amountPayable: shares,
    amountPaid: paid,
    consideration: 'Cash',
  });

describe('money and wording', () => {
  it('keeps MYR in sen without floating point', () => {
    expect(sen('1500000.5')).toBe(150000050n);
    expect(ringgit(sen('0.1') + sen('0.2'))).toBe('0.30');
  });
  it("words a member's kinds of shares as mTool does", () => {
    expect(typesOfSharesWording(['Ordinary'])).toBe('Ordinary shares');
    expect(typesOfSharesWording(['Other', 'Ordinary'])).toBe('Ordinary/Other kinds of shares');
    expect(typesOfSharesWording(['Ordinary', 'Preference', 'Other'])).toBe(
      'Ordinary/Preference/Other kinds of shares',
    );
  });
  it('keys joint holders the same in any order', () => {
    expect(holderKey({ partyIds: ['b', 'a'] })).toBe(holderKey({ partyIds: ['a', 'b'] }));
  });
  it('keeps two trust subjects with the same name apart', () => {
    const trust = (subjectIdNumber: string) => ({
      partyIds: ['tan'],
      trustee: {
        type: 'Trustee of under age member' as const,
        subjectName: 'Child (fictional)',
        subjectIdNumber,
        subjectIdType: 'MyKad',
        subjectNationality: 'MALAYSIA',
      },
    });
    const first = trust('100101-10-1111');
    const second = trust('100101101112');
    expect(holderKey(trust('100101101111'))).toBe(holderKey(first));
    const { holdings } = replay([allot(first, '100'), allot(second, '200')]).state;
    expect(holdings.map((h) => [h.holder.trustee?.subjectIdNumber, h.shares])).toEqual([
      ['100101-10-1111', 100n],
      ['100101101112', 200n],
    ]);
  });
});

describe('replay', () => {
  it('computes holdings, treasury and issued totals as at a date', () => {
    const entries = [
      allot(tan, '1000'),
      allot(lee, '500', '2021-06-01', '250'),
      entry({ kind: 'transfer', from: tan, to: lee, shares: '200', date: '2022-01-01' }),
      entry({ kind: 'buyback', from: lee, shares: '100', date: '2023-01-01' }),
    ];
    const at2021 = replay(entries, '2021-12-31').state;
    expect(at2021.holdings.map((h) => [h.key, h.shares])).toEqual([
      ['tan', 1000n],
      ['lee', 500n],
    ]);
    const now = replay(entries).state;
    expect(Object.fromEntries(now.holdings.map((h) => [h.key, h.shares]))).toEqual({
      tan: 800n,
      lee: 600n,
    });
    expect(now.treasury.get('ord')).toBe(100n);
    const issued = now.issued.get('ord')!;
    expect(issued.cash).toBe(1500n);
    expect(ringgit(issued.fullyPaid)).toBe('1000.00');
    expect(ringgit(issued.partlyPaid)).toBe('250.00');
  });
  it('reports a transfer of more shares than held', () => {
    const { problems } = replay([
      allot(tan, '100'),
      entry({ kind: 'transfer', from: tan, to: lee, shares: '150', date: '2021-01-01' }),
    ]);
    expect(problems).toHaveLength(1);
  });
  it('applies corrections and ignores drafts', () => {
    const first = allot(tan, '100');
    const entries = [
      { ...first, status: 'Superseded' as const },
      { ...allot(tan, '120'), predecessorId: first.id },
      { ...allot(lee, '999'), status: 'Draft' as const },
    ];
    expect(replay(entries).state.holdings.map((h) => h.shares)).toEqual([120n]);
  });
});

describe('members and transfers', () => {
  it('gives each party an interval while they hold shares', () => {
    const entries = [
      allot(tan, '100', '2020-01-01'),
      entry({ kind: 'transfer', from: tan, to: lee, shares: '100', date: '2022-03-01' }),
    ];
    expect(memberIntervals(entries)).toEqual([
      { partyId: 'tan', startDate: '2020-01-01', endDate: '2022-03-01' },
      { partyId: 'lee', startDate: '2022-03-01', endDate: null },
    ]);
    expect(transfersBetween(entries, '2021-01-01', '2022-12-31')).toHaveLength(1);
    expect(transfersBetween(entries, '2022-03-01', '2022-12-31')).toHaveLength(0);
  });
  it('checks entry fields', () => {
    const base = {
      kind: 'allotment' as const,
      date: '2020-01-01',
      classId: 'ord',
      shares: '0',
      from: null,
      to: null,
      amountPayable: '10',
      amountPaid: '20',
      consideration: null,
    };
    expect(validateShareEntry(base, ['ord'])).toEqual([
      'Enter the number of shares as a whole number.',
      'Choose who receives the shares.',
      'The amount paid cannot be more than the amount payable.',
      'Choose cash or otherwise than cash.',
    ]);
    expect(
      validateShareEntry(
        { ...base, kind: 'transfer', shares: '5', from: tan, to: { partyIds: ['tan'] } },
        ['ord'],
      ),
    ).toEqual(['A transfer needs a different receiving holder.']);
  });
});
