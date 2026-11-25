import { describe, expect, it } from 'vitest';
import {
  ADDRESS_PARTS,
  addressProblems,
  emptyAddress,
  formatAddress,
  isAddressComplete,
  isAddressEmpty,
  joinAddress,
  requiredAddressParts,
  type Address,
} from '../src/domain/address';
import * as company from '../src/domain/ar1/company';
import * as particulars from '../src/domain/resolution/particulars';
import { ADDRESS_PARTS as MODEL_PARTS } from '../src/domain/resolution/model';
import type { DatedValue } from '../src/domain/resolution/model';
import {
  buildContext,
  buildSectionA,
  buildSectionD,
  type BuildInput,
} from '../src/domain/ar1/build';
import { emptyAnswers } from '../src/domain/ar1/returns';

const kl: Address = {
  Line1: '1 Jalan Contoh',
  Line2: 'Taman Rekaan',
  Line3: '',
  Postcode: '50450',
  Town: 'Kuala Lumpur',
  State: 'W.P. KUALA LUMPUR',
  Country: 'MALAYSIA',
};
const abroad: Address = { ...emptyAddress(), Line1: '1 Orchard Road', Country: 'SINGAPORE' };

describe('one address model', () => {
  it('is the same parts and functions everywhere', () => {
    expect(MODEL_PARTS).toBe(ADDRESS_PARTS);
    expect(company.PARTS).toBe(ADDRESS_PARTS);
    expect(company.addressProblems).toBe(addressProblems);
    expect(company.joinAddress).toBe(formatAddress);
    expect(company.addressEmpty).toBe(isAddressEmpty);
    expect(particulars.formatAddress).toBe(formatAddress);
    expect(particulars.isAddressEmpty).toBe(isAddressEmpty);
    expect(joinAddress).toBe(formatAddress);
  });
  it('joins an address on one line', () => {
    expect(formatAddress(kl)).toBe(
      '1 Jalan Contoh, Taman Rekaan, 50450 Kuala Lumpur, W.P. KUALA LUMPUR, MALAYSIA',
    );
    expect(formatAddress(abroad)).toBe('1 Orchard Road, SINGAPORE');
    expect(formatAddress(emptyAddress())).toBe('');
  });
  it('keeps the joined template particulars on one line', () => {
    const dated = (value: string) =>
      ({
        value,
        effectiveDate: '2000-01-01',
        recordedAt: '2026-01-01',
        actorId: 't',
        reason: 'x',
      }) as DatedValue;
    const person = {
      particulars: Object.fromEntries(
        ADDRESS_PARTS.filter((p) => kl[p]).map((p) => [`residential${p}`, [dated(kl[p])]]),
      ),
    };
    expect(particulars.templateParticulars(person, '2026-01-01').residentialAddress).toBe(
      formatAddress(kl),
    );
  });
});

describe('requiredAddressParts', () => {
  it.each([
    ['MALAYSIA', ['Line1', 'Country', 'Postcode', 'Town', 'State']],
    ['SINGAPORE', ['Line1', 'Country']],
    ['', ['Line1', 'Country']],
  ])('%s', (Country, parts) => {
    expect(requiredAddressParts({ Country })).toEqual(parts);
  });
});

describe('addressProblems', () => {
  it.each([
    ['a complete Malaysian address', kl, []],
    ['a complete foreign address', abroad, []],
    ['an empty address (callers decide if it is needed)', emptyAddress(), []],
    ['no line 1', { ...kl, Line1: '' }, [['Line1', 'Enter line 1.']]],
    ['no country', { ...abroad, Country: '' }, [['Country', 'Choose the country.']]],
    [
      'a country not on the list',
      { ...abroad, Country: 'ATLANTIS' },
      [['Country', 'Choose one of the listed countries.']],
    ],
    [
      'a four-digit postcode',
      { ...kl, Postcode: '5045' },
      [['Postcode', 'Enter a five-digit postcode.']],
    ],
    [
      'no town or state in Malaysia',
      { ...kl, Town: '', State: '' },
      [
        ['Town', 'Enter the town.'],
        ['State', 'Choose the state.'],
      ],
    ],
    [
      'a state not on the list',
      { ...kl, State: 'KL' },
      [['State', 'Choose one of the listed states.']],
    ],
  ] as const)('%s', (_label, address, expected) => {
    expect(addressProblems(address).map((p) => [p.part, p.message])).toEqual(expected);
    expect(isAddressComplete(address)).toBe(!isAddressEmpty(address) && expected.length === 0);
  });
  it('names the address and can leave the list checks to the caller', () => {
    expect(
      addressProblems({ ...kl, Line1: '', Country: 'ATLANTIS' }, { label: 'residential address' }),
    ).toEqual([
      { part: 'Line1', message: 'Enter line 1 of the residential address.' },
      { part: 'Country', message: 'Choose one of the listed countries.' },
    ]);
    expect(
      addressProblems({ ...kl, Country: 'ATLANTIS', State: 'KL' }, { checkLists: false }),
    ).toEqual([]);
  });
  it('keeps the person messages and checks listed values once', () => {
    const issues = particulars.validateParticulars({
      residentialLine1: '',
      residentialTown: 'Kuala Lumpur',
      residentialCountry: 'MALAYSIA',
      businessLine1: '1 Jalan',
      businessCountry: 'ATLANTIS',
    });
    expect(issues.map((i) => [i.key, i.message])).toEqual([
      ['businessCountry', 'Choose one of the listed options.'],
      ['residentialLine1', 'Enter line 1 of the residential address.'],
      ['residentialPostcode', 'Enter a five-digit postcode.'],
      ['residentialState', 'Choose the state of the residential address.'],
    ]);
  });
});

describe('addresses on the return', () => {
  const dated = (value: string) =>
    ({
      value,
      effectiveDate: '2000-01-01',
      recordedAt: '2026-01-01',
      actorId: 't',
      reason: 'x',
    }) as DatedValue;
  const at = (prefix: string, a: Address) =>
    Object.fromEntries(
      ADDRESS_PARTS.filter((p) => a[p]).map((p) => [`${prefix}${p}`, [dated(a[p])]]),
    );
  const input = (principal: Address, residential: Address): BuildInput => ({
    company: { id: 'c1', name: 'Test Sdn Bhd', registrationNumber: '202401012345' } as never,
    profile: {
      companyId: 'c1',
      revision: 1,
      citations: {},
      customValues: {},
      particulars: {
        ...at('registered', kl),
        membersRegisterAtRegistered: [dated('Yes')],
        financialRecordsAtRegistered: [dated('Yes')],
        ...at('principal', principal),
        msic1: [dated('62010')],
      },
    },
    record: {
      calendarYear: 2025,
      returnDate: '2025-11-01',
      firstReturn: true,
      lastReturnDate: null,
      application: 'Ordinary filing',
      rectificationDeclaration: '',
      courtOrderReference: '',
      answers: emptyAnswers(),
    },
    people: new Map([
      [
        'p',
        {
          id: 'p',
          fullName: 'Person p (fictional)',
          particulars: {
            identityType: [dated('MyKad')],
            identityNumber: [dated('880516145888')],
            nationality: [dated('MALAYSIA')],
            race: [dated('MALAY')],
            gender: [dated('Male')],
            dateOfBirth: [dated('1988-05-16')],
            occupation: [dated('DIRECTOR')],
            serviceSameAsResidential: [dated('Yes')],
            ...at('residential', residential),
          },
        } as never,
      ],
    ]),
    relationships: [
      {
        id: 'r',
        companyId: 'c1',
        personId: 'p',
        role: 'director',
        startDate: null,
        endDate: null,
        appointment: { designation: 'Director', alternateTo: null, nominee: false },
      } as never,
    ],
    otherDirectorships: new Map(),
    entries: [],
    charges: [],
  });
  it('writes the seven mTool columns', () => {
    const { data } = buildSectionA(buildContext(input(kl, kl)));
    expect(data.principal).toEqual([
      '1 Jalan Contoh',
      'Taman Rekaan',
      '',
      '50450',
      'Kuala Lumpur',
      'W.P. KUALA LUMPUR',
      'MALAYSIA',
    ]);
  });
  it.each([
    ['complete', kl, []],
    ['abroad', abroad, []],
    [
      'a country mTool does not list',
      { ...abroad, Country: 'ATLANTIS' },
      ['Complete the principal place of business.'],
    ],
    [
      'a state mTool does not list',
      { ...kl, State: 'KL' },
      ['Complete the principal place of business.'],
    ],
    ['empty', emptyAddress(), ['Complete the principal place of business.']],
  ] as const)('checks the principal place of business: %s', (_label, address, messages) => {
    expect(buildSectionA(buildContext(input(address, kl))).issues.map((i) => i.message)).toEqual(
      messages,
    );
  });
  it('checks a director’s addresses against the lists too', () => {
    const issues = buildSectionD(buildContext(input(kl, { ...kl, State: 'KL' }))).issues;
    expect(issues[0].target).toEqual({
      kind: 'person',
      id: 'p',
      keys: ['residentialLine1', 'serviceLine1'],
      roles: ['director'],
    });
  });
});
