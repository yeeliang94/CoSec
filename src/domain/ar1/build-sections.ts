import {
  appointmentAt,
  type CompanyRelationship,
  type ParticularKey,
  type Person,
} from '../resolution/model';
import { addressOf, particularsAt } from '../resolution/particulars';
import { isAddressComplete } from '../address';
import { branchesAt, companyAddress } from './company';
import { chargesAt } from './charges';
import { ringgit, sen, SHARE_KINDS, transfersBetween, typesOfSharesWording } from './shares';
import { BO_EXEMPT, mtoolDate, needsCourtOrder, needsDeclaration } from './returns';
import {
  ALL_ANALYSES,
  analysisFor,
  cellsOf,
  choosesAnalysis,
  emptyCells,
  IDENTITY,
  identityCells,
  issueList,
  requireParticulars,
  splitRegistrationNumber,
  type AddressGroupName,
  type BuildContext,
} from './build-context';
import type {
  Ar1Data,
  AuditorRow,
  Built,
  DirectorRow,
  FilingInfo,
  ManagerRow,
  MemberRow,
  PerKind,
  SecretaryRow,
  SubclassificationRow,
} from './data';

/** Filing information as the blank must hold it, and what the return itself still needs. */
export function buildFiling(ctx: BuildContext): Built<FilingInfo> {
  const { input, cp, isPublic, asAt } = ctx;
  const { company, record } = input;
  const { issues, missing, blocker } = issueList('Filing');
  const reg = splitRegistrationNumber(company.registrationNumber);
  const data: FilingInfo = {
    newRegistrationNumber: reg.fresh,
    oldRegistrationNumber: reg.old,
    name: company.name,
    formerName: cp.formerName ?? '',
    gstNumber: cp.gstNumber ?? '',
    calendarYear: String(record.calendarYear),
    dateOfReturn: mtoolDate(asAt),
    origin: cp.origin ?? '',
    status: cp.status ?? '',
    companyType: cp.companyType ?? '',
    application: record.application,
    rectificationDeclaration: record.rectificationDeclaration,
    courtOrderReference: record.courtOrderReference,
    submissionType: 'AR1',
    firstReturn: record.firstReturn ? 'Yes' : 'No',
    sharesQuoted: isPublic ? (record.answers.sharesQuoted ?? '') : '',
    numberOfMembers: 'Company with equal to or less than five hundred members',
  };
  if (!reg.fresh)
    missing('The company record has no 12-digit registration number.', {
      kind: 'company',
      keys: [],
    });
  for (const [key, label] of [
    ['origin', 'origin'],
    ['status', 'status'],
    ['companyType', 'type'],
  ] as const)
    if (!cp[key]) missing(`Record the company's ${label}.`, { kind: 'company', keys: [key] });
  if (cp.companyType && cp.companyType !== 'Company limited by shares')
    blocker('The AR1 template is for companies limited by shares.', {
      kind: 'company',
      keys: ['companyType'],
    });
  if (isPublic && !record.answers.sharesQuoted)
    missing('Answer whether the shares are quoted.', { kind: 'answer', field: 'sharesQuoted' });
  if (needsDeclaration(record.application) && !record.rectificationDeclaration.trim())
    missing('Enter the statutory declaration for rectification.', {
      kind: 'answer',
      field: 'rectificationDeclaration',
    });
  if (needsCourtOrder(record.application) && !record.courtOrderReference.trim())
    missing('Enter the court order reference.', { kind: 'answer', field: 'courtOrderReference' });
  return { data, issues };
}

/** Section A: offices, contact details, business codes and branches. */
export function buildSectionA(ctx: BuildContext): Built<Ar1Data['a']> {
  const { cp, asAt, input } = ctx;
  const { issues, missing } = issueList('A');
  const registered = companyAddress(cp, 'registered');
  if (!isAddressComplete(registered))
    missing('Complete the registered office address.', {
      kind: 'company',
      keys: [
        'registeredLine1',
        'registeredPostcode',
        'registeredTown',
        'registeredState',
        'registeredCountry',
      ],
    });
  for (const group of ['membersRegister', 'financialRecords'] as const)
    if (!isAddressComplete(companyAddress(cp, group)))
      missing(
        group === 'membersRegister'
          ? 'Record where the register of members is kept.'
          : 'Record where the financial records are kept.',
        { kind: 'company', keys: [`${group}AtRegistered`] },
      );
  const principal = companyAddress(cp, 'principal');
  if (!isAddressComplete(principal))
    missing('Complete the principal place of business.', {
      kind: 'company',
      keys: ['principalLine1', 'principalCountry'],
    });
  const msic = [cp.msic1, cp.msic2, cp.msic3]
    .filter(Boolean)
    .map((code) => ({ code: code!, description: '' }));
  if (!msic.length)
    missing('Record at least one MSIC code for the nature of business.', {
      kind: 'company',
      keys: ['msic1'],
    });
  return {
    data: {
      registered: cellsOf(registered),
      membersRegister: cellsOf(companyAddress(cp, 'membersRegister')),
      financialRecords: cellsOf(companyAddress(cp, 'financialRecords')),
      principal: cellsOf(principal),
      phone: cp.phone ?? '',
      fax: cp.fax ?? '',
      email: cp.email ?? '',
      website: cp.website ?? '',
      natureOfBusiness: cp.natureOfBusiness ?? '',
      msic,
      branches: branchesAt(input.profile.branches, asAt).map((b) => ({
        address: cellsOf(b),
        phone: b.phone,
        fax: b.fax,
        email: b.email,
        website: b.website,
      })),
    },
    issues,
  };
}

/**
 * Section B from the share register. Row 41 ("partly unpaid") is read as the amount paid on
 * partly paid shares, so row 42 (the total issued capital) is fully paid plus partly paid.
 */
export function buildSectionB(ctx: BuildContext): Built<Ar1Data['b']> {
  const { input, register, sumByKind, treasury, issuedTotal } = ctx;
  const { issues, missing, blocker } = issueList('B');
  const { state, problems } = register;
  for (const p of problems) blocker(p.message, { kind: 'shares' });
  const perKind = (
    values: PerKind<bigint>,
    format: (n: bigint) => string,
    skipZero: boolean,
  ): PerKind<string> =>
    Object.fromEntries(
      SHARE_KINDS.map((k) => [k, skipZero && values[k] === 0n ? '' : format(values[k])]),
    ) as PerKind<string>;
  const count = (n: bigint) => n.toString();
  const issued = (id: string) => state.issued.get(id);
  if (!(input.profile.shareClasses ?? []).length)
    missing('Record the share classes and the share register.', { kind: 'shares' });
  else if (issuedTotal < 1n)
    missing('No issued shares are posted by the return date.', { kind: 'shares' });
  const answers = input.record.answers.sectionB;
  const fromAnswers = (values: Partial<Record<keyof PerKind<string>, string>>) =>
    Object.fromEntries(SHARE_KINDS.map((k) => [k, (values[k] ?? '').trim()])) as PerKind<string>;
  return {
    data: {
      cash: perKind(
        sumByKind((id) => issued(id)?.cash ?? 0n),
        count,
        false,
      ),
      otherwise: perKind(
        sumByKind((id) => issued(id)?.otherwise ?? 0n),
        count,
        false,
      ),
      forfeited: fromAnswers(answers.forfeitedShares),
      treasury: perKind(treasury, count, true),
      fullyPaid: perKind(
        sumByKind((id) => issued(id)?.fullyPaid ?? 0n),
        ringgit,
        false,
      ),
      partlyPaid: perKind(
        sumByKind((id) => issued(id)?.partlyPaid ?? 0n),
        ringgit,
        false,
      ),
      calledUp: fromAnswers(answers.calledUp),
      callsReceived: fromAnswers(answers.callsReceived),
      consideredPaidFullyPaid: fromAnswers(answers.consideredPaidFullyPaid),
      consideredPaidPartlyPaid: fromAnswers(answers.consideredPaidPartlyPaid),
      callsUnpaid: fromAnswers(answers.callsUnpaid),
      paidOnForfeited: fromAnswers(answers.paidOnForfeited),
      commission: answers.commission.trim(),
      discount: answers.discount.trim(),
      notesOnShares: answers.notesOnShares.trim(),
      notesOnDebentures: answers.notesOnDebentures.trim(),
    },
    issues,
  };
}

/** Section C: charges registered by the return date and not discharged by then. */
export function buildSectionC(ctx: BuildContext): Built<Ar1Data['c']> {
  const { input, asAt } = ctx;
  return {
    data: {
      charges: chargesAt(input.charges, asAt).map((ch) => ({
        registeredNumber: ch.registeredNumber,
        registeredOn: mtoolDate(ch.registeredOn),
        registeredIso: ch.registeredOn,
        nature: ch.nature,
        chargee: ch.chargee,
        amount: ringgit(sen(ch.amount)),
      })),
      notes: input.record.answers.notesOnIndebtedness.trim(),
    },
    issues: [],
  };
}

/** Section D: directors, managers, secretaries and auditors in office on the return date. */
export function buildSectionD(ctx: BuildContext): Built<Ar1Data['d']> {
  const { input, asAt, officers } = ctx;
  const { people } = input;
  const { issues, missing } = issueList('D');
  const need = (
    person: Person,
    role: CompanyRelationship['role'],
    keys: ParticularKey[],
    addresses?: AddressGroupName[],
  ) => requireParticulars(missing, asAt, person, role, keys, addresses);
  const nameOf = (id: string) => people.get(id)?.fullName ?? '';
  const directors: DirectorRow[] = [];
  const managers: ManagerRow[] = [];
  const secretaries: SecretaryRow[] = [];
  const auditors: AuditorRow[] = [];
  const seen = new Set<string>();
  for (const r of officers) {
    const person = people.get(r.personId);
    if (!person || seen.has(`${r.role}|${r.personId}`)) continue;
    seen.add(`${r.role}|${r.personId}`);
    const v = particularsAt(person, asAt);
    const identity = identityCells(person, asAt);
    if (r.role === 'director') {
      const appointment = appointmentAt(r, asAt);
      if (!appointment)
        missing(`${person.fullName}: record the designation (director or alternate).`, {
          kind: 'appointment',
          relationshipId: r.id,
        });
      need(person, 'director', [...IDENTITY, 'occupation'], ['residential', 'service']);
      const elsewhere = input.otherDirectorships.get(person.id) ?? [];
      for (const d of elsewhere)
        if (!d.registrationNumber)
          missing(
            `${person.fullName}: add the registration number of ${d.name}, a directorship at another company.`,
            { kind: 'person', id: person.id, keys: [], roles: ['director'] },
          );
      directors.push({
        personId: person.id,
        ...identity,
        designation: appointment?.designation ?? '',
        alternateTo: appointment?.alternateTo ? nameOf(appointment.alternateTo) : '',
        residential: cellsOf(addressOf(v, 'residential')),
        service: cellsOf(addressOf(v, 'service')),
        email: v.serviceEmail ?? '',
        occupation: v.occupation ?? '',
        // The column head reads "[Company registration number] Name of company".
        otherDirectorships: elsewhere
          .map((d) =>
            d.registrationNumber
              ? `[${d.registrationNumber}] ${d.name.toUpperCase()}`
              : d.name.toUpperCase(),
          )
          .join('; '),
      });
    } else if (r.role === 'manager') {
      need(person, 'manager', IDENTITY);
      managers.push({
        personId: person.id,
        ...identity,
        residential: cellsOf(addressOf(v, 'residential')),
        business: cellsOf(addressOf(v, 'business')),
        occupation: v.occupation ?? '',
      });
    } else if (r.role === 'secretary') {
      need(person, 'secretary', [
        ...IDENTITY,
        'secretaryBody',
        'secretaryLicence',
        'practisingCertificate',
      ]);
      secretaries.push({
        personId: person.id,
        ...identity,
        residential: cellsOf(addressOf(v, 'residential')),
        business: cellsOf(addressOf(v, 'business')),
        occupation: v.occupation ?? '',
        professionalType: v.secretaryBody ?? '',
        licenceNumber: v.secretaryLicence ?? '',
        practisingCertificate: v.practisingCertificate ?? '',
      });
    } else if (r.role === 'auditor') {
      // mTool's Validate takes only AF and four digits (AF1621), so a space or lower case typed
      // in the record is dropped here, and anything else is sent back to the record.
      const firmNumber = (v.auditFirmNumber ?? '').replace(/\s+/g, '').toUpperCase();
      if (firmNumber && !/^AF\d{4}$/.test(firmNumber))
        missing(`${person.fullName}: the audit firm number should be AF and four digits.`, {
          kind: 'person',
          id: person.id,
          keys: ['auditFirmNumber'],
          roles: ['auditor'],
        });
      auditors.push({
        personId: person.id,
        firmNumber,
        name: person.fullName,
        address: cellsOf(addressOf(v, person.kind === 'organisation' ? 'registered' : 'business')),
      });
    }
  }
  if (!directors.length)
    missing('No director is in office on the return date.', { kind: 'officers' });
  if (!secretaries.length)
    missing('No secretary is in office on the return date.', { kind: 'officers' });
  return { data: { directors, managers, secretaries, auditors }, issues };
}

/** mTool's sub-classification type for the subject of each kind of trust holding. */
export const SUBCLASS_FOR_TRUSTEE: Record<string, string> = {
  'Trustee or Administrator or Executor of deceased member': 'Deceased member',
  'Trustee or Administrator of bankrupt member': 'Bankrupt member',
  'Trustee of under age member': 'Individual',
};
const reference = (n: number) => String(n).padStart(4, '0');
const ORGANISATION_BLANKS = {
  title: '',
  race: '',
  gender: '',
  dateOfBirth: '',
  passportExpiry: '',
} as const;

/**
 * Section E: one row per holder on the return date. Joint holders and trust subjects are listed
 * again in the sub-classification table under the holder's reference.
 */
export function buildSectionE(ctx: BuildContext): Built<Ar1Data['e']> {
  const { input, asAt, holders } = ctx;
  const { people, record } = input;
  const { issues, missing } = issueList('E');
  const members: MemberRow[] = [];
  const subclassification: SubclassificationRow[] = [];
  const subRow = (ref: string, type: string, person: Person): SubclassificationRow => {
    const v = particularsAt(person, asAt);
    const org = person.kind === 'organisation';
    return {
      reference: ref,
      type,
      ...identityCells(person, asAt),
      ...(org ? ORGANISATION_BLANKS : {}),
      address: cellsOf(addressOf(v, org ? 'registered' : 'residential')),
      partyIds: [person.id],
    };
  };
  /** A member's missing particulars, listed once even when they hold in more than one way. */
  const checked = new Set<string>();
  const checkParticulars = (p: Person) => {
    if (checked.has(p.id)) return;
    checked.add(p.id);
    if (p.kind === 'organisation')
      requireParticulars(
        missing,
        asAt,
        p,
        'member',
        ['identityType', 'identityNumber'],
        ['registered'],
      );
    else requireParticulars(missing, asAt, p, 'member', IDENTITY, ['residential']);
  };
  let index = 0;
  for (const [key, { holder, shares, kinds }] of holders) {
    const ref = reference(++index);
    const parties = holder.partyIds.map((id) => people.get(id)).filter(Boolean) as Person[];
    if (parties.length > 1) {
      const all = [...new Set(parties.map((p) => analysisFor(p, asAt)))];
      const chosen = record.answers.jointAnalyses?.[key] ?? '';
      // mTool accepts any of the six categories for joint holders.
      const analysis = (ALL_ANALYSES as readonly string[]).includes(chosen)
        ? chosen
        : all.length === 1
          ? all[0]
          : '';
      if (!analysis)
        missing(`Joint holding ${ref}: choose its shareholding analysis.`, {
          kind: 'answer',
          field: `joint:${key}`,
        });
      for (const p of parties) {
        // Each holder's identity and address go in the sub-classification table, so they are
        // checked as for a sole holder. The analysis is the holding's, chosen above.
        checkParticulars(p);
        subclassification.push(
          subRow(ref, p.kind === 'organisation' ? 'Body corporate' : 'Individual', p),
        );
      }
      members.push({
        reference: ref,
        memberType: 'Joint holders (Individual or Body Corporate)',
        holderKey: key,
        trusteeType: '',
        title: '',
        name: parties.map((p) => p.fullName).join(' & '),
        idType: '',
        idNumber: '',
        passportExpiry: '',
        nationality: '',
        race: '',
        gender: '',
        dateOfBirth: '',
        address: emptyCells(),
        shares: shares.toString(),
        typesOfShares: typesOfSharesWording(kinds),
        analysis,
        partyIds: parties.map((p) => p.id),
      });
    } else if (parties[0]) {
      const p = parties[0];
      const org = p.kind === 'organisation';
      const v = particularsAt(p, asAt);
      const analysis = analysisFor(p, asAt);
      checkParticulars(p);
      if (org) {
        if (!analysis)
          missing(`${p.fullName}: record who controls it, for the shareholding analysis.`, {
            kind: 'person',
            id: p.id,
            keys: ['analysis'],
            roles: ['member'],
          });
      } else {
        if (!analysis && choosesAnalysis(p, asAt))
          missing(`${p.fullName}: choose the shareholding analysis.`, {
            kind: 'person',
            id: p.id,
            keys: ['analysis'],
            roles: ['member'],
          });
      }
      members.push({
        reference: ref,
        memberType: org ? 'Body corporate' : 'Individual',
        trusteeType: holder.trustee?.type ?? '',
        ...identityCells(p, asAt),
        ...(org ? ORGANISATION_BLANKS : {}),
        address: cellsOf(addressOf(v, org ? 'registered' : 'residential')),
        shares: shares.toString(),
        typesOfShares: typesOfSharesWording(kinds),
        analysis,
        partyIds: [p.id],
      });
      if (holder.trustee)
        subclassification.push({
          reference: ref,
          type: SUBCLASS_FOR_TRUSTEE[holder.trustee.type] ?? 'Individual',
          title: '',
          name: holder.trustee.subjectName,
          idType: holder.trustee.subjectIdType,
          idNumber: holder.trustee.subjectIdNumber,
          passportExpiry: '',
          nationality: holder.trustee.subjectNationality,
          race: '',
          gender: '',
          dateOfBirth: '',
          address: emptyCells(),
          partyIds: [],
        });
    }
  }
  return { data: { members, subclassification }, issues };
}

/**
 * Section F, for the app's check only (the workbook adds it up from E): shares by analysis, and
 * whether members' and treasury shares come to the shares issued.
 */
export function buildSectionF(ctx: BuildContext, members: MemberRow[]): Built<Ar1Data['f']> {
  const { input, holders, treasury, issuedTotal } = ctx;
  const { issues, blocker } = issueList('F');
  const byAnalysis = new Map<string, bigint>();
  for (const m of members)
    if (m.analysis)
      byAnalysis.set(m.analysis, (byAnalysis.get(m.analysis) ?? 0n) + BigInt(m.shares));
  const classified = [...byAnalysis.values()].reduce((n, s) => n + s, 0n);
  const held = [...holders.values()].reduce((n, h) => n + h.shares, 0n);
  const treasuryTotal = SHARE_KINDS.reduce((n, k) => n + treasury[k], 0n);
  if ((input.profile.shareClasses ?? []).length && held + treasuryTotal !== issuedTotal)
    blocker(
      `Members hold ${held.toLocaleString('en')} shares and treasury ${treasuryTotal.toLocaleString('en')}, but ${issuedTotal.toLocaleString('en')} are issued.`,
      { kind: 'shares' },
    );
  return {
    data: {
      byAnalysis: Object.fromEntries(
        ALL_ANALYSES.map((k) => [k, (byAnalysis.get(k) ?? 0n).toString()]),
      ),
      unclassified: (held - classified).toString(),
      total: held.toString(),
    },
    issues,
  };
}

/** Section G: the certificate, with (b) from the register and (h) from the appointments. */
export function buildSectionG(ctx: BuildContext): Built<Ar1Data['g']> {
  const { input, asAt, isPublic, officers } = ctx;
  const { record } = input;
  const { issues, missing } = issueList('G');
  const cert = record.answers.certificate;
  const transfers = transfersBetween(
    input.entries,
    record.firstReturn ? null : record.lastReturnDate,
    asAt,
  );
  const directorRels = officers.filter((r) => r.role === 'director');
  const anyNominee = directorRels.some((r) => appointmentAt(r, asAt)?.nominee);
  const nomineeStatus =
    cert.nomineeStatus ??
    (directorRels.length && directorRels.every((r) => appointmentAt(r, asAt))
      ? anyNominee
        ? 'Company has director(s) appointed as nominee director(s)'
        : 'None of the director(s) of the company is a nominee director'
      : null);
  const exempt = cert.boStatus === BO_EXEMPT;
  const g: Ar1Data['g'] = {
    unclaimedMoneys: cert.unclaimedMoneys ?? '',
    transfersRegistered: transfers.length ? 'Yes' : 'No',
    noPublicInvitation: cert.noPublicInvitation ?? '',
    overFifty: !isPublic ? (cert.overFifty ?? '') : '',
    overFiveHundred: isPublic ? (cert.overFiveHundred ?? '') : '',
    boStatus: cert.boStatus ?? '',
    boExemptCategory: exempt ? (cert.boExemptCategory ?? '') : '',
    nomineeStatus: nomineeStatus ?? '',
  };
  const answer = (field: string, message: string) => missing(message, { kind: 'answer', field });
  if (!g.unclaimedMoneys) answer('unclaimedMoneys', 'Answer certificate (a), unclaimed moneys.');
  if (!g.noPublicInvitation)
    answer('noPublicInvitation', 'Answer certificate (c), invitation to the public.');
  if (!isPublic && !g.overFifty)
    answer('overFifty', 'Answer certificate (d), members above fifty.');
  if (isPublic && !g.overFiveHundred)
    answer('overFiveHundred', 'Answer certificate (e), inspection facilities.');
  if (!g.boStatus) answer('boStatus', 'Answer certificate (f), beneficial owner status.');
  if (exempt && !g.boExemptCategory)
    answer('boExemptCategory', 'Answer certificate (g), the exempt category.');
  if (!g.nomineeStatus) answer('nomineeStatus', 'Answer certificate (h), nominee directors.');
  return { data: g, issues };
}
