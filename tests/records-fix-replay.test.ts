import { describe, expect, it } from 'vitest';
import {
  effectiveEntries,
  memberIntervalSources,
  memberIntervals,
  replay,
  type ShareEntry,
} from '../src/domain/ar1/shares';

let n = 0;
const entry = (fields: Partial<ShareEntry>): ShareEntry => ({
  id: `r${String(++n).padStart(3, '0')}`,
  companyId: 'c',
  kind: 'opening',
  date: '2025-01-01',
  classId: 'ord',
  shares: '100',
  from: null,
  to: null,
  amountPayable: '100',
  amountPaid: '100',
  consideration: 'Cash',
  sourceDocumentId: 'doc',
  sourceCaseId: null,
  note: '',
  status: 'Posted',
  predecessorId: null,
  voids: false,
  preparedBy: 'a',
  preparedAt: '2026-01-01T00:00:00Z',
  reviewerId: 'b',
  postedAt: '2026-01-01T00:00:00Z',
  revision: 2,
  ...fields,
});
const A = { partyIds: ['A'] };
const B = { partyIds: ['B'] };
const shares = (entries: ShareEntry[]) =>
  Object.fromEntries(replay(entries).state.holdings.map((h) => [h.key, h.shares]));

describe('same-date replay order', () => {
  it('accepts a posted correction of an opening balance that a same-date transfer relies on', () => {
    const opening = entry({ to: A, postedAt: '2026-01-01T09:00:00Z' });
    const transfer = entry({
      kind: 'transfer',
      from: A,
      to: B,
      shares: '40',
      amountPayable: null,
      amountPaid: null,
      consideration: null,
      postedAt: '2026-01-02T09:00:00Z',
    });
    expect(replay([opening, transfer]).problems).toEqual([]);
    // The correction is posted last; it must still replay where the opening balance was.
    const correction = entry({
      to: A,
      shares: '120',
      amountPayable: '120',
      amountPaid: '120',
      predecessorId: opening.id,
      postedAt: '2026-01-03T09:00:00Z',
    });
    const after = [{ ...opening, status: 'Superseded' as const }, transfer, correction];
    expect(replay(after).problems).toEqual([]);
    expect(shares(after)).toEqual({ A: 80n, B: 40n });
    expect(effectiveEntries(after).map((e) => e.id)).toEqual([correction.id, transfer.id]);
  });

  it('keeps a corrected transfer in its original place among same-date transfers', () => {
    const opening = entry({ to: A, postedAt: '2026-01-01T09:00:00Z' });
    const first = entry({
      kind: 'transfer',
      from: A,
      to: B,
      shares: '100',
      postedAt: '2026-01-02T09:00:00Z',
    });
    const back = entry({
      kind: 'transfer',
      from: B,
      to: A,
      shares: '50',
      postedAt: '2026-01-03T09:00:00Z',
    });
    const correction = entry({
      kind: 'transfer',
      from: A,
      to: B,
      shares: '90',
      predecessorId: first.id,
      postedAt: '2026-01-04T09:00:00Z',
    });
    const after = [opening, { ...first, status: 'Superseded' as const }, back, correction];
    expect(effectiveEntries(after).map((e) => e.id)).toEqual([opening.id, correction.id, back.id]);
    expect(replay(after).problems).toEqual([]);
    expect(shares(after)).toEqual({ A: 60n, B: 40n });
  });

  it('replays additions before transfers on the same date whatever the posting order', () => {
    const transfer = entry({
      kind: 'transfer',
      from: A,
      to: B,
      shares: '10',
      postedAt: '2026-01-01T09:00:00Z',
    });
    const allotment = entry({ kind: 'allotment', to: A, postedAt: '2026-01-02T09:00:00Z' });
    expect(replay([transfer, allotment]).problems).toEqual([]);
  });
});

describe('member intervals in one pass', () => {
  it('matches the holdings on each date and cites the opening and closing entries', () => {
    const opening = entry({ to: A, date: '2020-01-01' });
    const part = entry({
      kind: 'transfer',
      from: A,
      to: B,
      shares: '40',
      date: '2021-01-01',
    });
    const rest = entry({ kind: 'transfer', from: A, to: B, shares: '60', date: '2022-01-01' });
    const back = entry({ kind: 'transfer', from: B, to: A, shares: '100', date: '2023-01-01' });
    const entries = [opening, part, rest, back];
    expect(memberIntervalSources(entries)).toEqual([
      {
        partyId: 'A',
        startDate: '2020-01-01',
        endDate: '2022-01-01',
        entryIds: [opening.id, rest.id],
      },
      {
        partyId: 'B',
        startDate: '2021-01-01',
        endDate: '2023-01-01',
        entryIds: [part.id, back.id],
      },
      { partyId: 'A', startDate: '2023-01-01', endDate: null, entryIds: [back.id] },
    ]);
    expect(memberIntervals(entries)[0]).toEqual({
      partyId: 'A',
      startDate: '2020-01-01',
      endDate: '2022-01-01',
    });
  });

  it('keeps a party who leaves and returns on the same date, and counts joint holders', () => {
    const joint = { partyIds: ['A', 'B'] };
    const entries = [
      entry({ to: A, date: '2020-01-01' }),
      entry({ kind: 'allotment', to: joint, date: '2020-01-01' }),
      entry({ kind: 'transfer', from: A, to: B, shares: '100', date: '2021-01-01' }),
      entry({ kind: 'transfer', from: B, to: A, shares: '100', date: '2021-01-01' }),
      entry({ kind: 'buyback', from: joint, shares: '100', date: '2022-01-01' }),
    ];
    expect(memberIntervals(entries)).toEqual([
      { partyId: 'B', startDate: '2020-01-01', endDate: '2022-01-01' },
      { partyId: 'A', startDate: '2020-01-01', endDate: null },
    ]);
  });

  it('handles a long register without replaying from the start for every date', () => {
    const many = [entry({ to: A, date: '2000-01-01', shares: '100000' })];
    for (let i = 0; i < 5000; i++) {
      const day = new Date(Date.UTC(2001, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      many.push(
        entry({
          kind: 'transfer',
          from: i % 2 ? B : A,
          to: i % 2 ? A : B,
          shares: '1',
          date: day,
        }),
      );
    }
    const started = performance.now();
    const intervals = memberIntervals(many);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(intervals.filter((i) => i.partyId === 'A')).toEqual([
      { partyId: 'A', startDate: '2000-01-01', endDate: null },
    ]);
  });
});
