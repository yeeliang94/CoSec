import { MSIC_CODES } from '../../domain/ar1/msic-codes';

/** mTool's MSIC 2008 list, server side only (it is about 160 KB). */
const BY_CODE = new Map(MSIC_CODES.map(([code, description]) => [code, description]));

export const isMsic = (code: string) => BY_CODE.has(code.trim());
export const msicDescription = (code: string) => BY_CODE.get(code.trim()) ?? null;

/** Codes whose code or description contains every word of `query`, up to `limit`. */
export function searchMsic(query: string, limit = 30) {
  const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: { code: string; description: string }[] = [];
  for (const [code, description] of MSIC_CODES) {
    const text = `${code} ${description}`.toUpperCase();
    if (words.every((w) => text.includes(w))) out.push({ code, description });
    if (out.length >= limit) break;
  }
  return out;
}
