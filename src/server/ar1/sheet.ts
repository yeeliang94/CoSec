import { readText, type ZipPackage } from './zip';

/**
 * Small, surgical helpers over SpreadsheetML text. They never parse and re-serialise a whole
 * sheet, because mTool depends on markup (protection, activeX links, x14ac attributes) that a
 * round trip through a DOM library can change.
 *
 * Every scan here is indexOf-based and moves forward only, so its cost is linear in the part's
 * length even when an uploaded part is malformed (an unclosed tag cannot make it backtrack).
 */
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Characters XML 1.0 does not allow, so they can be neither written nor read back. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
/** Text as it can be stored in a cell: XML-disallowed control characters removed. */
export const cleanText = (s: string) => s.replace(CONTROL, '');
export const escapeXml = (s: string) =>
  cleanText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // A literal carriage return would be normalised to a line feed by the reader.
    .replace(/\r/g, '&#13;');

export type Element = {
  /** Offset of `<` and the offset just past the element's end. */
  start: number;
  end: number;
  /** Text between the tag name and `>` (without a self-closing `/`). */
  attrs: string;
  /** Content between the open and close tags; undefined for a self-closing element. */
  body: string | undefined;
  /** Written as `<name …/>`. */
  selfClosing: boolean;
};

/**
 * Each `<name …>…</name>` or `<name …/>` element in `xml[from, to)`, in document order. The tag
 * name must be followed by whitespace, `>` or `/`, so `c` does not match `<col>`. Elements of the
 * same name must not nest (true for every element read here). With `open: true` only the open tag
 * is read, for elements whose content is not needed.
 */
export function* elements(
  xml: string,
  name: string,
  options: { from?: number; to?: number; open?: boolean } = {},
): Generator<Element> {
  const to = options.to ?? xml.length;
  const openTag = `<${name}`;
  const closeTag = `</${name}>`;
  let at = options.from ?? 0;
  while (at < to) {
    const start = xml.indexOf(openTag, at);
    if (start < 0 || start >= to) return;
    const next = xml[start + openTag.length];
    if (
      next !== '>' &&
      next !== '/' &&
      next !== ' ' &&
      next !== '\t' &&
      next !== '\r' &&
      next !== '\n'
    ) {
      at = start + openTag.length;
      continue;
    }
    const gt = xml.indexOf('>', start);
    if (gt < 0 || gt >= to) return;
    const selfClosing = xml[gt - 1] === '/';
    const attrs = xml.slice(start + openTag.length, selfClosing ? gt - 1 : gt);
    if (selfClosing || options.open) {
      yield { start, end: gt + 1, attrs, body: undefined, selfClosing };
      at = gt + 1;
      continue;
    }
    const close = xml.indexOf(closeTag, gt + 1);
    if (close < 0 || close >= to) return;
    yield {
      start,
      end: close + closeTag.length,
      attrs,
      body: xml.slice(gt + 1, close),
      selfClosing: false,
    };
    at = close + closeTag.length;
  }
}
/**
 * Rebuilds `xml` in one pass, replacing each `name` element (or, with `open: true`, each open
 * tag) by what `fn` returns for it. Linear in the length of `xml`.
 */
export function mapElements(
  xml: string,
  name: string,
  fn: (e: Element, markup: string) => string,
  options: { open?: boolean } = {},
): string {
  const out: string[] = [];
  let at = 0;
  for (const e of elements(xml, name, options)) {
    out.push(xml.slice(at, e.start), fn(e, xml.slice(e.start, e.end)));
    at = e.end;
  }
  if (!out.length) return xml;
  out.push(xml.slice(at));
  return out.join('');
}
export const first = (xml: string, name: string) =>
  elements(xml, name).next().value as Element | undefined;
const attrPatterns = new Map<string, RegExp>();
const attrPattern = (name: string) => {
  let re = attrPatterns.get(name);
  if (!re) attrPatterns.set(name, (re = new RegExp(`(^|\\s)${name}="([^"]*)"`)));
  return re;
};
export const attr = (attrs: string, name: string) => attrPattern(name).exec(attrs)?.[2];
/** `attrs` with the value of attribute `name` replaced by `fn(value)`; unchanged if absent. */
export const mapAttr = (attrs: string, name: string, fn: (value: string) => string) =>
  attrs.replace(
    attrPattern(name),
    (_m, space: string, value: string) => `${space}${name}="${fn(value)}"`,
  );
/** The text of every `<t>` run, joined, as Excel shows a rich or plain string. */
const runs = (xml: string) => [...elements(xml, 't')].map((t) => decode(t.body ?? '')).join('');

/** Sheet name to part path, from workbook.xml and its relationships. */
export function sheetParts(pkg: ZipPackage): Map<string, string> {
  const workbook = readText(pkg, 'xl/workbook.xml');
  const rels = readText(pkg, 'xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  for (const r of elements(rels, 'Relationship', { open: true })) {
    const id = attr(r.attrs, 'Id');
    const target = attr(r.attrs, 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const out = new Map<string, string>();
  for (const sh of elements(workbook, 'sheet', { open: true })) {
    const name = attr(sh.attrs, 'name');
    const rid = attr(sh.attrs, 'r:id');
    if (name && rid && targets.has(rid)) out.set(decode(name), targets.get(rid)!);
  }
  return out;
}

export function sharedStrings(pkg: ZipPackage): string[] {
  let xml: string;
  try {
    xml = readText(pkg, 'xl/sharedStrings.xml');
  } catch (error) {
    if (error instanceof Error && error.message.includes('has no')) return [];
    throw error;
  }
  return [...elements(xml, 'si')].map((si) => runs(si.body ?? ''));
}

export type Cell = {
  ref: string;
  col: string;
  row: number;
  /** The whole `<c …>…</c>` or `<c …/>` markup. */
  xml: string;
  style: string | null;
  type: string | null;
  formula: string | null;
  value: string | null;
};

export function parseCell(xml: string, attrs: string, body: string | undefined): Cell {
  const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
  if (!ref) throw new Error('A cell has no reference.');
  const formula = body ? first(body, 'f') : undefined;
  const v = body ? first(body, 'v') : undefined;
  const inline = body ? first(body, 'is') : undefined;
  return {
    ref: ref[1] + ref[2],
    col: ref[1],
    row: Number(ref[2]),
    xml,
    style: /\bs="(\d+)"/.exec(attrs)?.[1] ?? null,
    type: /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null,
    formula: formula ? decode(formula.body ?? '') : null,
    value: inline ? runs(inline.body ?? '') : v ? decode(v.body ?? '') : null,
  };
}

/** Where `<sheetData>`'s content starts and ends; the whole text when there is none. */
function sheetDataRange(sheetXml: string) {
  const open = sheetXml.indexOf('<sheetData>');
  if (open < 0) return { from: 0, to: 0 };
  const from = open + '<sheetData>'.length;
  const close = sheetXml.indexOf('</sheetData>', from);
  return { from, to: close < 0 ? sheetXml.length : close };
}

/** Every cell of a sheet, in document order. */
export function cells(sheetXml: string): Cell[] {
  const range = sheetDataRange(sheetXml);
  return [...elements(sheetXml, 'c', range)].map((e) =>
    parseCell(sheetXml.slice(e.start, e.end), e.attrs, e.body),
  );
}

/** A cell's text as Excel shows it: shared strings resolved, inline strings read. */
export function cellText(cell: Cell | undefined, strings: string[]): string {
  if (!cell || cell.value == null) return '';
  if (cell.type === 's') return strings[Number(cell.value)] ?? '';
  return cell.value;
}

export const colNumber = (col: string) =>
  [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colName = (n: number) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export type CellValue =
  { kind: 'text'; text: string } | { kind: 'number'; number: number | string };

/**
 * Writes values into existing cells in one pass over the sheet, keeping each cell's style. Text
 * is written as an inline string; a number as a plain value. A formula cell is refused, and so is
 * a cell that does not exist, since every input cell exists in mTool's template.
 */
export function writeCells(sheetXml: string, values: ReadonlyMap<string, CellValue>): string {
  if (!values.size) return sheetXml;
  const range = sheetDataRange(sheetXml);
  const out: string[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (const e of elements(sheetXml, 'c', range)) {
    const ref = attr(e.attrs, 'r');
    const value = ref === undefined ? undefined : values.get(ref);
    if (!ref || !value) continue;
    if (e.body && /<f\b/.test(e.body)) throw new Error(`Cell ${ref} holds a formula.`);
    const attrs = e.attrs.replace(/\s+t="[^"]*"/, '');
    const markup =
      value.kind === 'text'
        ? value.text === ''
          ? `<c${attrs} t="inlineStr"><is><t></t></is></c>`
          : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value.text)}</t></is></c>`
        : `<c${attrs}><v>${value.number}</v></c>`;
    out.push(sheetXml.slice(at, e.start), markup);
    at = e.end;
    seen.add(ref);
  }
  for (const ref of values.keys())
    if (!seen.has(ref)) throw new Error(`Cell ${ref} is not in the template.`);
  out.push(sheetXml.slice(at));
  return out.join('');
}

/** Writes one value; see `writeCells`, which callers writing many cells should use. */
export function writeCell(sheetXml: string, ref: string, value: CellValue): string {
  return writeCells(sheetXml, new Map([[ref, value]]));
}
