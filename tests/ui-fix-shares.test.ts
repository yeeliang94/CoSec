import { describe, expect, it } from 'vitest';
import { holderName, peopleByIdUrls, registerPartyIds } from '@/components/company/shares/names';
import { entryStatus, reviewItems } from '@/components/company/shares/review';
import { optionText, pickFrom } from '@/components/company/shares/holder-picker';

describe('register names', () => {
  it('lists each party the register names once', () => {
    expect(
      registerPartyIds([
        { from: null, to: { partyIds: ['a', 'b'] } },
        { from: { partyIds: ['b'] }, to: { partyIds: ['c'] } },
        { from: { partyIds: ['a'] }, to: null },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('splits id lookups at the server limit', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `p${i}`);
    expect(peopleByIdUrls(ids, 2)).toEqual([
      '/api/people?ids=p0%2Cp1',
      '/api/people?ids=p2%2Cp3',
      '/api/people?ids=p4',
    ]);
    expect(peopleByIdUrls([])).toEqual([]);
  });

  it('names joint and trust holders', () => {
    const names = new Map([
      ['a', 'Aina'],
      ['b', 'Ben'],
    ]);
    expect(holderName(null, names)).toBe('Treasury');
    expect(holderName({ partyIds: ['a', 'b'] }, names)).toBe('Aina and Ben');
    expect(holderName({ partyIds: ['x'] }, names)).toBe('Unknown');
  });
});

describe('review controls', () => {
  const handlers = { onPost: () => {}, onWithdraw: () => {}, onCorrect: () => {} };
  it('lets someone other than the preparer post a draft', () => {
    const draft = { status: 'Draft' as const, preparedBy: 'u1' };
    const labels = (actorId: string) =>
      reviewItems(draft, { canEdit: true, actorId, ...handlers }).map((i) => i.label);
    expect(labels('u2')).toEqual(['Review and post', 'Withdraw draft']);
    expect(labels('u1')).toEqual(['Withdraw draft']);
    expect(entryStatus(draft, 'u1')).toBe('Waiting for review');
    expect(entryStatus(draft, 'u2')).toBe('To review');
  });

  it('corrects a posted entry and offers nothing without edit rights', () => {
    const posted = { status: 'Posted' as const, preparedBy: 'u1' };
    expect(
      reviewItems(posted, { canEdit: true, actorId: 'u2', ...handlers }).map((i) => i.label),
    ).toEqual(['Correct']);
    expect(reviewItems(posted, { canEdit: false, actorId: 'u2', ...handlers })).toEqual([]);
  });
});

describe('holder search', () => {
  const people = [
    { id: 'person-000001', fullName: 'Aina Binti Ali' },
    { id: 'person-000002', fullName: 'Tan Wei' },
    { id: 'person-000003', fullName: 'Tan Wei' },
  ];
  it('picks an exact option, or the only person with the typed name', () => {
    expect(pickFrom(people, optionText(people[2]))?.id).toBe('person-000003');
    expect(pickFrom(people, 'aina binti ali')?.id).toBe('person-000001');
    expect(pickFrom(people, 'Tan Wei')).toBeUndefined();
    expect(pickFrom(people, 'Aina')).toBeUndefined();
  });
});
