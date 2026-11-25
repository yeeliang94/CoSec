import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryBytes, readPackage, readText } from '../src/server/ar1/zip';
import { sheetParts } from '../src/server/ar1/sheet';
import { fillWorkbook, readBack } from '../src/server/ar1/fill';
import { compareFilingInfo, readFilingInfo } from '../src/server/ar1/filing-info';
import type { AddressCells, Ar1Data } from '../src/domain/ar1/build';

const blank = readFileSync('tests/fixtures/ar1/blank-first-return.xlsx');
const kl: AddressCells = [
  '1 Jalan Contoh',
  'Taman Rekaan',
  '',
  '50450',
  'Kuala Lumpur',
  'W.P. KUALA LUMPUR',
  'MALAYSIA',
];
const kinds = (ordinary: string) => ({ Ordinary: ordinary, Preference: '', Other: '' });
const identity = (name: string, id: string) => ({
  title: '',
  name,
  idType: 'MyKad',
  idNumber: id,
  passportExpiry: '',
  nationality: 'MALAYSIA',
  race: 'CHINESE',
  gender: 'Female',
  dateOfBirth: '16/05/1988',
});

export const sample: Ar1Data = {
  filingInfo: {
    newRegistrationNumber: '012345678910',
    oldRegistrationNumber: '',
    name: 'TEST SDN BHD',
    formerName: '',
    gstNumber: '',
    calendarYear: '2025',
    dateOfReturn: '01/11/2025',
    origin: 'Incorporated in Malaysia',
    status: 'Private company',
    companyType: 'Company limited by shares',
    application: 'Ordinary filing',
    rectificationDeclaration: '',
    courtOrderReference: '',
    submissionType: 'AR1',
    firstReturn: 'Yes',
    sharesQuoted: '',
    numberOfMembers: 'Company with equal to or less than five hundred members',
  },
  a: {
    registered: kl,
    membersRegister: kl,
    financialRecords: kl,
    principal: kl,
    phone: '03-0000 0000',
    fax: '',
    email: 'office@example.invalid',
    website: '',
    natureOfBusiness: 'Software development (fictional)',
    msic: [{ code: '62010', description: 'COMPUTER PROGRAMMING ACTIVITIES' }],
    branches: [
      { address: kl, phone: '', fax: '', email: '', website: '' },
      { address: kl, phone: '04-000 0000', fax: '', email: '', website: '' },
    ],
  },
  b: {
    cash: kinds('100000'),
    otherwise: kinds('10000'),
    forfeited: kinds(''),
    treasury: kinds(''),
    fullyPaid: kinds('110000.00'),
    partlyPaid: kinds('0.00'),
    calledUp: kinds(''),
    callsReceived: kinds(''),
    consideredPaidFullyPaid: kinds('10000.00'),
    consideredPaidPartlyPaid: kinds(''),
    callsUnpaid: kinds(''),
    paidOnForfeited: kinds(''),
    commission: '',
    discount: '',
    notesOnShares: 'Fictional note',
    notesOnDebentures: '',
  },
  c: {
    charges: [
      {
        registeredNumber: 'CC0001',
        registeredOn: '14/09/2021',
        registeredIso: '2021-09-14',
        nature: 'Fixed charge',
        chargee: 'FICTIONAL BANK BERHAD',
        amount: '1500000.00',
      },
      {
        registeredNumber: 'CC0002',
        registeredOn: '01/01/2022',
        registeredIso: '2022-01-01',
        nature: 'Floating charge',
        chargee: 'FICTIONAL BANK BERHAD',
        amount: '250000.50',
      },
    ],
    notes: '',
  },
  d: {
    directors: [1, 2, 3].map((n) => ({
      ...identity(`DIRECTOR ${n} (FICTIONAL)`, `88051614588${n}`),
      personId: `director-${n}`,
      designation: 'Director',
      alternateTo: '',
      residential: kl,
      service: kl,
      email: '',
      occupation: 'COMPANY DIRECTOR',
      otherDirectorships: n === 1 ? '[202001000001] OTHER SDN. BHD.' : '',
    })),
    managers: [],
    secretaries: [
      {
        ...identity('SECRETARY (FICTIONAL)', '850505100000'),
        personId: 'secretary',
        residential: kl,
        business: kl,
        occupation: '',
        professionalType:
          'Malaysian Institute of Chartered Secretaries and Administrators (MAICSA)',
        licenceNumber: 'MAICSA 0000000',
        practisingCertificate: '202000000000',
      },
    ],
    auditors: [{ personId: 'auditor', firmNumber: 'AF0001', name: 'FICTIONAL & CO', address: kl }],
  },
  e: {
    members: [
      {
        reference: '0001',
        memberType: 'Individual',
        trusteeType: '',
        ...identity('MEMBER ONE', '880516145881'),
        partyIds: ['member-1'],
        address: kl,
        shares: '60000',
        typesOfShares: 'Ordinary shares',
        analysis: 'Citizens who are non-Malays and non-natives',
      },
      {
        reference: '0002',
        memberType: 'Individual',
        trusteeType: '',
        ...identity('MEMBER TWO', '880516145882'),
        race: 'MALAY',
        partyIds: ['member-2'],
        address: kl,
        shares: '40000',
        typesOfShares: 'Ordinary shares',
        analysis: 'Citizens who are Malays and natives',
      },
      {
        reference: '0003',
        memberType: 'Joint holders (Individual or Body Corporate)',
        trusteeType: '',
        title: '',
        name: 'A & B',
        idType: '',
        idNumber: '',
        passportExpiry: '',
        nationality: '',
        race: '',
        gender: '',
        dateOfBirth: '',
        address: ['', '', '', '', '', '', ''],
        partyIds: ['joint-a', 'joint-b'],
        shares: '10000',
        typesOfShares: 'Ordinary shares',
        analysis: 'Citizens who are Malays and natives',
      },
    ],
    subclassification: [
      {
        reference: '0003',
        type: 'Individual',
        ...identity('A', '900101140001'),
        partyIds: ['joint-a'],
        address: kl,
      },
      {
        reference: '0003',
        type: 'Individual',
        ...identity('B', '900101140002'),
        partyIds: ['joint-b'],
        address: kl,
      },
    ],
  },
  f: { byAnalysis: {}, unclassified: '0', total: '110000' },
  g: {
    unclaimedMoneys: 'Yes',
    transfersRegistered: 'No',
    noPublicInvitation: 'Yes',
    overFifty: 'Yes',
    overFiveHundred: '',
    boStatus: 'Company has beneficial owner(s)',
    boExemptCategory: '',
    nomineeStatus: 'None of the director(s) of the company is a nominee director',
  },
};

describe('filling a blank AR1 workbook', () => {
  it('writes every value, and every value reads back', () => {
    const { bytes, written, rowsAdded } = fillWorkbook(blank, sample);
    // 1 branch, 1 charge in each C table, 2 directors, 2 members and 1 sub-classification added.
    expect(rowsAdded).toBe(1 + 1 + 1 + 2 + 2 + 1);
    expect(written.length).toBeGreaterThan(150);
    expect(readBack(bytes, written)).toEqual([]);
    const at = (sheet: string, cell: string) =>
      written.find((w) => w.sheet === sheet && w.cell === cell)?.value;
    expect(at('SectionA', 'E12')).toBe('1 Jalan Contoh');
    expect(at('SectionA', 'E18')).toBe('MALAYSIA');
    expect(at('SectionD', 'F14')).toBe('DIRECTOR 3 (FICTIONAL)');
    expect(at('SectionE_ii', 'X14')).toBe('10000');
    expect(at('SectionG', 'E12')).toBe('No'); // (b) since incorporation, on a first return
  });

  it('keeps section F reading the grown member rows and leaves other parts untouched', () => {
    const { bytes } = fillWorkbook(blank, sample);
    const out = readPackage(bytes);
    const original = readPackage(blank);
    const f = readText(out, sheetParts(out).get('SectionF')!);
    expect(f).toContain('SectionE_ii!Z12:Z15');
    expect(out.entries.some((e) => e.name === 'xl/calcChain.xml')).toBe(false);
    const changed = new Set(
      [...sheetParts(out).entries()]
        .filter(([name]) => /^Section|^FilingInfo/.test(name))
        .map(([, path]) => path)
        .concat(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']),
    );
    for (const entry of original.entries) {
      if (changed.has(entry.name) || entry.name === 'xl/calcChain.xml') continue;
      const copy = out.entries.find((e) => e.name === entry.name)!;
      expect(copy.raw.equals(entry.raw), entry.name).toBe(true);
    }
    // FilingInfo itself is never written.
    expect(
      entryBytes(out.entries.find((e) => e.name === sheetParts(out).get('FilingInfo'))!).equals(
        entryBytes(
          original.entries.find((e) => e.name === sheetParts(original).get('FilingInfo'))!,
        ),
      ),
    ).toBe(true);
  });
});

describe('the uploaded blank', () => {
  it('reads FilingInfo and compares it with the return', () => {
    const info = readFilingInfo(blank);
    expect(info.E11).toBe('012345678910');
    // mTool keeps the name as typed, so case does not count.
    expect(compareFilingInfo(sample.filingInfo, info)).toEqual([]);
    const other = compareFilingInfo({ ...sample.filingInfo, dateOfReturn: '02/11/2025' }, info);
    expect(other).toEqual([
      { field: 'dateOfReturn', expected: '02/11/2025', actual: '01/11/2025' },
    ]);
  });
  it('refuses a file that is not an mTool AR1 workbook', () => {
    expect(() => readFilingInfo(Buffer.from('not a workbook'))).toThrow('not an Excel workbook');
  });
});
