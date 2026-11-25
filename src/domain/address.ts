import { COUNTRIES, STATES } from './ar1/mtool-lists';

/**
 * One address model for people, companies, branches and the AR1 workbook. Addresses are kept in
 * mTool's AR1 parts; Malaysian addresses also need a five-digit postcode, the town and the state.
 */
export const ADDRESS_PARTS = [
  'Line1',
  'Line2',
  'Line3',
  'Postcode',
  'Town',
  'State',
  'Country',
] as const;
export type AddressPart = (typeof ADDRESS_PARTS)[number];
export type Address = Record<AddressPart, string>;
export type AddressProblem = { part: AddressPart; message: string };

const MALAYSIA = 'MALAYSIA';

export const emptyAddress = (): Address =>
  Object.fromEntries(ADDRESS_PARTS.map((p) => [p, ''])) as Address;

/** "1 Jalan Example, Taman Contoh, 47000 Sungai Buloh, SELANGOR, MALAYSIA", on one line. */
export function formatAddress(address: Address): string {
  const town = [address.Postcode, address.Town].filter(Boolean).join(' ');
  return [address.Line1, address.Line2, address.Line3, town, address.State, address.Country]
    .filter(Boolean)
    .join(', ');
}
/** The same one-line form; kept for the company screens that call it this. */
export const joinAddress = formatAddress;

export const isAddressEmpty = (address: Address) => !Object.values(address).some(Boolean);

/** The parts mTool requires: line 1 and the country, and in Malaysia the postcode, town and state. */
export function requiredAddressParts(address: Pick<Address, 'Country'>): AddressPart[] {
  return address.Country === MALAYSIA
    ? ['Line1', 'Country', 'Postcode', 'Town', 'State']
    : ['Line1', 'Country'];
}

/**
 * What mTool would reject in a filled-in address, by part. An empty address has no problems here;
 * callers decide whether the address is needed at all. `label` names the address in the messages
 * ("Enter line 1 of the residential address."). `checkLists: false` skips the country and state
 * list checks for callers that check every listed value themselves.
 */
export function addressProblems(
  address: Address,
  { label, checkLists = true }: { label?: string; checkLists?: boolean } = {},
): AddressProblem[] {
  if (isAddressEmpty(address)) return [];
  const of = label ? ` of the ${label}` : '';
  const out: AddressProblem[] = [];
  if (!address.Line1) out.push({ part: 'Line1', message: `Enter line 1${of}.` });
  if (!address.Country) out.push({ part: 'Country', message: `Choose the country${of}.` });
  else if (checkLists && !(COUNTRIES as readonly string[]).includes(address.Country))
    out.push({ part: 'Country', message: 'Choose one of the listed countries.' });
  if (address.Country === MALAYSIA) {
    if (!/^\d{5}$/.test(address.Postcode))
      out.push({ part: 'Postcode', message: 'Enter a five-digit postcode.' });
    if (!address.Town) out.push({ part: 'Town', message: `Enter the town${of}.` });
    if (!address.State) out.push({ part: 'State', message: `Choose the state${of}.` });
  }
  if (checkLists && address.State && !(STATES as readonly string[]).includes(address.State))
    out.push({ part: 'State', message: 'Choose one of the listed states.' });
  return out;
}

/** Whether an address is filled in and has nothing mTool would reject. */
export const isAddressComplete = (address: Address) =>
  !isAddressEmpty(address) && !addressProblems(address).length;
