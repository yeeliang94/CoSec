import { isCalendarDate } from '../resolution/records';
import { TRUSTEE_TYPES } from './mtool-lists';

/** AR1 section B has one column per kind: ordinary, preference and other kinds of shares. */
export const SHARE_KINDS = ['Ordinary', 'Preference', 'Other'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export type ShareClass = { id: string; name: string; kind: ShareKind };
/** mTool's "Types of shares" wording for a member holding these kinds (section E(ii), column Y). */
export function typesOfSharesWording(kinds: Iterable<ShareKind>): string {
  const set = new Set(kinds);
  const parts = [
    set.has('Ordinary') ? 'Ordinary' : null,
    set.has('Preference') ? 'Preference' : null,
    set.has('Other') ? 'Other kinds of' : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join('/')} shares` : '';
}

export const CONSIDERATIONS = ['Cash', 'Otherwise than cash'] as const;
export type Consideration = (typeof CONSIDERATIONS)[number];
export type TrusteeType = (typeof TRUSTEE_TYPES)[number];

/**
 * Who holds shares: one person or organisation, or joint holders (several). A trustee holding
 * names the trustee as holder and records whom they hold for, as mTool's sub-classification does.
 */
export type Holder = {
  partyIds: string[];
  trustee?: {
    type: TrusteeType;
    subjectName: string;
    subjectIdType: string;
    subjectIdNumber: string;
    subjectNationality: string;
  } | null;
};
/**
 * A stable key for a holder, so the same joint holders or trust holding add up together. A trust
 * holding is keyed by its subject's ID number as well as the name, so two subjects with the same
 * name stay apart; spaces and hyphens in the number do not count.
 */
export function holderKey(holder: Holder): string {
  const parties = [...holder.partyIds].sort().join('+');
  if (!holder.trustee) return parties;
  const { type, subjectName, subjectIdNumber } = holder.trustee;
  const id = subjectIdNumber.replace(/[\s-]+/g, '').toUpperCase();
  return `${parties}#${type}#${subjectName.trim().toUpperCase()}#${id}`;
}

export const SHARE_ENTRY_KINDS = ['opening', 'allotment', 'transfer', 'buyback'] as const;
export type ShareEntryKind = (typeof SHARE_ENTRY_KINDS)[number];
export const SHARE_ENTRY_LABELS: Record<ShareEntryKind, string> = {
  opening: 'Opening balance',
  allotment: 'Allotment',
  transfer: 'Transfer',
  buyback: 'Buy-back to treasury',
};
export type ShareEntryStatus = 'Draft' | 'Posted' | 'Superseded' | 'Withdrawn';

/**
 * One dated register entry. Shares are whole numbers and amounts are MYR with up to two decimals,
 * both kept as strings so nothing is lost to floating point. Opening balances and allotments add
 * shares to `to`; transfers move them from `from` to `to`; a buy-back moves them from `from` into
 * treasury. Amounts apply to opening balances and allotments only.
 */
export type ShareEntry = {
  id: string;
  companyId: string;
  kind: ShareEntryKind;
  date: string;
  classId: string;
  shares: string;
  from: Holder | null;
  to: Holder | null;
  /** Total amount payable for the shares in this entry. */
  amountPayable: string | null;
  /** Total amount paid on them. */
  amountPaid: string | null;
  consideration: Consideration | null;
  /** Source resolution or document, required before posting. */
  sourceDocumentId: string | null;
  sourceCaseId: string | null;
  note: string;
  status: ShareEntryStatus;
  /** A correction replaces this posted entry when posted; `voids` removes it without a replacement. */
  predecessorId: string | null;
  voids: boolean;
  preparedBy: string;
  preparedAt: string;
  reviewerId: string | null;
  postedAt: string | null;
  revision: number;
};

// ---------------------------------------------------------------- arithmetic
const SHARES = /^\d{1,15}$/;
const MONEY = /^\d{1,15}(\.\d{1,2})?$/;
export const isShareCount = (value: string) => SHARES.test(value) && BigInt(value) > 0n;
export const isMoney = (value: string) => MONEY.test(value);
/** MYR as integer sen. */
export const sen = (value: string | null | undefined) => {
  if (!value || !isMoney(value)) return 0n;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
export const ringgit = (value: bigint) => {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${abs / 100n}.${fraction}`;
};

/** Within one date, entries that add shares replay before entries that move them out. */
const KIND_ORDER: Record<ShareEntryKind, number> = {
  opening: 0,
  allotment: 0,
  transfer: 1,
  buyback: 1,
};

/**
 * Posted entries in effect: corrections replace their predecessors; voiding corrections remove
 * them. Entries replay by date, then additions before transfers and buy-backs, then posting order.
 * A correction keeps the posting position of the entry it replaces (followed back through earlier
 * corrections), so correcting an opening balance does not move it behind a transfer that relies
 * on it. Pass superseded predecessors along with the entries so their positions can be found.
 */
export function effectiveEntries(entries: ShareEntry[]): ShareEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const positionOf = (entry: ShareEntry) => {
    let root = entry;
    const seen = new Set([root.id]);
    while (root.predecessorId) {
      const predecessor = byId.get(root.predecessorId);
      if (!predecessor || seen.has(predecessor.id)) break;
      seen.add(predecessor.id);
      root = predecessor;
    }
    return { postedAt: root.postedAt ?? entry.postedAt ?? '', id: root.id };
  };
  return entries
    .filter((e) => e.status === 'Posted' && !e.voids)
    .map((entry) => ({ entry, position: positionOf(entry) }))
    .sort(
      ({ entry: a, position: pa }, { entry: b, position: pb }) =>
        a.date.localeCompare(b.date) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        pa.postedAt.localeCompare(pb.postedAt) ||
        pa.id.localeCompare(pb.id) ||
        a.id.localeCompare(b.id),
    )
    .map(({ entry }) => entry);
}

export type Holding = { holder: Holder; key: string; classId: string; shares: bigint };
export type RegisterState = {
  /** Holdings with shares, by holder and class. */
  holdings: Holding[];
  /** Treasury shares by class. */
  treasury: Map<string, bigint>;
  /** Issued shares by class and consideration, and amounts payable and paid by class. */
  issued: Map<
    string,
    {
      cash: bigint;
      otherwise: bigint;
      payable: bigint;
      paid: bigint;
      fullyPaid: bigint;
      partlyPaid: bigint;
    }
  >;
};

export type ReplayProblem = { entryId: string; date: string; message: string };

/**
 * Replays posted entries up to and including `asAt` (all of them when null). Reports the first
 * entry that would leave a holder or treasury below zero, which posting must refuse.
 */
export function replay(entries: ShareEntry[], asAt: string | null = null) {
  const holdings = new Map<string, Holding>();
  const treasury = new Map<string, bigint>();
  const issued: RegisterState['issued'] = new Map();
  const problems: ReplayProblem[] = [];
  const add = (holder: Holder, classId: string, shares: bigint) => {
    const key = `${holderKey(holder)}|${classId}`;
    const current = holdings.get(key) ?? { holder, key: holderKey(holder), classId, shares: 0n };
    current.shares += shares;
    holdings.set(key, current);
    return current.shares;
  };
  for (const entry of effectiveEntries(entries)) {
    if (asAt && entry.date > asAt) break;
    const shares = BigInt(entry.shares);
    if (entry.kind === 'opening' || entry.kind === 'allotment') {
      add(entry.to!, entry.classId, shares);
      const totals = issued.get(entry.classId) ?? {
        cash: 0n,
        otherwise: 0n,
        payable: 0n,
        paid: 0n,
        fullyPaid: 0n,
        partlyPaid: 0n,
      };
      if (entry.consideration === 'Otherwise than cash') totals.otherwise += shares;
      else totals.cash += shares;
      const payable = sen(entry.amountPayable);
      const paid = sen(entry.amountPaid);
      totals.payable += payable;
      totals.paid += paid;
      if (paid >= payable) totals.fullyPaid += paid;
      else totals.partlyPaid += paid;
      issued.set(entry.classId, totals);
      continue;
    }
    const left = add(entry.from!, entry.classId, -shares);
    if (left < 0n)
      problems.push({
        entryId: entry.id,
        date: entry.date,
        message: 'The holder would have fewer shares than this entry moves.',
      });
    if (entry.kind === 'transfer') add(entry.to!, entry.classId, shares);
    else treasury.set(entry.classId, (treasury.get(entry.classId) ?? 0n) + shares);
  }
  return {
    state: {
      holdings: [...holdings.values()].filter((h) => h.shares !== 0n),
      treasury,
      issued,
    } satisfies RegisterState,
    problems,
  };
}

export type MemberInterval = {
  partyId: string;
  startDate: string;
  endDate: string | null;
  /** Entries on the start date that brought the party in, and on the end date that took them out. */
  entryIds: string[];
};

/**
 * Each party's holding intervals and the entries that opened and closed them, in one pass over
 * the effective entries. A party holds while any holding naming them has shares above zero.
 */
export function memberIntervalSources(entries: ShareEntry[]): MemberInterval[] {
  const holdings = new Map<string, bigint>();
  /** How many holdings above zero name each party. */
  const positive = new Map<string, number>();
  const open = new Map<string, { startDate: string; entryIds: string[] }>();
  const intervals: MemberInterval[] = [];
  const effective = effectiveEntries(entries);
  const change = (holder: Holder, classId: string, delta: bigint) => {
    const key = `${holderKey(holder)}|${classId}`;
    const before = holdings.get(key) ?? 0n;
    const after = before + delta;
    holdings.set(key, after);
    const step = (before <= 0n && after > 0n ? 1 : 0) - (before > 0n && after <= 0n ? 1 : 0);
    if (step)
      for (const partyId of holder.partyIds)
        positive.set(partyId, (positive.get(partyId) ?? 0) + step);
  };
  for (let i = 0; i < effective.length;) {
    const date = effective[i].date;
    /** Parties touched on this date, in order, with the entries that touched them. */
    const touched = new Map<string, Set<string>>();
    const touch = (holder: Holder | null, entryId: string) => {
      for (const partyId of holder?.partyIds ?? [])
        touched.set(partyId, (touched.get(partyId) ?? new Set()).add(entryId));
    };
    for (; i < effective.length && effective[i].date === date; i++) {
      const entry = effective[i];
      const shares = BigInt(entry.shares);
      if (entry.kind === 'opening' || entry.kind === 'allotment') {
        change(entry.to!, entry.classId, shares);
        touch(entry.to, entry.id);
        continue;
      }
      change(entry.from!, entry.classId, -shares);
      touch(entry.from, entry.id);
      if (entry.kind === 'transfer') {
        change(entry.to!, entry.classId, shares);
        touch(entry.to, entry.id);
      }
    }
    const opening: [string, string[]][] = [];
    for (const [partyId, entryIds] of touched) {
      const holds = (positive.get(partyId) ?? 0) > 0;
      const current = open.get(partyId);
      if (current && !holds) {
        intervals.push({
          partyId,
          startDate: current.startDate,
          endDate: date,
          entryIds: [...new Set([...current.entryIds, ...entryIds])],
        });
        open.delete(partyId);
      } else if (!current && holds) opening.push([partyId, [...entryIds]]);
    }
    for (const [partyId, entryIds] of opening) open.set(partyId, { startDate: date, entryIds });
  }
  for (const [partyId, current] of open) intervals.push({ partyId, endDate: null, ...current });
  return intervals;
}

/** Each party's holding intervals, for projecting member relationships. */
export function memberIntervals(entries: ShareEntry[]) {
  return memberIntervalSources(entries).map(({ partyId, startDate, endDate }) => ({
    partyId,
    startDate,
    endDate,
  }));
}

/** Transfers dated after `since` and on or before `asAt` (AR1 certificate (b)). */
export const transfersBetween = (entries: ShareEntry[], since: string | null, asAt: string) =>
  effectiveEntries(entries).filter(
    (e) => e.kind === 'transfer' && e.date <= asAt && (!since || e.date > since),
  );

/** Field checks for an entry before it is saved as a draft. */
export function validateShareEntry(
  entry: Pick<
    ShareEntry,
    | 'kind'
    | 'date'
    | 'classId'
    | 'shares'
    | 'from'
    | 'to'
    | 'amountPayable'
    | 'amountPaid'
    | 'consideration'
  >,
  classIds: string[],
): string[] {
  const out: string[] = [];
  if (!isCalendarDate(entry.date)) out.push('Enter the date of the entry.');
  if (!classIds.includes(entry.classId)) out.push('Choose a share class.');
  if (!isShareCount(entry.shares)) out.push('Enter the number of shares as a whole number.');
  const holderOk = (h: Holder | null) =>
    Boolean(h?.partyIds.length) && new Set(h!.partyIds).size === h!.partyIds.length;
  const adds = entry.kind === 'opening' || entry.kind === 'allotment';
  if ((adds || entry.kind === 'transfer') && !holderOk(entry.to))
    out.push('Choose who receives the shares.');
  if ((entry.kind === 'transfer' || entry.kind === 'buyback') && !holderOk(entry.from))
    out.push('Choose who the shares come from.');
  if (
    entry.kind === 'transfer' &&
    entry.from &&
    entry.to &&
    holderKey(entry.from) === holderKey(entry.to)
  )
    out.push('A transfer needs a different receiving holder.');
  if (adds) {
    if (!entry.amountPayable || !isMoney(entry.amountPayable))
      out.push('Enter the amount payable in MYR, for example 10000.00.');
    if (!entry.amountPaid || !isMoney(entry.amountPaid)) out.push('Enter the amount paid in MYR.');
    if (entry.amountPayable && entry.amountPaid && sen(entry.amountPaid) > sen(entry.amountPayable))
      out.push('The amount paid cannot be more than the amount payable.');
    if (!entry.consideration) out.push('Choose cash or otherwise than cash.');
  }
  for (const h of [entry.from, entry.to])
    if (h?.trustee) {
      if (h.partyIds.length !== 1) out.push('A trustee holding has one trustee.');
      if (!h.trustee.subjectName.trim())
        out.push('Enter the name of the member held in trust for.');
      if (!(TRUSTEE_TYPES as readonly string[]).includes(h.trustee.type))
        out.push('Choose the type of trustee.');
    }
  return out;
}
