import { describe, expect, it } from 'vitest';
import { anniversary, dueGroup, mtoolDate, nextReturn, returnFor } from '../src/domain/ar1/returns';
import { splitRegistrationNumber } from '../src/domain/ar1/build';

describe('return dates', () => {
  it('is made up to the incorporation anniversary and due 30 days later', () => {
    expect(returnFor('2020-09-15', 2026)).toEqual({
      calendarYear: 2026,
      returnDate: '2026-09-15',
      dueDate: '2026-10-15',
      firstReturn: false,
      lastReturnDate: '2025-09-15',
    });
    expect(returnFor('2024-11-01', 2025)?.firstReturn).toBe(true);
    expect(returnFor('2024-11-01', 2024)).toBeNull();
    expect(anniversary('2020-02-29', 2025)).toBe('2025-02-28');
  });
  it('keeps an overdue return current until a later anniversary passes', () => {
    expect(nextReturn('2020-09-15', '2026-11-16')?.returnDate).toBe('2026-09-15');
    expect(nextReturn('2020-12-01', '2026-11-16')?.returnDate).toBe('2025-12-01');
    // A company not yet a year old works towards its first return.
    expect(nextReturn('2026-03-01', '2026-11-16')?.returnDate).toBe('2027-03-01');
  });
  it('groups by due date and formats dates as mTool does', () => {
    expect(dueGroup('2026-11-10', '2026-11-16')).toBe('Overdue');
    expect(dueGroup('2026-11-23', '2026-11-16')).toBe('Due this week');
    expect(dueGroup('2026-11-24', '2026-11-16')).toBe('Later');
    expect(mtoolDate('2025-11-01')).toBe('01/11/2025');
  });
  it('splits new and old registration numbers', () => {
    expect(splitRegistrationNumber('201501033210 (1157720-K)')).toEqual({
      fresh: '201501033210',
      old: '1157720-K',
    });
    expect(splitRegistrationNumber('012345678910')).toEqual({ fresh: '012345678910', old: '' });
  });
});
