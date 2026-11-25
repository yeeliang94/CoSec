import { readPackage, readText, type ZipPackage } from './zip';
import { cells, cellText, elements, sharedStrings, sheetParts } from './sheet';
import { FILING_ROWS, type FilingField, type FilingInfo } from '../../domain/ar1/build';

export const AR1_TAXONOMY = 'SSMxT_2022v1.0';

export class NotAnAr1Workbook extends Error {}

const DANGEROUS =
  'This workbook contains macros or embedded objects; save a fresh blank from mTool.';
/**
 * mTool v2.2's own AR1 blank carries ActiveX controls and two external links left over from SSM's
 * template, so exactly those are allowed (checked against every fixture in tests/fixtures/ar1):
 * controls of these two class ids, and external-book links to these two file names.
 */
const MTOOL_ACTIVEX = new Set([
  '{4C599241-6926-101B-9992-00000B65C6F9}',
  '{868FBE40-B964-453C-BEA2-77F32F2C294F}',
]);
const MTOOL_EXTERNAL_BOOKS = new Set([
  'CMA _table linkbase templates-updated.xlsx',
  'CMA _FVTPL I-file.xlsx',
]);

/** mTool's header picture is linked from its install folder (decoded, forward slashes, lower case). */
const MTOOL_IMAGE_FOLDER = 'file:///c:/ssm xbrl preparation tool/';
/**
 * The attributes of an open tag, read the way an XML parser reads them: either quote style,
 * spaces around `=`, and entity references decoded. Null when the text is not a plain list of
 * attributes (stray text, a repeated name, a character reference), so a form this reader cannot
 * be sure of is refused rather than skipped.
 */
export function readAttributes(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  const pattern = /\s*([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  while (at < text.length) {
    if (!/\S/.test(text.slice(at))) break;
    pattern.lastIndex = at;
    const m = pattern.exec(text);
    if (!m) return null;
    const raw = m[2] ?? m[3] ?? '';
    if (/&#/.test(raw) || out.has(m[1])) return null;
    out.set(
      m[1],
      raw
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    );
    at = pattern.lastIndex;
  }
  return out;
}

/**
 * A relationship target (as `readAttributes` returns it) with %-escapes decoded and forward
 * slashes, or null when it cannot be read safely.
 */
function localTarget(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f]/.test(decoded)) return null;
  return decoded.replace(/\\/g, '/');
}
/**
 * The shapes mTool's external links take: a relative path (`../../x.xlsx`), a path on the
 * current drive (`/Users/x.xlsx`), or `file:///C:/…` with a drive letter and no host. A host
 * (`//server/share`, `file://server/…`) or any other scheme (https, smb) is refused, since Excel
 * would contact it when the link updates.
 */
function isLocalPath(target: string) {
  if (target.startsWith('//')) return false;
  if (/^file:/i.test(target)) return /^file:\/\/\/[a-z]:\//i.test(target);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return /^[a-z]:\//i.test(target);
  return true;
}

/**
 * Refuses a workbook with macros, embedded OLE objects, or ActiveX controls and external links
 * other than those mTool's blank carries. The app re-serves the blank's other parts unchanged, so
 * anything active in them would reach whoever opens the filled file.
 */
export function assertSafeWorkbook(pkg: ZipPackage) {
  const refuse = () => new NotAnAr1Workbook(DANGEROUS);
  for (const { name } of pkg.entries) {
    if (/vbaProject|oleObject|(^|\/)embeddings\/|\.bin$/i.test(name)) {
      // ActiveX persistence and printer settings are the only binary parts mTool's blank has.
      if (!/^xl\/(activeX\/activeX|printerSettings\/printerSettings)\d+\.bin$/.test(name))
        throw refuse();
    }
    if (name.startsWith('xl/activeX/')) {
      if (!/^xl\/activeX\/(_rels\/activeX\d+\.xml\.rels|activeX\d+\.(xml|bin))$/.test(name))
        throw refuse();
      if (name.endsWith('.xml')) {
        const control = elements(readText(pkg, name), 'ax:ocx', { open: true }).next().value;
        const classid = control && readAttributes(control.attrs)?.get('ax:classid');
        if (!classid || !MTOOL_ACTIVEX.has(classid.toUpperCase())) throw refuse();
      }
    }
    if (name.startsWith('xl/externalLinks/')) {
      if (!/^xl\/externalLinks\/(_rels\/)?externalLink\d+\.xml(\.rels)?$/.test(name))
        throw refuse();
      if (!name.endsWith('.rels') && /<(oleLink|ddeLink)\b/.test(readText(pkg, name)))
        throw refuse();
    }
    // Every relationship that leaves the package, in any part: only mTool's own shapes pass.
    if (name.endsWith('.rels')) {
      const inExternalLink = name.startsWith('xl/externalLinks/_rels/');
      const rels = readText(pkg, name);
      // A prefixed element (`<r:Relationship>`) or a DOCTYPE would hide relationships from this
      // reader, and mTool writes neither.
      if (/<[\w.-]+:Relationships?\b|<!DOCTYPE|<!ENTITY/i.test(rels)) throw refuse();
      for (const r of elements(rels, 'Relationship', { open: true })) {
        const attrs = readAttributes(r.attrs);
        if (!attrs) throw refuse();
        const type = attrs.get('Type') ?? '';
        const mode = attrs.get('TargetMode');
        if (mode !== undefined && mode !== 'Internal' && mode !== 'External') throw refuse();
        const external = mode === 'External';
        const target = localTarget(attrs.get('Target') ?? '');
        if (inExternalLink) {
          if (!external || !type.endsWith('/externalLinkPath') || !target) throw refuse();
          if (!isLocalPath(target)) throw refuse();
          if (!MTOOL_EXTERNAL_BOOKS.has(target.split('/').pop() ?? '')) throw refuse();
        } else if (external) {
          if (!type.endsWith('/image') || !target) throw refuse();
          if (!target.toLowerCase().startsWith(MTOOL_IMAGE_FOLDER) || target.includes('/../'))
            throw refuse();
        }
      }
    }
  }
  if (!pkg.entries.some((e) => e.name === '[Content_Types].xml'))
    throw new NotAnAr1Workbook('This file is not an Excel workbook.');
  const types = readText(pkg, '[Content_Types].xml');
  if (/macroEnabled|vbaProject|oleObject/i.test(types)) throw refuse();
}

/** FilingInfo column E, rows 11 to 29, as stored in a workbook made by mTool. */
export function readFilingInfo(bytes: Buffer): Record<string, string> {
  let pkg;
  try {
    pkg = readPackage(bytes);
  } catch {
    throw new NotAnAr1Workbook('This file is not an Excel workbook.');
  }
  let path;
  try {
    path = sheetParts(pkg).get('FilingInfo');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The workbook has no'))
      throw new NotAnAr1Workbook('This file is not an Excel workbook.');
    throw error;
  }
  assertSafeWorkbook(pkg);
  if (!path)
    throw new NotAnAr1Workbook(
      'This workbook has no FilingInfo sheet, so it was not made by mTool.',
    );
  const strings = sharedStrings(pkg);
  const byRow = new Map(
    cells(readText(pkg, path))
      .filter((c) => c.col === 'E' && c.row >= 11 && c.row <= 29)
      .map((c) => [c.row, cellText(c, strings).trim()]),
  );
  const out: Record<string, string> = {};
  for (let row = 11; row <= 29; row++) out[`E${row}`] = byRow.get(row) ?? '';
  if (out.E24 !== 'AR1') throw new NotAnAr1Workbook('This workbook is not an AR1 annual return.');
  if (out.E28 !== AR1_TAXONOMY)
    throw new NotAnAr1Workbook(
      `This workbook uses taxonomy ${out.E28 || 'unknown'}, not ${AR1_TAXONOMY}.`,
    );
  return out;
}

const normalise = (field: FilingField, value: string) => {
  const v = value.trim().replace(/\s+/g, ' ');
  // mTool keeps the company name as typed, so case is ignored for the name only.
  return field === 'name' ? v.toUpperCase() : v;
};

export type FilingDifference = { field: FilingField; expected: string; actual: string };
/** Fields where the uploaded blank differs from the return; an empty cell counts as blank. */
export function compareFilingInfo(expected: FilingInfo, actual: Record<string, string>) {
  const out: FilingDifference[] = [];
  for (const [field, row] of Object.entries(FILING_ROWS) as [FilingField, number][]) {
    const found = actual[`E${row}`] ?? '';
    if (normalise(field, expected[field]) !== normalise(field, found))
      out.push({ field, expected: expected[field], actual: found });
  }
  return out;
}
