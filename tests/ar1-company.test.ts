import { describe, expect, it } from 'vitest';
import {
  branchesAt,
  companyAddress,
  joinAddress,
  validateBranch,
  validateCompanyParticulars,
  type Branch,
} from '../src/domain/ar1/company';
import { isMsic, msicDescription, searchMsic } from '../src/server/ar1/msic';

const office = {
  registeredLine1: 'Level 5, Menara Contoh',
  registeredPostcode: '50450',
  registeredTown: 'Kuala Lumpur',
  registeredState: 'W.P. KUALA LUMPUR',
  registeredCountry: 'MALAYSIA',
};

describe('company particulars', () => {
  const keys = (values: Parameters<typeof validateCompanyParticulars>[0]) =>
    validateCompanyParticulars(values, isMsic).map((i) => i.key);
  it('accepts mTool wording and a real MSIC code', () => {
    expect(
      keys({
        origin: 'Incorporated in Malaysia',
        status: 'Private company',
        companyType: 'Company limited by shares',
        ...office,
        membersRegisterAtRegistered: 'Yes',
        msic1: '62010',
        email: 'office@example.invalid',
      }),
    ).toEqual([]);
  });
  it('rejects unknown wording, a foreign registered office and bad MSIC codes', () => {
    expect(
      keys({
        status: 'Sdn Bhd',
        ...office,
        registeredCountry: 'SINGAPORE',
        registeredState: '',
        msic1: '99999',
        msic2: '62010',
        msic3: '62010',
      }).sort(),
    ).toEqual(['msic1', 'msic3', 'registeredCountry', 'status'].sort());
    expect(keys({ msic2: '62010' })).toEqual(['msic1']);
  });
  it('reads the registered office for registers kept there', () => {
    const values = { ...office, membersRegisterAtRegistered: 'Yes' };
    expect(joinAddress(companyAddress(values, 'membersRegister'))).toBe(
      'Level 5, Menara Contoh, 50450 Kuala Lumpur, W.P. KUALA LUMPUR, MALAYSIA',
    );
    expect(joinAddress(companyAddress(values, 'financialRecords'))).toBe('');
  });
});

describe('branches', () => {
  const branch = (from: string | null, until: string | null): Branch => ({
    id: 'b',
    Line1: '1 Jalan Cawangan',
    Line2: '',
    Line3: '',
    Postcode: '80000',
    Town: 'Johor Bahru',
    State: 'JOHOR',
    Country: 'MALAYSIA',
    phone: '',
    fax: '',
    email: '',
    website: '',
    from,
    until,
  });
  it('counts a branch only while it is open', () => {
    const list = [branch('2020-01-01', '2025-06-30'), branch(null, null)];
    expect(branchesAt(list, '2025-06-29')).toHaveLength(2);
    expect(branchesAt(list, '2025-06-30')).toHaveLength(1);
    expect(validateBranch(branch('2025-01-01', '2024-01-01'))).toContain(
      'The branch cannot close before it opened.',
    );
  });
});

describe('MSIC list', () => {
  it('holds mTool codes, including export variants, and searches by words', () => {
    expect(isMsic('62010')).toBe(true);
    expect(msicDescription('62010')).toBe('COMPUTER PROGRAMMING ACTIVITIES');
    expect(isMsic('46510e')).toBe(true);
    expect(searchMsic('computer programming').map((r) => r.code)).toContain('62010');
    expect(searchMsic('')).toEqual([]);
  });
});
