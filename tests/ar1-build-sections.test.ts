import { describe, expect, it } from 'vitest';
import {
  analysisFor,
  buildContext,
  buildFiling,
  buildReturn,
  buildSectionB,
  buildSectionC,
  buildSectionD,
  buildSectionE,
  buildSectionF,
  buildSectionG,
  choosesAnalysis,
  maskAr1Data,
  type BuildInput,
  type ReturnIssue,
} from '../src/domain/ar1/build';
import {
  BO_EXEMPT,
  emptyAnswers,
  needsCourtOrder,
  needsDeclaration,
} from '../src/domain/ar1/returns';
import { formatMyr } from '../src/domain/ar1/money';
import { APPLICATIONS, BO_STATUSES, TRUSTEE_TYPES } from '../src/domain/ar1/mtool-lists';
import type { Charge } from '../src/domain/ar1/charges';
import type { ShareEntry } from '../src/domain/ar1/shares';
import type { CompanyRelationship, DatedValue, Person } from '../src/domain/resolution/model';

// ---------------------------------------------------------------- plain fixtures (fictional)
const dated = (value: string) =>
  ({
    value,
    effectiveDate: '2000-01-01',
    recordedAt: '2026-01-01T00:00:00Z',
    actorId: 't',
    reason: 'Fictional',
  }) as DatedValue;
const values = (v: Record<string, string>) =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, [dated(x)]]));
const addr = (prefix: string) => ({
  [`${prefix}Line1`]: '1 Jalan Contoh',
  [`${prefix}Postcode`]: '50450',
  [`${prefix}Town`]: 'Kuala Lumpur',
  [`${prefix}State`]: 'W.P. KUALA LUMPUR',
  [`${prefix}Country`]: 'MALAYSIA',
});
const person = (id: string, v: Record<string, string>, kind?: 'organisation'): Person =>
  ({
    id,
    kind,
    fullName: `Person ${id} (fictional)`,
    nameHistory: [],
    email: null,
    notes: '',
    customValues: {},
    particulars: values(v),
    createdBy: 't',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    revision: 1,
  }) as Person;
const individual = (extra: Record<string, string> = {}) => ({
  identityType: 'MyKad',
  identityNumber: '880516145888',
  nationality: 'MALAYSIA',
  race: 'CHINESE',
  gender: 'Female',
  dateOfBirth: '1988-05-16',
  occupation: 'COMPANY DIRECTOR',
  serviceSameAsResidential: 'Yes',
  ...addr('residential'),
  ...extra,
});
const rel = (
  id: string,
  personId: string,
  role: CompanyRelationship['role'],
  extra: Partial<CompanyRelationship> = {},
): CompanyRelationship => ({
  id,
  companyId: 'c1',
  personId,
  role,
  capacity: '',
  startDate: '2024-11-01',
  endDate: null,
  projectedFrom: null,
  evidenceIds: [],
  createdBy: 't',
  createdAt: '2026-01-01',
  revision: 1,
  ...extra,
});
let n = 0;
const entry = (e: Partial<ShareEntry>): ShareEntry => ({
  id: `e${String(++n).padStart(3, '0')}`,
  companyId: 'c1',
  kind: 'allotment',
  date: '2024-11-01',
  classId: 'ord',
  shares: '100',
  from: null,
  to: null,
  amountPayable: '100',
  amountPaid: '100',
  consideration: 'Cash',
  sourceDocumentId: 'd',
  sourceCaseId: null,
  note: '',
  status: 'Posted',
  predecessorId: null,
  voids: false,
  preparedBy: 'a',
  preparedAt: '2024-11-01',
  reviewerId: 'b',
  postedAt: new Date(Date.UTC(2024, 10, 1) + n * 1000).toISOString(),
  revision: 1,
  ...e,
});
const charge = (c: Partial<Charge>): Charge => ({
  id: 'ch1',
  companyId: 'c1',
  registeredNumber: 'CC0001',
  registeredOn: '2025-01-15',
  nature: 'Fixed charge',
  chargee: 'FICTIONAL BANK BERHAD',
  amount: '500000',
  dischargedOn: null,
  note: '',
  createdBy: 't',
  createdAt: '2026-01-01',
  revision: 1,
  ...c,
});
const deceased = {
  type: TRUSTEE_TYPES[0],
  subjectName: 'Late Member (fictional)',
  subjectIdType: 'MyKad',
  subjectIdNumber: '500101105555',
  subjectNationality: 'MALAYSIA',
};

/**
 * A private company on its second return (made up to 1 Nov 2025, last return 1 May 2025): two
 * directors, a secretary, a manager, an auditor, and members of each kind.
 */
function input(): BuildInput {
  const people = [
    person('dir', individual()),
    person('alt', individual({ race: 'MALAY' })),
    person(
      'sec',
      individual({
        secretaryBody: 'Malaysian Association of Company Secretaries (MACS)',
        secretaryLicence: 'MACS 00000',
        practisingCertificate: '202000000000',
        ...addr('business'),
      }),
    ),
    person(
      'mgr',
      individual({
        nationality: 'SINGAPORE',
        identityType: 'Passport number',
        identityNumber: 'A1234567',
        passportExpiry: '2030-01-01',
      }),
    ),
    person('aud', { auditFirmNumber: 'AF0001', ...addr('registered') }, 'organisation'),
    person(
      'org',
      {
        identityType: 'Registration number',
        identityNumber: '202001000001',
        analysis: 'Bodies corporate controlled by non-citizens',
        ...addr('registered'),
      },
      'organisation',
    ),
    person('j1', individual({ race: 'MALAY' })),
    person('j2', individual({ race: 'CHINESE' })),
    person('tru', individual({ race: 'OTHER' })),
  ];
  const answers = emptyAnswers();
  answers.certificate = {
    unclaimedMoneys: 'Yes',
    noPublicInvitation: 'Yes',
    overFifty: 'Yes',
    overFiveHundred: null,
    boStatus: 'Company has beneficial owner(s)',
    boExemptCategory: null,
    nomineeStatus: null,
  };
  answers.jointAnalyses = { 'j1+j2': 'Citizens who are Malays and natives' };
  answers.certificate.nomineeStatus = null;
  return {
    company: {
      id: 'c1',
      name: 'Test Sdn Bhd',
      registrationNumber: '202401012345 (1234567-A)',
      incorporationDate: '2024-11-01',
      financialYearEnd: '12-31',
      legalStatus: 'Existing',
      engagementStatus: 'Active',
      address: '',
      activity: '',
      verification: 'Unverified',
      sourceEvidenceId: null,
      revision: 1,
    },
    profile: {
      companyId: 'c1',
      revision: 1,
      citations: {},
      customValues: {},
      particulars: values({
        origin: 'Incorporated in Malaysia',
        status: 'Private company',
        companyType: 'Company limited by shares',
        ...addr('registered'),
        membersRegisterAtRegistered: 'Yes',
        financialRecordsAtRegistered: 'Yes',
        ...addr('principal'),
        msic1: '62010',
        natureOfBusiness: 'Software (fictional)',
      }),
      shareClasses: [
        { id: 'ord', name: 'Ordinary', kind: 'Ordinary' },
        { id: 'pref', name: 'Preference', kind: 'Preference' },
      ],
    },
    record: {
      calendarYear: 2025,
      returnDate: '2025-11-01',
      firstReturn: false,
      lastReturnDate: '2025-05-01',
      application: 'Ordinary filing',
      rectificationDeclaration: '',
      courtOrderReference: '',
      answers,
    },
    people: new Map(people.map((p) => [p.id, p])),
    relationships: [
      rel('r-dir', 'dir', 'director', {
        appointment: { designation: 'Director', alternateTo: null, nominee: false },
      }),
      rel('r-alt', 'alt', 'director', {
        appointment: { designation: 'Alternate director', alternateTo: 'dir', nominee: false },
      }),
      rel('r-sec', 'sec', 'secretary'),
      rel('r-mgr', 'mgr', 'manager'),
      rel('r-aud', 'aud', 'auditor'),
      rel('r-gone', 'j1', 'director', { endDate: '2025-01-01' }),
    ],
    otherDirectorships: new Map(),
    entries: [
      entry({ to: { partyIds: ['dir'] }, shares: '600', amountPayable: '600', amountPaid: '600' }),
      // Partly paid, otherwise than cash: RM50 paid of RM200.
      entry({
        to: { partyIds: ['org'] },
        shares: '200',
        amountPayable: '200',
        amountPaid: '50',
        consideration: 'Otherwise than cash',
      }),
      entry({ to: { partyIds: ['j1', 'j2'] }, shares: '100', classId: 'pref' }),
      entry({ to: { partyIds: ['tru'], trustee: deceased }, shares: '100' }),
      entry({
        kind: 'transfer',
        date: '2025-06-01',
        from: { partyIds: ['dir'] },
        to: { partyIds: ['alt'] },
        shares: '50',
        amountPayable: null,
        amountPaid: null,
        consideration: null,
      }),
      entry({
        kind: 'buyback',
        date: '2025-07-01',
        from: { partyIds: ['dir'] },
        shares: '10',
        amountPayable: null,
        amountPaid: null,
        consideration: null,
      }),
      // Not posted: never counts.
      entry({ to: { partyIds: ['dir'] }, shares: '999', status: 'Withdrawn' }),
    ],
    charges: [charge({}), charge({ id: 'ch2', registeredOn: '2026-01-01' })],
  };
}
const messages = (issues: ReturnIssue[]) => issues.map((i) => i.message);

// ---------------------------------------------------------------- the whole build
describe('buildReturn', () => {
  it('builds the return; only the trustee of another race needs an analysis chosen', () => {
    expect(messages(buildReturn(input()).issues)).toEqual([
      'Person tru (fictional): choose the shareholding analysis.',
    ]);
  });
  it('lists issues by section, Filing first', () => {
    const i = input();
    i.relationships = [];
    i.record.application = 'Rectification filing';
    const sections = buildReturn(i).issues.map((x) => x.section);
    expect(sections[0]).toBe('Filing');
    expect([...sections].sort((a, b) => order(a) - order(b))).toEqual(sections);
  });
});
const order = (s: string) => ['Filing', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].indexOf(s);

// ---------------------------------------------------------------- section B
describe('section B', () => {
  it.each([
    // [label, entries, fully paid, partly paid (row 41), cash, otherwise]
    [
      'fully paid only',
      [entry({ to: { partyIds: ['dir'] }, shares: '10', amountPayable: '10', amountPaid: '10' })],
      '10.00',
      '0.00',
      '10',
      '0',
    ],
    [
      'partly paid only',
      [entry({ to: { partyIds: ['dir'] }, shares: '10', amountPayable: '10', amountPaid: '2.5' })],
      '0.00',
      '2.50',
      '10',
      '0',
    ],
    [
      'both, one otherwise than cash',
      [
        entry({ to: { partyIds: ['dir'] }, shares: '10', amountPayable: '10', amountPaid: '10' }),
        entry({
          to: { partyIds: ['dir'] },
          shares: '5',
          amountPayable: '5',
          amountPaid: '1',
          consideration: 'Otherwise than cash',
        }),
      ],
      '10.00',
      '1.00',
      '10',
      '5',
    ],
  ] as const)('%s', (_label, entries, fully, partly, cash, otherwise) => {
    const i = input();
    i.entries = [...entries];
    const { data } = buildSectionB(buildContext(i));
    expect(data.fullyPaid.Ordinary).toBe(fully);
    expect(data.partlyPaid.Ordinary).toBe(partly);
    expect(data.cash.Ordinary).toBe(cash);
    expect(data.otherwise.Ordinary).toBe(otherwise);
  });
  it('sums the register per kind and leaves no treasury blank only where there is some', () => {
    const { data } = buildSectionB(buildContext(input()));
    expect(data.fullyPaid).toEqual({ Ordinary: '700.00', Preference: '100.00', Other: '0.00' });
    expect(data.partlyPaid).toEqual({ Ordinary: '50.00', Preference: '0.00', Other: '0.00' });
    expect(data.treasury).toEqual({ Ordinary: '10', Preference: '', Other: '' });
  });
});

// ---------------------------------------------------------------- section F analysis
describe('analysisFor and choosesAnalysis', () => {
  const at = '2025-11-01';
  it.each([
    [
      'Malaysian Malay',
      person('p', individual({ race: 'MALAY' })),
      'Citizens who are Malays and natives',
      false,
    ],
    [
      'Malaysian Chinese',
      person('p', individual({ race: 'CHINESE' })),
      'Citizens who are non-Malays and non-natives',
      false,
    ],
    [
      'Malaysian Indian',
      person('p', individual({ race: 'INDIAN' })),
      'Citizens who are non-Malays and non-natives',
      false,
    ],
    [
      'foreign national',
      person('p', individual({ nationality: 'SINGAPORE' })),
      'Non-citizens',
      false,
    ],
    ['Malaysian, other race, not chosen', person('p', individual({ race: 'OTHER' })), '', true],
    [
      'Malaysian, other race, chosen',
      person('p', individual({ race: 'OTHER', analysis: 'Citizens who are Malays and natives' })),
      'Citizens who are Malays and natives',
      true,
    ],
    [
      'organisation with its controller',
      person('o', { analysis: 'Bodies corporate controlled by non-citizens' }, 'organisation'),
      'Bodies corporate controlled by non-citizens',
      false,
    ],
    [
      'organisation with an individual analysis',
      person('o', { analysis: 'Non-citizens' }, 'organisation'),
      '',
      false,
    ],
    ['nobody', undefined, '', false],
  ] as const)('%s', (_label, p, analysis, chooses) => {
    expect(analysisFor(p, at)).toBe(analysis);
    expect(choosesAnalysis(p, at)).toBe(chooses);
  });

  it.each([
    [
      'holders agree: no choice needed',
      ['j1', 'j1b'],
      undefined,
      'Citizens who are Malays and natives',
      false,
    ],
    ['holders differ, not chosen', ['j1', 'j2'], undefined, '', true],
    ['holders differ, chosen on the return', ['j1', 'j2'], 'Non-citizens', 'Non-citizens', false],
    [
      'holders differ, chosen a corporate category',
      ['j1', 'j2'],
      'Bodies corporate controlled by non-citizens',
      'Bodies corporate controlled by non-citizens',
      false,
    ],
    ['an answer outside the list is ignored', ['j1', 'j2'], 'Anything', '', true],
  ] as const)('joint holders: %s', (_label, parties, chosen, analysis, asked) => {
    const i = input();
    i.people.set('j1b', person('j1b', individual({ race: 'MALAY' })));
    i.entries = [entry({ to: { partyIds: [...parties] }, shares: '100' })];
    const key = [...parties].sort().join('+');
    i.record.answers.jointAnalyses = chosen ? { [key]: chosen } : {};
    const { data, issues } = buildSectionE(buildContext(i));
    expect(data.members[0]).toMatchObject({
      memberType: 'Joint holders (Individual or Body Corporate)',
      holderKey: key,
      analysis,
      partyIds: [...parties],
    });
    expect(data.subclassification.map((r) => r.partyIds)).toEqual(parties.map((p) => [p]));
    expect(
      issues.some((x) => x.target.kind === 'answer' && x.target.field === `joint:${key}`),
    ).toBe(asked);
  });

  it('lists missing particulars for each joint holder, once per person', () => {
    const i = input();
    i.people.set('j3', person('j3', { nationality: 'MALAYSIA', race: 'CHINESE' }));
    i.entries = [
      entry({ to: { partyIds: ['j1', 'j3'] }, shares: '100' }),
      entry({ to: { partyIds: ['j3'] }, shares: '5' }),
    ];
    const { issues } = buildSectionE(buildContext(i));
    const forJ3 = issues.filter((x) => x.target.kind === 'person' && x.target.id === 'j3');
    expect(forJ3).toHaveLength(1);
    expect(forJ3[0].target).toMatchObject({
      keys: expect.arrayContaining(['identityNumber', 'dateOfBirth', 'residentialLine1']),
      roles: ['member'],
    });
    expect(issues.some((x) => x.target.kind === 'person' && x.target.id === 'j1')).toBe(false);
  });

  it('adds shares by analysis, with unclassified shares apart', () => {
    const i = input();
    i.record.answers.jointAnalyses = {};
    const ctx = buildContext(i);
    const { data } = buildSectionF(ctx, buildSectionE(ctx).data.members);
    expect(data.byAnalysis['Citizens who are non-Malays and non-natives']).toBe('540');
    expect(data.byAnalysis['Citizens who are Malays and natives']).toBe('50');
    expect(data.byAnalysis['Bodies corporate controlled by non-citizens']).toBe('200');
    // The joint holding (no analysis chosen) and the trustee (other race) are unclassified.
    expect(data.unclassified).toBe('200');
    expect(data.total).toBe('990');
  });
});

// ---------------------------------------------------------------- trustees
describe('trustee sub-classification', () => {
  it.each([
    [TRUSTEE_TYPES[0], 'Deceased member'],
    [TRUSTEE_TYPES[1], 'Bankrupt member'],
    [TRUSTEE_TYPES[2], 'Individual'],
  ])('%s gives %s', (type, subclass) => {
    const i = input();
    i.entries = [entry({ to: { partyIds: ['dir'], trustee: { ...deceased, type } }, shares: '5' })];
    const { data } = buildSectionE(buildContext(i));
    expect(data.members[0]).toMatchObject({ trusteeType: type, memberType: 'Individual' });
    expect(data.subclassification).toEqual([
      expect.objectContaining({
        reference: data.members[0].reference,
        type: subclass,
        name: 'Late Member (fictional)',
        idNumber: '500101105555',
        nationality: 'MALAYSIA',
        partyIds: [],
      }),
    ]);
  });
});

// ---------------------------------------------------------------- certificate (b)
describe('transfers since the last return', () => {
  it.each([
    ['a transfer after the last return', false, '2025-05-01', 'Yes'],
    ['the only transfer was before the last return', false, '2025-07-01', 'No'],
    ['a transfer on the last return date counts for that return', false, '2025-06-01', 'No'],
    ['first return: every transfer counts', true, '2025-07-01', 'Yes'],
  ] as const)('%s', (_label, firstReturn, lastReturnDate, answer) => {
    const i = input();
    i.record.firstReturn = firstReturn;
    i.record.lastReturnDate = lastReturnDate;
    expect(buildSectionG(buildContext(i)).data.transfersRegistered).toBe(answer);
  });
  it('ignores transfers after the return date', () => {
    const i = input();
    i.record.returnDate = '2025-05-31';
    i.record.lastReturnDate = '2025-01-01';
    expect(buildSectionG(buildContext(i)).data.transfersRegistered).toBe('No');
  });
});

// ---------------------------------------------------------------- filing and certificate issues
describe('court order and certificate issues', () => {
  it.each(APPLICATIONS.map((a) => [a, needsDeclaration(a), needsCourtOrder(a)] as const))(
    '%s',
    (application, declaration, courtOrder) => {
      const i = input();
      i.record.application = application;
      const fields = buildFiling(buildContext(i)).issues.map((x) =>
        x.target.kind === 'answer' ? x.target.field : '',
      );
      expect(fields.includes('rectificationDeclaration')).toBe(declaration);
      expect(fields.includes('courtOrderReference')).toBe(courtOrder);
      i.record.rectificationDeclaration = 'SD-1 (fictional)';
      i.record.courtOrderReference = 'CO-1 (fictional)';
      expect(buildFiling(buildContext(i)).issues).toEqual([]);
    },
  );
  it('names the applications that need each answer', () => {
    expect(APPLICATIONS.filter(needsDeclaration)).toEqual([
      'Rectification filing',
      'Rectification filing with court order',
    ]);
    expect(APPLICATIONS.filter(needsCourtOrder)).toEqual([
      'Rectification filing with court order',
      'Court order filing',
    ]);
    expect(BO_EXEMPT).toBe(BO_STATUSES[3]);
  });
  it.each([
    ['private: (d) needed', 'Private company', { overFifty: null }, ['overFifty']],
    [
      'public: (e) and quoted shares needed, not (d)',
      'Public company',
      { overFifty: null },
      ['overFiveHundred', 'sharesQuoted'],
    ],
    [
      'exempt from BO reporting: (g) needed',
      'Private company',
      { boStatus: BO_EXEMPT },
      ['boExemptCategory'],
    ],
    ['nominee status left to the appointments', 'Private company', { nomineeStatus: null }, []],
    [
      'everything unanswered',
      'Private company',
      { unclaimedMoneys: null, noPublicInvitation: null, boStatus: null },
      ['unclaimedMoneys', 'noPublicInvitation', 'boStatus'],
    ],
  ] as const)('%s', (_label, status, cert, fields) => {
    const i = input();
    i.profile.particulars!.status = [dated(status)];
    Object.assign(i.record.answers.certificate, cert);
    const ctx = buildContext(i);
    const asked = [...buildFiling(ctx).issues, ...buildSectionG(ctx).issues].map((x) =>
      x.target.kind === 'answer' ? x.target.field : x.message,
    );
    expect(asked.sort()).toEqual([...fields].sort());
  });
  it('defaults (h) from the nominee flags and asks when a designation is missing', () => {
    const i = input();
    expect(buildSectionG(buildContext(i)).data.nomineeStatus).toBe(
      'None of the director(s) of the company is a nominee director',
    );
    i.relationships[1] = {
      ...i.relationships[1],
      appointment: { ...i.relationships[1].appointment!, nominee: true },
    };
    expect(buildSectionG(buildContext(i)).data.nomineeStatus).toBe(
      'Company has director(s) appointed as nominee director(s)',
    );
    delete i.relationships[0].appointment;
    expect(messages(buildSectionG(buildContext(i)).issues)).toEqual([
      'Answer certificate (h), nominee directors.',
    ]);
  });
});

// ---------------------------------------------------------------- fix targets
describe('fix targets', () => {
  it('points officer gaps at the officers, appointments and people', () => {
    const i = input();
    i.relationships = [rel('r-x', 'dir', 'director')];
    i.people.set('dir', person('dir', individual({ occupation: '', residentialPostcode: '5045' })));
    const { issues } = buildSectionD(buildContext(i));
    expect(issues.map((x) => x.target)).toEqual([
      { kind: 'appointment', relationshipId: 'r-x' },
      {
        kind: 'person',
        id: 'dir',
        keys: ['occupation', 'residentialLine1', 'serviceLine1'],
        roles: ['director'],
      },
      { kind: 'officers' },
    ]);
    expect(messages(issues)[2]).toBe('No secretary is in office on the return date.');
    i.relationships = [];
    expect(buildSectionD(buildContext(i)).issues.map((x) => x.target)).toEqual([
      { kind: 'officers' },
      { kind: 'officers' },
    ]);
  });
  it('asks for a passport expiry date with a passport number', () => {
    const i = input();
    i.people.set(
      'mgr',
      person('mgr', individual({ identityType: 'Passport number', identityNumber: 'A1' })),
    );
    const target = buildSectionD(buildContext(i)).issues[0].target;
    expect(target).toEqual({
      kind: 'person',
      id: 'mgr',
      keys: ['passportExpiry'],
      roles: ['manager'],
    });
  });
  it('writes the audit firm number as mTool takes it, and asks again for one it would refuse', () => {
    const i = input();
    const auditor = (firm: string) =>
      person('aud', { auditFirmNumber: firm, ...addr('registered') }, 'organisation');
    i.people.set('aud', auditor('af 1621'));
    let built = buildSectionD(buildContext(i));
    expect(built.data.auditors[0].firmNumber).toBe('AF1621');
    expect(built.issues).toEqual([]);
    i.people.set('aud', auditor('AF-1621'));
    built = buildSectionD(buildContext(i));
    expect(built.issues.map((x) => [x.message, x.target])).toEqual([
      [
        'Person aud (fictional): the audit firm number should be AF and four digits.',
        { kind: 'person', id: 'aud', keys: ['auditFirmNumber'], roles: ['auditor'] },
      ],
    ]);
  });
  it('points company gaps at the company particulars', () => {
    const i = input();
    i.profile.particulars = {};
    const filing = buildFiling(buildContext(i)).issues.map((x) => x.target);
    expect(filing).toEqual([
      { kind: 'company', keys: ['origin'] },
      { kind: 'company', keys: ['status'] },
      { kind: 'company', keys: ['companyType'] },
    ]);
    i.company.registrationNumber = '1234567-A';
    expect(buildFiling(buildContext(i)).issues[0].target).toEqual({ kind: 'company', keys: [] });
  });
  it('points a member organisation at its controller', () => {
    const i = input();
    i.people.set(
      'org',
      person(
        'org',
        {
          identityType: 'Registration number',
          identityNumber: '202001000001',
          ...addr('registered'),
        },
        'organisation',
      ),
    );
    expect(buildSectionE(buildContext(i)).issues.map((x) => x.target)).toEqual([
      { kind: 'person', id: 'org', keys: ['analysis'], roles: ['member'] },
      { kind: 'person', id: 'tru', keys: ['analysis'], roles: ['member'] },
    ]);
  });
});

// ---------------------------------------------------------------- blockers
describe('blockers', () => {
  const blockers = (i: BuildInput) => buildReturn(i).issues.filter((x) => x.severity === 'blocker');
  it('reports a holding that goes below zero, and the totals that then disagree', () => {
    const i = input();
    i.entries = [
      entry({ to: { partyIds: ['dir'] }, shares: '100' }),
      entry({
        kind: 'transfer',
        date: '2025-02-01',
        from: { partyIds: ['dir'] },
        to: { partyIds: ['alt'] },
        shares: '150',
        amountPayable: null,
        amountPaid: null,
        consideration: null,
      }),
    ];
    expect(blockers(i)).toEqual([
      expect.objectContaining({ section: 'B', target: { kind: 'shares' } }),
      {
        section: 'F',
        severity: 'blocker',
        message: 'Members hold 150 shares and treasury 0, but 100 are issued.',
        target: { kind: 'shares' },
      },
    ]);
  });
  it('reports a company not limited by shares', () => {
    const i = input();
    i.profile.particulars!.companyType = [dated('Company limited by guarantee')];
    expect(blockers(i)).toEqual([
      {
        section: 'Filing',
        severity: 'blocker',
        message: 'The AR1 template is for companies limited by shares.',
        target: { kind: 'company', keys: ['companyType'] },
      },
    ]);
  });
  it('has none for a register that adds up', () => {
    expect(blockers(input())).toEqual([]);
  });
});

// ---------------------------------------------------------------- data shape for the screens
describe('row data for the screens', () => {
  it('keeps who each row is about', () => {
    const { data } = buildReturn(input());
    expect(data.d.directors.map((r) => r.personId)).toEqual(['dir', 'alt']);
    expect(data.d.directors[1].alternateTo).toBe('Person dir (fictional)');
    expect(data.d.managers.map((r) => r.personId)).toEqual(['mgr']);
    expect(data.d.secretaries.map((r) => r.personId)).toEqual(['sec']);
    expect(data.d.auditors.map((r) => r.personId)).toEqual(['aud']);
    expect(data.e.members.map((r) => r.partyIds)).toEqual([
      ['dir'],
      ['org'],
      ['j1', 'j2'],
      ['tru'],
      ['alt'],
    ]);
  });
  it('gives charges the mTool date and the ISO date, counting only those registered by then', () => {
    const { data } = buildSectionC(buildContext(input()));
    expect(data.charges).toEqual([
      {
        registeredNumber: 'CC0001',
        registeredOn: '15/01/2025',
        registeredIso: '2025-01-15',
        nature: 'Fixed charge',
        chargee: 'FICTIONAL BANK BERHAD',
        amount: '500000.00',
      },
    ]);
  });
});

// ---------------------------------------------------------------- other directorships
describe('other directorships', () => {
  it('writes "[registration no.] NAME" and asks for a missing number', () => {
    const i = input();
    i.otherDirectorships = new Map([
      [
        'dir',
        [
          { registrationNumber: '202001000001', name: 'Other Sdn. Bhd.' },
          { registrationNumber: '', name: 'Hand Entered Bhd.' },
        ],
      ],
    ]);
    const { data, issues } = buildSectionD(buildContext(i));
    expect(data.directors[0].otherDirectorships).toBe(
      '[202001000001] OTHER SDN. BHD.; HAND ENTERED BHD.',
    );
    expect(issues).toEqual([
      {
        section: 'D',
        severity: 'missing',
        message:
          'Person dir (fictional): add the registration number of Hand Entered Bhd., a directorship at another company.',
        target: { kind: 'person', id: 'dir', keys: [], roles: ['director'] },
      },
    ]);
  });
});

// ---------------------------------------------------------------- masking
describe('maskAr1Data', () => {
  it('masks every individual identity value and leaves organisations and the original alone', () => {
    const i = input();
    i.entries.push(entry({ to: { partyIds: ['org', 'j2'] }, shares: '1', classId: 'pref' }));
    const { data } = buildReturn(i);
    const masked = maskAr1Data(data);
    for (const r of [...masked.d.directors, ...masked.d.managers, ...masked.d.secretaries]) {
      expect(r.idNumber).not.toMatch(/\d{6}\d/);
      expect(r.dateOfBirth).toBe('**/**/****');
    }
    expect(masked.d.directors[0].idNumber).toBe('880516-**-****');
    expect(masked.d.managers[0]).toMatchObject({
      idNumber: 'A1****67',
      passportExpiry: '**/**/****',
    });
    const member = (ref: string) => masked.e.members.find((m) => m.reference === ref)!;
    expect(member('0001')).toMatchObject({ idNumber: '880516-**-****', dateOfBirth: '**/**/****' });
    expect(member('0002')).toMatchObject({
      memberType: 'Body corporate',
      idNumber: '202001000001',
    });
    const subjects = masked.e.subclassification;
    expect(subjects.find((s) => s.type === 'Deceased member')!.idNumber).toBe('500101-**-****');
    expect(subjects.find((s) => s.type === 'Body corporate')!.idNumber).toBe('202001000001');
    expect(
      subjects.filter((s) => s.type === 'Individual').every((s) => s.idNumber === '880516-**-****'),
    ).toBe(true);
    // The workbook is filled from the unmasked values.
    expect(data.d.directors[0].idNumber).toBe('880516145888');
    expect(data.d.managers[0].passportExpiry).toBe('01/01/2030');
  });
});

// ---------------------------------------------------------------- money
describe('formatMyr', () => {
  it.each([
    ['0', '0.00'],
    ['5', '5.00'],
    ['1234.5', '1,234.50'],
    ['1234567.89', '1,234,567.89'],
    ['', '0.00'],
    ['not money', '0.00'],
    [123456789n, '1,234,567.89'],
    [-150n, '-1.50'],
    ['999999999999999.99', '999,999,999,999,999.99'],
  ] as const)('%s', (value, text) => {
    expect(formatMyr(value)).toBe(text);
  });
  it('matches the screens’ number formatting for ordinary amounts', () => {
    for (const amount of ['0', '1', '12.3', '1000', '98765.43', '500000'])
      expect(formatMyr(amount)).toBe(
        Number(amount).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      );
  });
});

describe('dated appointments', () => {
  it('reads the value in force on the return date', () => {
    const i = input();
    i.relationships[0] = {
      ...i.relationships[0],
      appointmentHistory: [
        { designation: 'Director', alternateTo: null, nominee: false, from: null },
        { designation: 'Director', alternateTo: null, nominee: true, from: '2099-01-01' },
      ],
      appointment: { designation: 'Director', alternateTo: null, nominee: true },
    };
    // The later nominee flag does not reach a return dated before it.
    expect(buildSectionG(buildContext(i)).data.nomineeStatus).toBe(
      'None of the director(s) of the company is a nominee director',
    );
    i.relationships[0].appointmentHistory = [
      { designation: 'Director', alternateTo: null, nominee: false, from: '2099-01-01' },
    ];
    expect(
      buildSectionD(buildContext(i)).issues.some(
        (x) => x.target.kind === 'appointment' && x.target.relationshipId === i.relationships[0].id,
      ),
    ).toBe(true);
  });
});
