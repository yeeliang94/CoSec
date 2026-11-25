import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPackage, readText } from '../src/server/ar1/zip';
import { cells, cellText, sharedStrings, sheetParts } from '../src/server/ar1/sheet';
import { fillWorkbook, readBack } from '../src/server/ar1/fill';
import type { AddressCells, Ar1Data } from '../src/domain/ar1/build';

const blank = readFileSync('tests/fixtures/ar1/blank-first-return.xlsx');
const kl: AddressCells = [
  '1 Jalan Contoh',
  '',
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

/** A return the size of the largest AR1 the template takes: 500 members. */
function largeReturn(members: number): Ar1Data {
  const b0 = kinds('');
  return {
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
      phone: '',
      fax: '',
      email: '',
      website: '',
      natureOfBusiness: 'Software (fictional)',
      msic: [{ code: '62010', description: 'COMPUTER PROGRAMMING ACTIVITIES' }],
      branches: [],
    },
    b: {
      cash: kinds(String(members * 100)),
      otherwise: b0,
      forfeited: b0,
      treasury: b0,
      fullyPaid: kinds(`${members * 100}.00`),
      partlyPaid: b0,
      calledUp: b0,
      callsReceived: b0,
      consideredPaidFullyPaid: b0,
      consideredPaidPartlyPaid: b0,
      callsUnpaid: b0,
      paidOnForfeited: b0,
      commission: '',
      discount: '',
      notesOnShares: '',
      notesOnDebentures: '',
    },
    c: { charges: [], notes: '' },
    d: {
      directors: [
        {
          ...identity('DIRECTOR (FICTIONAL)', '880516145881'),
          personId: 'director',
          designation: 'Director',
          alternateTo: '',
          residential: kl,
          service: kl,
          email: '',
          occupation: 'COMPANY DIRECTOR',
          otherDirectorships: '',
        },
      ],
      managers: [],
      secretaries: [],
      auditors: [],
    },
    e: {
      members: Array.from({ length: members }, (_, i) => ({
        reference: String(i + 1).padStart(4, '0'),
        memberType: 'Individual',
        trusteeType: '',
        ...identity(`MEMBER ${i + 1} (FICTIONAL)`, String(880516140000 + i)),
        partyIds: [`member-${i}`],
        address: kl,
        shares: '100',
        typesOfShares: 'Ordinary shares',
        analysis: 'Citizens who are non-Malays and non-natives',
      })),
      subclassification: [],
    },
    f: { byAnalysis: {}, unclassified: '0', total: String(members * 100) },
    g: {
      unclaimedMoneys: 'Yes',
      transfersRegistered: 'No',
      noPublicInvitation: 'Yes',
      overFifty: 'Yes',
      overFiveHundred: '',
      boStatus: 'Company has beneficial owner(s)',
      boExemptCategory: '',
      nomineeStatus: '',
    },
  };
}

describe('filling a large return', () => {
  it('fills 500 members (499 rows added) quickly, and every value reads back', () => {
    const data = largeReturn(500);
    const started = performance.now();
    const { bytes, written, rowsAdded } = fillWorkbook(blank, data);
    const elapsed = performance.now() - started;
    expect(rowsAdded).toBe(499);
    // 16 cells per member (empty address lines are not written).
    expect(written.length).toBeGreaterThan(500 * 16);
    expect(elapsed).toBeLessThan(2000);
    expect(readBack(bytes, written)).toEqual([]);

    const pkg = readPackage(bytes);
    const strings = sharedStrings(pkg);
    const e = new Map(
      cells(readText(pkg, sheetParts(pkg).get('SectionE_ii')!)).map((c) => [
        c.ref,
        cellText(c, strings),
      ]),
    );
    expect(e.get('I12')).toBe('MEMBER 1 (FICTIONAL)');
    expect(e.get('I511')).toBe('MEMBER 500 (FICTIONAL)');
    expect(e.get('D511')).toBe('0500');
    expect(e.get('X511')).toBe('100');
    const f = readText(pkg, sheetParts(pkg).get('SectionF')!);
    // The template's range covers the member row and the row below it, as in ar1-fill.test.ts.
    expect(f).toContain('SectionE_ii!Z12:Z512');
  });
});
