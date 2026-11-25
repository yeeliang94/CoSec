import { ringgit, sen } from './shares';

/**
 * MYR for reading, with thousands separators and two decimals: "1,234,567.50". Takes an amount as
 * stored ("1234567.5") or as integer sen. Exact for any size, unlike formatting a JavaScript number.
 */
export function formatMyr(value: string | bigint): string {
  const text = ringgit(typeof value === 'bigint' ? value : sen(value));
  const [whole, fraction] = text.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
