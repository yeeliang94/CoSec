import { describe, expect, it } from 'vitest';
import { chargesAt, validateCharge, type Charge } from '../src/domain/ar1/charges';

const charge = (registeredOn: string, dischargedOn: string | null): Charge => ({
  id: registeredOn,
  companyId: 'c',
  registeredNumber: `CC${registeredOn}`,
  registeredOn,
  nature: 'Fixed and floating charge',
  chargee: 'FICTIONAL BANK BERHAD',
  amount: '1500000.00',
  dischargedOn,
  note: '',
  createdBy: 'a',
  createdAt: '2026-01-01T00:00:00Z',
  revision: 1,
});

describe('charges at a return date', () => {
  it('counts charges registered by then and not yet discharged', () => {
    const list = [
      charge('2021-09-14', null),
      charge('2022-01-01', '2025-11-01'),
      charge('2026-12-01', null),
    ];
    expect(chargesAt(list, '2025-10-31').map((c) => c.id)).toEqual(['2021-09-14', '2022-01-01']);
    expect(chargesAt(list, '2025-11-01').map((c) => c.id)).toEqual(['2021-09-14']);
  });
  it('checks the fields', () => {
    expect(validateCharge({ ...charge('2022-01-01', '2021-01-01'), amount: '1,000' })).toEqual([
      'Enter the amount secured in MYR, for example 1500000.00.',
      'The discharge date cannot be before the registration date.',
    ]);
  });
});
