import { readText, removePart, setText, hasPart, type ZipPackage } from './zip';
import {
  attr,
  elements,
  first as firstElement,
  mapAttr,
  mapElements,
  sharedStrings,
  sheetParts,
} from './sheet';

/**
 * Adds member rows to mTool AR1 tables the way mTool's Tool Box > Typed Domain does. A TypeScript
 * port of Data/injection-test/add_rows.py, which was checked cell by cell against mTool v2.2's
 * own output on all ten visible AR1 tables (13 Nov 2026):
 *  - a table is the rows between two hidden "#TABLE#" rows (column C); member rows carry a
 *    4-digit id in D; a table may hold a Total row above or below the members;
 *  - new rows go straight after the last member row as copies of it, with D the next id, E the
 *    id too when E held it, B empty, text-format cells "" and other values cleared; formulas move
 *    to the new row;
 *  - Total formulas over the members grow to cover the new rows;
 *  - everything below moves down (rows, merges, dimension, formulas, validations, conditional
 *    formats, hyperlinks), and formulas on other sheets that point into the sheet follow;
 *  - calcChain.xml is dropped and fullCalcOnLoad set, or Excel reports damaged content.
 * It refuses what it does not handle rather than guess.
 */
export class RowsRefused extends Error {}

export type RowsRequest = {
  sheet: string;
  /** Any member row of the table, numbered as in the input workbook. */
  row: number;
  add: number;
  /**
   * The blank's member row has no id (Section C's second table), so rows are copied without one
   * and the caller writes each row's No. in column D. Rows added this way passed mTool's
   * Validate on 17 November 2026 (see docs/research/mbrs-ar1-excel-filling.md).
   */
  idless?: boolean;
};

/** An A1 reference not preceded by a letter, digit, ! or quote, and not followed by ( or a letter. */
const REF_SOURCE = String.raw`(?<![A-Za-z0-9_!'"])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])`;
const refRe = () => new RegExp(REF_SOURCE, 'g');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shiftRefs(text: string, at: number, n: number) {
  return text.replace(refRe(), (_m, d1, col, d2, row) => {
    const r = Number(row);
    return `${d1}${col}${d2}${r > at ? r + n : r}`;
  });
}
function moveFormula(text: string, offset: number) {
  return text.replace(refRe(), (_m, d1, col, d2, row) => {
    const r = Number(row);
    return `${d1}${col}${d2}${d2 ? r : r + offset}`;
  });
}
function shiftSheetRefs(text: string, sheet: string, at: number, n: number) {
  const pat = new RegExp(
    `((?:'${escapeRe(sheet)}'|${escapeRe(sheet)})!)(\\$?[A-Z]{1,3}\\$?\\d+)(?::(\\$?[A-Z]{1,3}\\$?\\d+))?`,
    'g',
  );
  return text.replace(
    pat,
    (_m, prefix, a, b) => prefix + shiftRefs(a, at, n) + (b ? ':' + shiftRefs(b, at, n) : ''),
  );
}
function growTotal(text: string, first: number, last: number, newLast: number): string | null {
  const touches = [...text.matchAll(refRe())].some((m) => first <= +m[4] && +m[4] <= last);
  if (!touches) return text;
  const out = text.replace(
    /(?<![A-Za-z0-9_!$])([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)(?![\d(])/g,
    (m, c1, r1, c2, r2) =>
      c1 === c2 && +r1 === first && +r2 === last ? `${c1}${r1}:${c2}${newLast}` : m,
  );
  if (out !== text) return out;
  const lone = /^\s*([A-Z]{1,3})(\d+)\s*$/.exec(text);
  if (lone && first === last && last === +lone[2])
    return `SUM(${lone[1]}${first}:${lone[1]}${newLast})`;
  return null;
}
function growSqref(sqref: string, first: number, last: number, n: number) {
  return sqref
    .split(/\s+/)
    .map((part) => {
      const m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(part);
      if (!m) return part;
      const c1 = m[1];
      let r1 = +m[2];
      const c2 = m[3] ?? c1;
      let r2 = m[4] ? +m[4] : r1;
      if (first <= r1 && r1 <= last && first <= r2 && r2 <= last && r2 === last) r2 = last + n;
      else if (r1 > last) {
        r1 += n;
        r2 += n;
      } else if (r2 > last) r2 += n;
      return c1 === c2 && r1 === r2 ? `${c1}${r1}` : `${c1}${r1}:${c2}${r2}`;
    })
    .join(' ');
}

/** Each row's markup by row number; a forward-only scan, so a malformed sheet cannot backtrack. */
function rowsOf(xml: string) {
  const out = new Map<number, string>();
  for (const e of elements(xml, 'row')) {
    const r = /\br="(\d+)"/.exec(e.attrs);
    if (r) out.set(+r[1], xml.slice(e.start, e.end));
  }
  return out;
}
/**
 * The shown text of a row's cell in `col`. Every scan in this file goes through `elements` /
 * `mapElements` (forward-only, indexOf-based), so malformed markup cannot make it backtrack.
 */
function makeCellText(strings: string[]) {
  return (rowXml: string, col: string) => {
    let cell;
    for (const c of elements(rowXml, 'c')) {
      const ref = attr(c.attrs, 'r');
      if (ref && ref.startsWith(col) && /^\d/.test(ref.slice(col.length))) {
        cell = c;
        break;
      }
    }
    if (!cell) return '';
    const inner = cell.body ?? '';
    const v = firstElement(inner, 'v');
    if (attr(cell.attrs, 't') === 's' && v) return strings[+(v.body ?? '')] ?? '';
    const t = firstElement(inner, 't');
    return t ? (t.body ?? '') : v ? (v.body ?? '') : '';
  };
}
/** Applies `fn` to every formula's text and to its `ref` attribute (shared and array ranges). */
function rewriteFormulas(xml: string, fn: (text: string) => string) {
  return mapElements(xml, 'f', (f, markup) =>
    f.body === undefined ? markup : `<f${mapAttr(f.attrs, 'ref', fn)}>${fn(f.body)}</f>`,
  );
}
/** A row below `at` renumbered `n` down, with its cells. */
function shiftRow(rowXml: string, at: number, n: number) {
  const open = firstElement(rowXml, 'row');
  const r = Number(open ? attr(open.attrs, 'r') : NaN);
  if (!(r > at)) return rowXml;
  const renumber = mapElements(
    rowXml,
    'row',
    (e) => `<row${mapAttr(e.attrs, 'r', () => String(r + n))}${e.selfClosing ? '/' : ''}>`,
    { open: true },
  );
  return mapElements(
    renumber,
    'c',
    (e) =>
      `<c${mapAttr(e.attrs, 'r', (ref) => ref.replace(/\d+$/, String(r + n)))}${e.selfClosing ? '/' : ''}>`,
    { open: true },
  );
}
/** Replaces each listed row (by number) in one pass over the sheet. */
function replaceRows(xml: string, replace: (row: number, rowXml: string) => string) {
  return mapElements(xml, 'row', (e, markup) => {
    const r = Number(attr(e.attrs, 'r'));
    return Number.isFinite(r) ? replace(r, markup) : markup;
  });
}
/** An attribute holding a reference or range, rewritten on each `name` open tag. */
const mapRefAttr = (xml: string, name: string, key: string, fn: (value: string) => string) =>
  mapElements(
    xml,
    name,
    (e) => `<${name}${mapAttr(e.attrs, key, fn)}${e.selfClosing ? '/' : ''}>`,
    {
      open: true,
    },
  );

export type RowsReport = { sheet: string; firstRow: number; lastRow: number; added: number }[];

/** Adds rows to every requested table, in place on the package. */
export function addRows(pkg: ZipPackage, requests: RowsRequest[]): RowsReport {
  const paths = sheetParts(pkg);
  const strings = sharedStrings(pkg);
  const cellText = makeCellText(strings);
  const workbook = readText(pkg, 'xl/workbook.xml');
  const styles = readText(pkg, 'xl/styles.xml');
  const cellXfs = firstElement(styles, 'cellXfs');
  const xfs = [...elements(cellXfs?.body ?? '', 'xf')].map((e) =>
    (cellXfs?.body ?? '').slice(e.start, e.end),
  );
  const isTextFormat = (attrs: string) => {
    const s = /\bs="(\d+)"/.exec(attrs);
    return Boolean(s) && /numFmtId="49"/.test(xfs[+s![1]] ?? '');
  };
  const isMember = (rowXml: string) => /^\d{4}$/.test(cellText(rowXml, 'D'));
  const marker = (rows: Map<number, string>, r: number) =>
    rows.has(r) && cellText(rows.get(r)!, 'C') === '#TABLE#';
  const report: RowsReport = [];
  const bySheet = new Map<string, RowsRequest[]>();
  for (const r of requests)
    if (r.add > 0) bySheet.set(r.sheet, [...(bySheet.get(r.sheet) ?? []), r]);
  for (const [sheet, items] of bySheet) {
    const path = paths.get(sheet);
    if (!path) throw new RowsRefused(`Sheet ${sheet} is not in the workbook.`);
    for (const d of elements(workbook, 'definedName'))
      if ((d.body ?? '').includes(`${sheet}!`) || (d.body ?? '').includes(`${sheet}'!`))
        throw new RowsRefused(`${sheet} is used in a defined name.`);
    let xml = readText(pkg, path);
    let rows = rowsOf(xml);
    const tables = items.map((item) => {
      const row = item.row;
      if (!rows.has(row) || (!item.idless && !isMember(rows.get(row)!)))
        throw new RowsRefused(`${sheet} row ${row} is not a member row.`);
      let up = row;
      while (rows.has(up - 1) && !marker(rows, up - 1)) up--;
      let down = row;
      while (rows.has(down + 1) && !marker(rows, down + 1)) down++;
      if (!marker(rows, up - 1) || !marker(rows, down + 1))
        throw new RowsRefused(`${sheet} row ${row} is not inside a #TABLE# block.`);
      const block = [...Array(down - up + 1)].map((_, i) => up + i).filter((r) => rows.has(r));
      const members = item.idless ? [row] : block.filter((r) => isMember(rows.get(r)!));
      if (members.some((r, i) => i && r !== members[i - 1] + 1))
        throw new RowsRefused(`${sheet}: member rows are not contiguous.`);
      return {
        first: members[0],
        last: members.at(-1)!,
        ids: members.map((r) => cellText(rows.get(r)!, 'D')),
        others: block.filter((r) => !members.includes(r)),
        add: item.add,
        idless: Boolean(item.idless),
      };
    });
    if (new Set(tables.map((t) => t.last)).size !== tables.length)
      throw new RowsRefused(`${sheet}: the same table is listed twice.`);
    for (const t of tables.sort((a, b) => b.last - a.last)) {
      const { first, last, add: n } = t;
      const newLast = last + n;
      // 0. Formulas on other sheets that point into this one follow the insert.
      for (const [other, p] of paths) {
        if (other === sheet) continue;
        const ox = readText(pkg, p);
        const nx = rewriteFormulas(ox, (text) => shiftSheetRefs(text, sheet, last, n));
        if (nx !== ox) setText(pkg, p, nx);
      }
      // 1. Every formula in the sheet: references below the insert point move down.
      xml = rewriteFormulas(xml, (text) => shiftRefs(text, last, n));
      rows = rowsOf(xml);
      // 2. Move the rows below down, in one pass.
      xml = replaceRows(xml, (r, rowXml) => (r > last ? shiftRow(rowXml, last, n) : rowXml));
      // 3. Total formulas over the members grow to the new rows.
      const totals = new Set(t.others.map((r0) => (r0 > last ? r0 + n : r0)));
      xml = replaceRows(xml, (r, rowXml) =>
        totals.has(r)
          ? mapElements(rowXml, 'f', (f, markup) => {
              if (f.body === undefined) return markup;
              const g = growTotal(f.body, first, last, newLast);
              if (g === null)
                throw new RowsRefused(`${sheet} row ${r}: Total formula ${f.body} not understood.`);
              return `<f${f.attrs}>${g}</f>`;
            })
          : rowXml,
      );
      rows = rowsOf(xml);
      // 4. Insert copies of the last member row.
      const template = rows.get(last)!;
      const copyE = !t.idless && cellText(template, 'E') === cellText(template, 'D');
      const nextId = t.idless ? 0 : Math.max(...t.ids.map(Number)) + 1;
      let added = '';
      for (let k = 0; k < n; k++) {
        const newRow = last + k + 1;
        const id = String(nextId + k).padStart(4, '0');
        const renumbered = mapElements(
          template,
          'row',
          (e) => `<row${mapAttr(e.attrs, 'r', () => String(newRow))}${e.selfClosing ? '/' : ''}>`,
          { open: true },
        );
        added += mapElements(renumbered, 'c', (e) => {
          const col = /^([A-Z]+)\d+$/.exec(attr(e.attrs, 'r') ?? '')?.[1];
          if (!col) throw new RowsRefused(`${sheet} row ${last}: a cell has no reference.`);
          const attrs = e.attrs.replace(/\s+r="[A-Z]+\d+"/, '').replace(/\s+t="[^"]*"/, '');
          const ref = `r="${col}${newRow}"`;
          if (!t.idless && (col === 'D' || (col === 'E' && copyE)))
            return `<c ${ref}${attrs} t="inlineStr"><is><t>${id}</t></is></c>`;
          const fm = firstElement(e.body ?? '', 'f');
          if (fm) {
            if (fm.selfClosing || /t="shared"/.test(fm.attrs))
              throw new RowsRefused(`Shared formula in ${col}${last}; not handled.`);
            return `<c ${ref}${attrs}><f>${moveFormula(fm.body ?? '', newRow - last)}</f><v>0</v></c>`;
          }
          if (!['A', 'B', 'C'].includes(col) && isTextFormat(attrs))
            return `<c ${ref}${attrs} t="inlineStr"><is><t></t></is></c>`;
          return `<c ${ref}${attrs}/>`;
        });
      }
      xml = replaceRows(xml, (r, rowXml) => (r === last ? rowXml + added : rowXml));
      // 5. Merges, dimension, validations, conditional formats, hyperlinks.
      const shifted = (value: string) => shiftRefs(value, last, n);
      const grown = (value: string) => growSqref(value, first, last, n);
      xml = mapRefAttr(xml, 'mergeCell', 'ref', shifted);
      xml = mapRefAttr(xml, 'dimension', 'ref', shifted);
      xml = mapRefAttr(xml, 'dataValidation', 'sqref', grown);
      xml = mapRefAttr(xml, 'conditionalFormatting', 'sqref', grown);
      xml = mapRefAttr(xml, 'hyperlink', 'ref', shifted);
      rows = rowsOf(xml);
      report.push({ sheet, firstRow: first, lastRow: last, added: n });
    }
    setText(pkg, path, xml);
  }
  if (report.length) dropCalcChain(pkg);
  return report;
}

/** Moving formula cells makes calcChain stale; drop it and ask Excel to recalculate on open. */
export function dropCalcChain(pkg: ZipPackage) {
  if (hasPart(pkg, 'xl/calcChain.xml')) {
    removePart(pkg, 'xl/calcChain.xml');
    setText(
      pkg,
      'xl/_rels/workbook.xml.rels',
      readText(pkg, 'xl/_rels/workbook.xml.rels').replace(
        /<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g,
        '',
      ),
    );
    setText(
      pkg,
      '[Content_Types].xml',
      readText(pkg, '[Content_Types].xml').replace(
        /<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g,
        '',
      ),
    );
  }
  const workbook = readText(pkg, 'xl/workbook.xml');
  const next = workbook.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, attrs: string, close: string) => {
    const cleaned = attrs.replace(/\s+fullCalcOnLoad="[^"]*"/, '');
    return `<calcPr${cleaned} fullCalcOnLoad="1"${close}>`;
  });
  if (next !== workbook) setText(pkg, 'xl/workbook.xml', next);
}
