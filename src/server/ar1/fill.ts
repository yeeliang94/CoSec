import { readPackage, readText, setText, writePackage, type ZipPackage } from './zip';
import {
  cells,
  cellText,
  cleanText,
  colName,
  colNumber,
  sharedStrings,
  sheetParts,
  writeCells,
  type Cell,
  type CellValue,
} from './sheet';
import { addRows, dropCalcChain, type RowsRequest } from './rows';
import { assertSafeWorkbook, NotAnAr1Workbook } from './filing-info';
import type { AddressCells, Ar1Data } from '../../domain/ar1/build';
import { SHARE_KINDS } from '../../domain/ar1/shares';

export type Written = { sheet: string; cell: string; value: string };

type Table = {
  sheet: string;
  /** The template's only member row, numbered as in the blank. */
  row: number;
  /**
   * The blank's member row has no 4-digit id, so it is copied as it is (see `RowsRequest.idless`)
   * and the fill writes each row's No. itself. Only Section C's second table (date, nature and
   * chargee) is like this.
   */
  idless?: boolean;
  /**
   * The row of the table's closing `#TABLE#` marker in column C of a blank. A row added in mTool
   * moves it down, along with every table below it on the sheet.
   */
  end: number;
};
const TABLES = {
  membersRegister: { sheet: 'SectionA', row: 29, end: 30 },
  financialRecords: { sheet: 'SectionA', row: 40, end: 41 },
  principal: { sheet: 'SectionA', row: 51, end: 52 },
  branches: { sheet: 'SectionA', row: 86, end: 87 },
  charges: { sheet: 'SectionC', row: 13, end: 14 },
  chargeDetails: { sheet: 'SectionC', row: 24, idless: true, end: 25 },
  directors: { sheet: 'SectionD', row: 12, end: 13 },
  managers: { sheet: 'SectionD', row: 24, end: 25 },
  secretaries: { sheet: 'SectionD', row: 36, end: 37 },
  auditors: { sheet: 'SectionD', row: 48, end: 49 },
  // The table's total row sits between its member row and the marker.
  members: { sheet: 'SectionE_ii', row: 12, end: 14 },
  subclassification: { sheet: 'SectionE_ii', row: 25, end: 26 },
} satisfies Record<string, Table>;
type TableKey = keyof typeof TABLES;

const EXPANDED =
  'This workbook already has rows added in mTool. Make a fresh blank in mTool and upload it without adding rows.';

/**
 * Refuses a workbook whose tables are not as a blank has them: every position this fill writes
 * to is counted from the blank's layout, so rows already added in mTool would put values in the
 * wrong rows. Each table is checked by where its closing marker is.
 */
export function assertBlankTables(pkg: ZipPackage) {
  const strings = sharedStrings(pkg);
  const paths = sheetParts(pkg);
  const bySheet = new Map<string, Cell[]>();
  for (const table of Object.values(TABLES) as Table[]) {
    const path = paths.get(table.sheet);
    if (!path) throw new NotAnAr1Workbook(`The workbook has no ${table.sheet} sheet.`);
    if (!bySheet.has(table.sheet)) bySheet.set(table.sheet, cells(readText(pkg, path)));
    const marker = bySheet
      .get(table.sheet)!
      .filter((c) => c.col === 'C' && c.row > table.row && cellText(c, strings) === '#TABLE#')
      .reduce((least, c) => Math.min(least, c.row), Infinity);
    if (marker !== table.end) throw new NotAnAr1Workbook(EXPANDED);
  }
}

/**
 * Single cells outside the tables, as numbered in the blank (rows added above them move them
 * down). Each names the mTool element in column A, or the label in column D where A is empty.
 */
const SECTION_A = {
  /**
   * The registered office: a column of single cells E12 to E18 (ssmt_AddressOne, AddressTwo,
   * AddressThree, Postcode, Town, State, Country), not a table row.
   */
  registeredFirstRow: 12,
  /** E62, label "Nature of business". */
  natureOfBusiness: 62,
  /** Rows 73 to 75, labels "Business 1" to "Business 3": MSIC code in E, description in F. */
  msicFirstRow: 73,
} as const;
/** Section B rows; each row has a column per kind of share (KIND_COLUMN). */
const SECTION_B_ROWS = {
  cash: 23, // ssmt_NumberOfSharesSubjectToPaymentsWhollyInCash
  otherwise: 24, // ssmt_NumberOfSharesSubjectToPaymentOtherwiseThanCash
  forfeited: 27, // ssmt_NumberOfSharesForfeited
  treasury: 28, // ssmt_NumberOfSharesHeldAsTreasuryShares
  fullyPaid: 40, // ssmt_AmountOfSharesIssuedAsFullyPaid
  partlyPaid: 41, // ssmt_AmountOfSharesIssuedAsPartlyUnpaid
  calledUp: 44, // ssmt_AmountOfSharesCalledUp
  callsReceived: 45, // ssmt_AmountOfCallsReceivedIncludingPaymentsOnApplicationAndAllotment
  consideredPaidFullyPaid: 46, // ssmt_AmountAgreedToBeConsideredAsPaidOn…IssuedAsFullyPaidUpOtherwiseThanInCash
  consideredPaidPartlyPaid: 47, // ssmt_AmountAgreedToBeConsideredAsPaidOn…IssuedAsPartlyPaidUpOtherwiseThanInCash
  callsUnpaid: 48, // ssmt_AmountOfCallsUnpaid
  paidOnForfeited: 49, // ssmt_AmountPaidOnSharesForfeited
} as const;
const SECTION_B_CELLS = {
  currency: 'E11', // label "*Type of currency of amount of shares"
  commission: 'E60', // ssmt_AmountPaidByWayOfCommissionInRespectOfAnySharesOrDebenturesSinceTheDateOfLastReturn
  discount: 'E61', // ssmt_AmountAllowedByWayOfDiscountInRespectOfAnyDebenturesSinceTheDateOfLastReturn
} as const;
/** Section G's certificate, column E, found by the mTool element (prefix ssmt_CertifyThat) in A. */
const CERTIFICATE = {
  unclaimedMoneys: 'ProvisionsOfUnclaimedMoneysActHaveBeenCompliedWith',
  transfersSinceIncorporation:
    'InspectionIsMadeOfShareRegisterAndTransfersHaveBeenRegisteredSinceIncorporationOfcompany',
  transfersSinceLastReturn:
    'InspectionIsMadeOfShareRegisterAndTransfersHaveBeenRegisteredSinceDateOfLastAnnualReturn',
  noInvitationSinceIncorporation:
    'CompanyHasNotSinceDateOfIncorporationOfCompanyIssuedAnyInvitationToPublicToSubscribeForAnySharesOrDebenturesOrToDepositMoneysForFixedPeriodsOrPayableAtCall',
  noInvitationSinceLastReturn:
    'CompanyHasNotSinceDateOfLastAnnualReturnIssuedAnyInvitationToPublicToSubscribeForAnySharesInOrDebenturesOfCompanyOrToDepositMoneysForFixedPeriodsOrPayableAtCall',
  overFifty:
    'ExcessOfMembersOfcompanyAboveFiftyConsistsOnlyOfPersonsWhoAreInemploymentOfCompanyOrOfItsSubsidiaryOrPersonsWhoWhilePreviouslyInemploymentOfcompanyOrOfItsSubsidiaryWereAndThereafterHaveContinuedToBeMembersOfCompany',
  overFiveHundred:
    'CompanyIsPublicCompanyWhichHasMoreThanFiveHundredMembersAndReasonableOpportunitiesAndFacilitiesForPersonToInspectTakeCopiesOfItsListOfMembersItsParticularsOfSharesTransferred',
  boStatus: 'StatusRelatingToBeneficialOwnersOfCompany',
  boExemptCategory: 'CategoryOfCompanyExemptedFromBeneficialOwnerReporting',
  nomineeStatus: 'CompanyHasFollowingStatusRelatingToItsDirector',
} as const;

const KIND_COLUMN = { Ordinary: 'E', Preference: 'F', Other: 'G' } as const;
const text = (t: string): CellValue => ({ kind: 'text', text: t });
const number = (n: string): CellValue => ({ kind: 'number', number: n });

export class FillError extends Error {}

/**
 * Writes an `Ar1Data` into a blank mTool AR1 workbook. Cell positions are
 * read from mTool v2.2's AR1 template (SSMxT_2022v1.0).
 * Rows are added first; every later position is worked out from the rows added above it. Values
 * are collected per sheet and written in one pass over each sheet at the end.
 */
export function fillWorkbook(blank: Buffer, data: Ar1Data) {
  const pkg = readPackage(blank);
  try {
    assertSafeWorkbook(pkg);
    assertBlankTables(pkg);
  } catch (error) {
    if (error instanceof NotAnAr1Workbook) throw new FillError(error.message);
    throw error;
  }
  const counts: Record<TableKey, number> = {
    membersRegister: 1,
    financialRecords: 1,
    principal: 1,
    branches: data.a.branches.length,
    charges: data.c.charges.length,
    chargeDetails: data.c.charges.length,
    directors: data.d.directors.length,
    managers: data.d.managers.length,
    secretaries: data.d.secretaries.length,
    auditors: data.d.auditors.length,
    members: data.e.members.length,
    subclassification: data.e.subclassification.length,
  };
  const requests: RowsRequest[] = (Object.keys(TABLES) as TableKey[])
    .filter((k) => counts[k] > 1)
    .map((k) => ({ ...TABLES[k], add: counts[k] - 1 }));
  const report = addRows(pkg, requests);
  /** Where a row of the blank is now: moved down by every row added above it on its sheet. */
  const shift = (sheet: string, row: number) =>
    row + requests.filter((r) => r.sheet === sheet && r.row < row).reduce((n, r) => n + r.add, 0);
  /** Where a table's first member row is now. */
  const firstRow = (key: TableKey) => shift(TABLES[key].sheet, TABLES[key].row);

  const strings = sharedStrings(pkg);
  const paths = sheetParts(pkg);
  /** Each sheet's text after rows were added; the values are written into it at the end. */
  const sheets = new Map<string, string>();
  const xmlOf = (sheet: string) => {
    if (!sheets.has(sheet)) {
      const path = paths.get(sheet);
      if (!path) throw new FillError(`The workbook has no ${sheet} sheet.`);
      sheets.set(sheet, readText(pkg, path));
    }
    return sheets.get(sheet)!;
  };
  /** Parsed once per sheet, for the label and element lookups. */
  const parsed = new Map<string, Cell[]>();
  const cellsOf = (sheet: string) => {
    if (!parsed.has(sheet)) parsed.set(sheet, cells(xmlOf(sheet)));
    return parsed.get(sheet)!;
  };
  const pending = new Map<string, Map<string, CellValue>>();
  const written: Written[] = [];
  const put = (sheet: string, ref: string, value: CellValue) => {
    // XML cannot hold control characters, so they are removed before the value is recorded as
    // written, and the read-back compares like with like.
    const clean = value.kind === 'text' ? text(cleanText(value.text)) : value;
    const shown = clean.kind === 'text' ? clean.text : String(clean.number);
    if (shown === '') return;
    xmlOf(sheet);
    let values = pending.get(sheet);
    if (!values) pending.set(sheet, (values = new Map()));
    values.set(ref, clean);
    written.push({ sheet, cell: ref, value: shown });
  };
  const putText = (sheet: string, ref: string, t: string) => put(sheet, ref, text(t));
  const putNumber = (sheet: string, ref: string, n: string) => {
    if (n === '') return;
    if (!/^-?\d+(\.\d+)?$/.test(n)) throw new FillError(`${sheet}!${ref}: ${n} is not a number.`);
    put(sheet, ref, number(n));
  };
  const putAddress = (sheet: string, startCol: string, row: number, a: AddressCells) =>
    a.forEach((v, i) => putText(sheet, `${colName(colNumber(startCol) + i)}${row}`, v));
  const putRow = (sheet: string, row: number, values: Record<string, string>) => {
    for (const [col, v] of Object.entries(values)) putText(sheet, `${col}${row}`, v);
  };
  /** A single-value cell in column E, found by its element name in column A. */
  const elementRow = (sheet: string, element: string) => {
    const row = cellsOf(sheet).find(
      (c) => c.col === 'A' && cellText(c, strings).endsWith(`#${element}`),
    )?.row;
    if (row === undefined) throw new FillError(`${sheet} has no ${element}.`);
    return row;
  };
  /** A notes cell in column E, found by its label in column D. */
  const labelRow = (sheet: string, label: string) => {
    const row = cellsOf(sheet).find(
      (c) => c.col === 'D' && cellText(c, strings).trim().startsWith(label),
    )?.row;
    if (!row) throw new FillError(`${sheet} has no "${label}".`);
    return row;
  };

  // ---- Section A
  data.a.registered.forEach((v, i) =>
    putText('SectionA', `E${SECTION_A.registeredFirstRow + i}`, v),
  );
  putAddress('SectionA', 'E', firstRow('membersRegister'), data.a.membersRegister);
  putAddress('SectionA', 'E', firstRow('financialRecords'), data.a.financialRecords);
  const principal = firstRow('principal');
  putAddress('SectionA', 'E', principal, data.a.principal);
  putRow('SectionA', principal, {
    L: data.a.phone,
    M: data.a.fax,
    N: data.a.email,
    O: data.a.website,
  });
  putText('SectionA', `E${shift('SectionA', SECTION_A.natureOfBusiness)}`, data.a.natureOfBusiness);
  data.a.msic.forEach((m, i) => {
    const row = shift('SectionA', SECTION_A.msicFirstRow + i);
    // UNVERIFIED: code in E and description in F, as the column heads read; not set through mTool.
    putText('SectionA', `E${row}`, m.code);
    putText('SectionA', `F${row}`, m.description);
  });
  data.a.branches.forEach((b, i) => {
    const row = firstRow('branches') + i;
    putAddress('SectionA', 'E', row, b.address);
    putRow('SectionA', row, { L: b.phone, M: b.fax, N: b.email, O: b.website });
  });

  // ---- Section B
  putText('SectionB', SECTION_B_CELLS.currency, 'Malaysian Ringgit (MYR)');
  for (const [key, row] of Object.entries(SECTION_B_ROWS) as [
    keyof typeof SECTION_B_ROWS,
    number,
  ][])
    for (const k of SHARE_KINDS) putNumber('SectionB', `${KIND_COLUMN[k]}${row}`, data.b[key][k]);
  putNumber('SectionB', SECTION_B_CELLS.commission, data.b.commission);
  putNumber('SectionB', SECTION_B_CELLS.discount, data.b.discount);
  putText(
    'SectionB',
    `E${labelRow('SectionB', 'Explanatory notes on shares')}`,
    data.b.notesOnShares,
  );
  putText(
    'SectionB',
    `E${labelRow('SectionB', 'Explanatory notes on debentures')}`,
    data.b.notesOnDebentures,
  );

  // ---- Section C
  data.c.charges.forEach((c, i) => {
    const row = firstRow('charges') + i;
    putText('SectionC', `E${row}`, c.registeredNumber);
    putNumber('SectionC', `G${row}`, c.amount);
    const detail = firstRow('chargeDetails') + i;
    // Column D is the Indebtedness count dimension; mTool's Validate refuses a row without it.
    putRow('SectionC', detail, {
      D: String(i + 1).padStart(4, '0'),
      E: c.registeredNumber,
      F: c.registeredOn,
      G: c.nature,
      H: c.chargee,
    });
  });
  if (data.c.notes)
    putText(
      'SectionC',
      `E${labelRow('SectionC', 'Explanatory notes on indebtedness')}`,
      data.c.notes,
    );

  // ---- Section D
  data.d.directors.forEach((d, i) => {
    const row = firstRow('directors') + i;
    putRow('SectionD', row, {
      E: d.title,
      F: d.name,
      G: d.designation,
      H: d.alternateTo,
      I: d.idType,
      J: d.idNumber,
      K: d.passportExpiry,
      L: d.nationality,
      M: d.race,
      N: d.gender,
      O: d.dateOfBirth,
      AD: d.email,
      AE: d.occupation,
      AF: d.otherDirectorships,
    });
    putAddress('SectionD', 'P', row, d.residential);
    putAddress('SectionD', 'W', row, d.service);
  });
  data.d.managers.forEach((m, i) => {
    const row = firstRow('managers') + i;
    putRow('SectionD', row, {
      E: m.title,
      F: m.name,
      G: m.idType,
      H: m.idNumber,
      I: m.passportExpiry,
      J: m.nationality,
      K: m.race,
      L: m.gender,
      M: m.dateOfBirth,
      AB: m.occupation,
    });
    putAddress('SectionD', 'N', row, m.residential);
    putAddress('SectionD', 'U', row, m.business);
  });
  data.d.secretaries.forEach((s, i) => {
    const row = firstRow('secretaries') + i;
    putRow('SectionD', row, {
      E: s.title,
      F: s.name,
      G: s.idType,
      H: s.idNumber,
      I: s.passportExpiry,
      J: s.professionalType,
      K: s.licenceNumber,
      L: s.practisingCertificate,
      M: s.nationality,
      N: s.race,
      O: s.gender,
      P: s.dateOfBirth,
      AE: s.occupation,
    });
    putAddress('SectionD', 'Q', row, s.residential);
    putAddress('SectionD', 'X', row, s.business);
  });
  data.d.auditors.forEach((a, i) => {
    const row = firstRow('auditors') + i;
    putRow('SectionD', row, { E: a.firmNumber, F: a.name });
    putAddress('SectionD', 'G', row, a.address);
  });

  // ---- Section E(ii); section F fills itself from these rows.
  data.e.members.forEach((m, i) => {
    const row = firstRow('members') + i;
    putRow('SectionE_ii', row, {
      F: m.memberType,
      G: m.trusteeType,
      H: m.title,
      I: m.name,
      J: m.idType,
      K: m.idNumber,
      L: m.passportExpiry,
      M: m.nationality,
      N: m.race,
      O: m.gender,
      P: m.dateOfBirth,
      Y: m.typesOfShares,
      Z: m.analysis,
    });
    putAddress('SectionE_ii', 'Q', row, m.address);
    putNumber('SectionE_ii', `X${row}`, m.shares);
  });
  data.e.subclassification.forEach((s, i) => {
    const row = firstRow('subclassification') + i;
    putRow('SectionE_ii', row, {
      // The reference ties the row to its member row; the template's own id column is D.
      E: s.reference,
      F: s.type,
      G: s.title,
      H: s.name,
      I: s.idType,
      J: s.idNumber,
      K: s.passportExpiry,
      L: s.nationality,
      M: s.race,
      N: s.gender,
      O: s.dateOfBirth,
    });
    putAddress('SectionE_ii', 'P', row, s.address);
  });

  // ---- Section G: (b) and (c) use the "since incorporation" or "since the last return" row.
  const first = data.filingInfo.firstReturn === 'Yes';
  const certify = (element: keyof typeof CERTIFICATE, value: string) =>
    putText(
      'SectionG',
      `E${elementRow('SectionG', `ssmt_CertifyThat${CERTIFICATE[element]}`)}`,
      value,
    );
  certify('unclaimedMoneys', data.g.unclaimedMoneys);
  certify(
    first ? 'transfersSinceIncorporation' : 'transfersSinceLastReturn',
    data.g.transfersRegistered,
  );
  certify(
    first ? 'noInvitationSinceIncorporation' : 'noInvitationSinceLastReturn',
    data.g.noPublicInvitation,
  );
  certify('overFifty', data.g.overFifty);
  certify('overFiveHundred', data.g.overFiveHundred);
  certify('boStatus', data.g.boStatus);
  certify('boExemptCategory', data.g.boExemptCategory);
  certify('nomineeStatus', data.g.nomineeStatus);

  for (const [sheet, values] of pending)
    setText(pkg, paths.get(sheet)!, writeCells(xmlOf(sheet), values));
  // Written numbers feed Total formulas whose cached results are now stale.
  dropCalcChain(pkg);
  return {
    bytes: writePackage(pkg),
    written,
    rowsAdded: report.reduce((n, r) => n + r.added, 0),
  };
}

/** Re-opens a filled workbook and returns every written value that does not read back. */
export function readBack(bytes: Buffer, written: Written[]) {
  const pkg: ZipPackage = readPackage(bytes);
  const strings = sharedStrings(pkg);
  const paths = sheetParts(pkg);
  const bySheet = new Map<string, Map<string, string>>();
  const mismatches: (Written & { found: string })[] = [];
  for (const w of written) {
    if (!bySheet.has(w.sheet))
      bySheet.set(
        w.sheet,
        new Map(
          cells(readText(pkg, paths.get(w.sheet)!)).map((c) => [c.ref, cellText(c, strings)]),
        ),
      );
    const found = bySheet.get(w.sheet)!.get(w.cell) ?? '';
    if (found !== w.value) mismatches.push({ ...w, found });
  }
  return mismatches;
}
