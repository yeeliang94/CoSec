import { expect, it } from 'vitest';
import { correctSuggestion } from '../src/server/imports/fields';

const source = { fileId: 'f1', page: 1, quote: 'x' };

it('corrects a charge with the same checks the agent passes', () => {
  const charge = {
    id: 'S1',
    kind: 'charge' as const,
    registeredNumber: '202100004567',
    registeredOn: '2021-08-18',
    nature: 'Debenture',
    chargee: 'Fictional Bank Berhad',
    amount: '1500000',
    dischargedOn: null,
    source,
    use: true,
  };
  const ok = correctSuggestion(
    charge,
    {
      registeredNumber: '202100004567',
      registeredOn: '2021-08-18',
      nature: 'Debenture',
      chargee: 'Fictional Bank Berhad',
      amount: '1,250,000.00',
      dischargedOn: '2024-05-01',
    },
    true,
  );
  expect(ok.errors).toEqual([]);
  expect(ok.next).toMatchObject({ amount: '1250000.00', dischargedOn: '2024-05-01' });
  const bad = correctSuggestion(charge, { ...ok.next, registeredOn: 'yesterday' } as never, true);
  expect(bad.errors.length).toBeGreaterThan(0);
});

it('corrects a role and sets a reason for leaving when an end date is given', () => {
  const role = {
    id: 'S2',
    kind: 'role' as const,
    personRef: 'P1',
    role: 'secretary' as const,
    startDate: '2020-01-01',
    endDate: null,
    cessation: null,
    source,
    use: false,
  };
  const { next, errors } = correctSuggestion(
    role,
    { role: 'secretary', startDate: '2020-01-01', endDate: '2023-06-30', cessation: null },
    true,
  );
  expect(errors).toEqual([]);
  expect(next).toMatchObject({ endDate: '2023-06-30', cessation: 'other_cessation' });
  expect(
    correctSuggestion(role, { role: 'chairman', startDate: '2020-01-01' }, true).errors,
  ).toContain('Choose a role.');
});

it('never saves a masked registration number back over the real one', () => {
  const org = {
    id: 'S3',
    kind: 'person' as const,
    ref: 'P2',
    personKind: 'organisation' as const,
    fullName: 'Sungai Capital Sdn. Bhd.',
    values: { identityType: 'Local Company', identityNumber: '201901012345' },
    effectiveDate: null,
    source,
    use: true,
  };
  const { next } = correctSuggestion(
    org,
    { fullName: 'Sungai Capital Sdn. Bhd.', identityNumber: '201901-**-****' },
    false,
  );
  expect(next.kind === 'person' && next.values.identityNumber).toBe('201901012345');
});
