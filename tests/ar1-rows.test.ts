import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryBytes, readPackage, readText, writePackage } from '../src/server/ar1/zip';
import { cells, cellText, sharedStrings, sheetParts } from '../src/server/ar1/sheet';
import { addRows, type RowsRequest } from '../src/server/ar1/rows';

const fixture = (name: string) => readFileSync(`tests/fixtures/ar1/${name}`);
const adds = JSON.parse(readFileSync('tests/fixtures/ar1/adds-all.json', 'utf8')) as RowsRequest[];

/** Cell markup by reference, with the parts mTool and the port legitimately differ on removed. */
function cellMap(xml: string, strings: string[]) {
  // Text as Excel shows it: mTool saves shared strings and renumbers styles, code writes inline
  // strings, so only formulas and shown text are compared. A formula's cached result is ignored.
  return new Map(
    cells(xml).map((c) => [
      c.ref,
      { formula: c.formula, value: c.formula ? null : cellText(c, strings) },
    ]),
  );
}

describe('zip package', () => {
  it('writes back every part byte-identical when nothing changes', () => {
    const bytes = fixture('blank-first-return.xlsx');
    const pkg = readPackage(bytes);
    const again = readPackage(writePackage(pkg));
    expect(again.entries.map((e) => e.name)).toEqual(pkg.entries.map((e) => e.name));
    for (const [i, e] of pkg.entries.entries())
      expect(entryBytes(again.entries[i]).equals(entryBytes(e))).toBe(true);
  });
});

describe('adding rows', () => {
  it("matches mTool's own Typed Domain output on every visible table", () => {
    const pkg = readPackage(fixture('blank-first-return.xlsx'));
    const report = addRows(pkg, adds);
    expect(report).toHaveLength(adds.length);
    const ours = readPackage(writePackage(pkg));
    const theirs = readPackage(fixture('allrows-mtool.xlsx'));
    const parts = sheetParts(ours);
    const theirParts = sheetParts(theirs);
    const differences: string[] = [];
    for (const sheet of [
      'SectionA',
      'SectionB',
      'SectionC',
      'SectionD',
      'SectionE_ii',
      'SectionF',
      'SectionG',
    ]) {
      const a = cellMap(readText(ours, parts.get(sheet)!), sharedStrings(ours));
      const b = cellMap(readText(theirs, theirParts.get(sheet)!), sharedStrings(theirs));
      for (const ref of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(ref);
        const y = b.get(ref);
        // Excel saved some of mTool's formulas in shared form (an empty <f/> pointing at a master).
        if (x?.formula && y?.formula === '') continue;
        if (x?.formula !== y?.formula || (x?.value ?? '') !== (y?.value ?? ''))
          differences.push(`${sheet}!${ref}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      }
    }
    expect(differences).toEqual([]);
  });

  it('grows SectionF formulas to the added member rows and drops calcChain', () => {
    const pkg = readPackage(fixture('blank-first-return.xlsx'));
    addRows(pkg, [{ sheet: 'SectionE_ii', row: 12, add: 3 }]);
    const f = readText(pkg, sheetParts(pkg).get('SectionF')!);
    expect(f).toContain('SectionE_ii!Z12:Z16');
    expect(pkg.entries.some((e) => e.name === 'xl/calcChain.xml')).toBe(false);
    expect(readText(pkg, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
  });

  it('refuses a row that is not a member row', () => {
    const pkg = readPackage(fixture('blank-first-return.xlsx'));
    expect(() => addRows(pkg, [{ sheet: 'SectionC', row: 24, add: 1 }])).toThrow('member row');
  });
});
