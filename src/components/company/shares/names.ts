import type { Holder, ShareEntry } from '@/domain/ar1/shares';

/** The most ids GET /api/people takes in one `ids=` request (MAX_PEOPLE_IDS on the server). */
export const IDS_PER_REQUEST = 500;

export function holderName(holder: Holder | null, names: Map<string, string>) {
  if (!holder) return 'Treasury';
  const parties = holder.partyIds.map((id) => names.get(id) ?? 'Unknown').join(' and ');
  return holder.trustee ? `${parties} (trustee for ${holder.trustee.subjectName})` : parties;
}

/** Every party the register names, once each, in first-seen order. */
export function registerPartyIds(entries: Pick<ShareEntry, 'from' | 'to'>[]): string[] {
  const ids = new Set<string>();
  for (const e of entries)
    for (const holder of [e.from, e.to]) for (const id of holder?.partyIds ?? []) ids.add(id);
  return [...ids];
}

/** `/api/people?ids=` addresses for these ids, split so none exceeds the server's limit. */
export function peopleByIdUrls(ids: string[], size = IDS_PER_REQUEST): string[] {
  const urls: string[] = [];
  for (let i = 0; i < ids.length; i += size)
    urls.push('/api/people?ids=' + encodeURIComponent(ids.slice(i, i + size).join(',')));
  return urls;
}
