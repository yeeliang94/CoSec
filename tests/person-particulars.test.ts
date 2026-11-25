import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  addressOf,
  maskIdentity,
  normaliseIdentity,
  particularsAt,
  templateParticulars,
  upgradeLegacyParticulars,
  validateParticulars,
} from '../src/domain/resolution/particulars';
import type { DatedValue } from '../src/domain/resolution/model';

const dated = (value: string | null, effectiveDate: string, recordedAt = '2026-01-01T00:00:00Z') =>
  ({ value, effectiveDate, recordedAt, actorId: 'test', reason: 'Fictional' }) as DatedValue;

describe('maskIdentity', () => {
  it('masks a MyKad after the date of birth, with or without dashes', () => {
    expect(maskIdentity('880516145888')).toBe('880516-**-****');
    expect(maskIdentity('880516-14-5888')).toBe('880516-**-****');
  });
  it('keeps two characters at each end of other numbers', () => {
    expect(maskIdentity('A12345678')).toBe('A1*****78');
    expect(maskIdentity('8805161458')).toBe('88******58');
    expect(maskIdentity('AB12')).toBe('****');
  });
});

describe('particularsAt', () => {
  it('returns the value in force on the date and skips empty values', () => {
    const person = {
      particulars: {
        occupation: [dated('ENGINEER', '2020-01-01'), dated('DIRECTOR', '2025-06-01')],
        race: [dated('MALAY', '2020-01-01'), dated(null, '2024-01-01')],
        gender: [dated('  ', '2020-01-01')],
      },
    };
    expect(particularsAt(person, '2024-12-31')).toEqual({ occupation: 'ENGINEER' });
    expect(particularsAt(person, '2025-06-01')).toEqual({ occupation: 'DIRECTOR' });
    expect(particularsAt(person, '2019-01-01')).toEqual({});
    expect(particularsAt({}, '2026-01-01')).toEqual({});
  });
});

const ADDRESS = {
  residentialLine1: '3 Jalan Contoh',
  residentialLine2: 'Taman Rekaan',
  residentialPostcode: '47000',
  residentialTown: 'Sungai Buloh',
  residentialState: 'SELANGOR',
  residentialCountry: 'MALAYSIA',
};

describe('addresses', () => {
  it('joins an address on one line and follows "same as residential"', () => {
    expect(formatAddress(addressOf(ADDRESS, 'residential'))).toBe(
      '3 Jalan Contoh, Taman Rekaan, 47000 Sungai Buloh, SELANGOR, MALAYSIA',
    );
    expect(addressOf({ ...ADDRESS, serviceSameAsResidential: 'Yes' }, 'service').Town).toBe(
      'Sungai Buloh',
    );
    expect(addressOf(ADDRESS, 'service').Town).toBe('');
  });
  it('gives templates joined addresses', () => {
    const person = {
      particulars: Object.fromEntries(
        Object.entries({ ...ADDRESS, serviceSameAsResidential: 'Yes' }).map(([k, v]) => [
          k,
          [dated(v, '2020-01-01')],
        ]),
      ),
    };
    const out = templateParticulars(person, '2026-01-01');
    expect(out.residentialAddress).toBe(out.serviceAddress);
    expect(out.businessAddress).toBeUndefined();
  });
});

describe('validateParticulars', () => {
  const errors = (values: Parameters<typeof validateParticulars>[0], kind?: 'organisation') =>
    validateParticulars(values, kind)
      .filter((i) => i.severity === 'error')
      .map((i) => i.key);
  it('accepts a complete fictional MyKad record in mTool wording', () => {
    expect(
      validateParticulars({
        title: "DATO'",
        identityType: 'MyKad',
        identityNumber: '880516145888',
        dateOfBirth: '1988-05-16',
        gender: 'Male',
        race: 'CHINESE',
        nationality: 'MALAYSIA',
        analysis: 'Citizens who are non-Malays and non-natives',
        serviceEmail: 'someone@example.invalid',
        secretaryBody: 'Malaysian Association of Company Secretaries (MACS)',
        ...ADDRESS,
      }),
    ).toEqual([]);
  });
  it('checks 12-digit numbers and the MyKad date', () => {
    expect(errors({ identityType: 'MyKad', identityNumber: '8805161458' })).toEqual([
      'identityNumber',
    ]);
    expect(errors({ identityType: 'MyKad', identityNumber: '881332-14-5888' })).toEqual([
      'identityNumber',
    ]);
    expect(errors({ identityType: 'MyPR', identityNumber: '881332-14-5888' })).toEqual([]);
    expect(errors({ identityType: 'Passport number', identityNumber: 'A1234567' })).toEqual([]);
    expect(errors({ identityNumber: 'A1234567' })).toEqual(['identityType']);
    expect(normaliseIdentity('MyKad', '880516-14 5888')).toBe('880516145888');
    expect(normaliseIdentity('Passport number', ' A12-3 ')).toBe('A12-3');
  });
  it('warns, without blocking, when the MyKad and date of birth disagree', () => {
    const issues = validateParticulars({
      identityType: 'MyKad',
      identityNumber: '880516145888',
      dateOfBirth: '1988-05-17',
    });
    expect(issues).toEqual([expect.objectContaining({ key: 'dateOfBirth', severity: 'warning' })]);
    expect(
      validateParticulars({
        identityType: 'MyKad',
        identityNumber: '050101101234',
        dateOfBirth: '2005-01-01',
      }),
    ).toEqual([]);
  });
  it('allows a passport expiry only for a passport', () => {
    expect(errors({ identityType: 'MyKad', passportExpiry: '2030-01-01' })).toEqual([
      'passportExpiry',
    ]);
    expect(errors({ identityType: 'Passport number', passportExpiry: '2030-01-01' })).toEqual([]);
  });
  it('checks dates, email and mTool lists', () => {
    expect(
      errors({
        identityType: 'Passport number',
        passportExpiry: '2030-02-30',
        dateOfBirth: '16/05/1988',
        serviceEmail: 'not an email',
        gender: 'MALE',
        race: 'MARTIAN',
        nationality: 'ATLANTIS',
        secretaryBody: 'Unknown body',
      }).sort(),
    ).toEqual(
      [
        'dateOfBirth',
        'gender',
        'nationality',
        'passportExpiry',
        'race',
        'secretaryBody',
        'serviceEmail',
      ].sort(),
    );
    expect(errors({ identityType: 'NRIC' })).toEqual(['identityType']);
  });
  it('requires line 1 and country, and postcode, town and state in Malaysia', () => {
    expect(errors({ residentialTown: 'Ipoh' }).sort()).toEqual(
      ['residentialCountry', 'residentialLine1'].sort(),
    );
    expect(
      errors({
        residentialLine1: '1 Road',
        residentialCountry: 'MALAYSIA',
        residentialPostcode: '4700',
      }).sort(),
    ).toEqual(['residentialPostcode', 'residentialState', 'residentialTown'].sort());
    expect(errors({ residentialLine1: '1 Road', residentialCountry: 'SINGAPORE' })).toEqual([]);
    // A service address that follows the residential one is not checked twice.
    expect(errors({ serviceSameAsResidential: 'Yes', serviceTown: 'Left over' })).toEqual([]);
  });
  it('uses organisation lists for an organisation', () => {
    expect(
      errors(
        {
          identityType: 'Company Registration No.',
          identityNumber: '201901000001',
          placeOfIncorporation: 'MALAYSIA',
          analysis: 'Bodies corporate controlled by non-citizens',
        },
        'organisation',
      ),
    ).toEqual([]);
    expect(errors({ identityType: 'MyKad' }, 'organisation')).toEqual(['identityType']);
    expect(errors({ analysis: 'Non-citizens' }, 'organisation')).toEqual(['analysis']);
  });
});

describe('upgradeLegacyParticulars', () => {
  it('converts the first director-forms shape and leaves new data alone', () => {
    const old = {
      identityType: [dated('NRIC', '2020-01-01')],
      identityNumber: [dated('880516-14-5888', '2020-01-01')],
      gender: [dated('FEMALE', '2020-01-01')],
      residentialAddress: [
        dated('3 Jalan Contoh\nTaman Rekaan\n47000 Sungai Buloh\nSelangor', '2020-01-01'),
      ],
      occupation: [dated('ENGINEER', '2020-01-01')],
    };
    const next = upgradeLegacyParticulars(old)!;
    expect(particularsAt({ particulars: next }, '2026-01-01')).toEqual({
      identityType: 'MyKad',
      identityNumber: '880516145888',
      gender: 'Female',
      residentialLine1: '3 Jalan Contoh',
      residentialLine2: 'Taman Rekaan',
      residentialLine3: '47000 Sungai Buloh, Selangor',
      occupation: 'ENGINEER',
    });
    expect(upgradeLegacyParticulars(next)).toBeNull();
  });
});
