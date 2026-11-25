import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPackage, readText, setText, writePackage, type ZipEntry } from '../src/server/ar1/zip';
import { cells, sharedStrings, sheetParts, writeCells } from '../src/server/ar1/sheet';
import { addRows } from '../src/server/ar1/rows';
import { assertBlankTables, fillWorkbook, readBack } from '../src/server/ar1/fill';
import { assertSafeWorkbook, readFilingInfo } from '../src/server/ar1/filing-info';
import { sample } from './ar1-fill.test';

const fixture = (name: string) => readFileSync(`tests/fixtures/ar1/${name}`);
const blank = fixture('blank-first-return.xlsx');
const entry = (name: string, content: Buffer): ZipEntry => ({
  name,
  method: 8,
  crc: 0,
  size: content.length,
  raw: Buffer.alloc(0),
  data: content,
  time: 0,
  date: 0,
  flags: 0,
});
/** The blank with `edit` applied to its package, written out again. */
const altered = (edit: (entries: ZipEntry[]) => void) => {
  const pkg = readPackage(blank);
  edit(pkg.entries);
  return writePackage(pkg);
};

describe('reading an uploaded package', () => {
  it('refuses an entry that inflates beyond its declared size', () => {
    const pkg = readPackage(blank);
    const strings = pkg.entries.find((e) => e.name === 'xl/sharedStrings.xml')!;
    // Declares its real size but holds 8 MiB of compressed zeros instead.
    strings.raw = deflateRawSync(Buffer.alloc(8 * 1024 * 1024));
    const again = readPackage(writePackage(pkg));
    expect(() => readText(again, 'xl/sharedStrings.xml')).toThrow('damaged');
  });

  it('refuses an XML part over 16 MiB before inflating it', () => {
    const big = Buffer.alloc(17 * 1024 * 1024, 0x20);
    const pkg = readPackage(altered((entries) => entries.push(entry('xl/big.xml', big))));
    expect(() => readText(pkg, 'xl/big.xml')).toThrow('too large');
  });

  it('scans malformed markup in linear time', () => {
    const unclosed = '<si><t>x'.repeat(200_000);
    const pkg = readPackage(
      altered((entries) => {
        const i = entries.findIndex((e) => e.name === 'xl/sharedStrings.xml');
        entries[i] = entry('xl/sharedStrings.xml', Buffer.from(`<sst>${unclosed}</sst>`));
      }),
    );
    let started = performance.now();
    sharedStrings(pkg);
    expect(performance.now() - started).toBeLessThan(1000);
    started = performance.now();
    cells(`<sheetData>${'<row r="1"><c r="A1" t="s"><v>1'.repeat(200_000)}</sheetData>`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('writing cells', () => {
  const sheet =
    '<worksheet><sheetData><row r="1"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1" s="4"/>' +
    '<c r="C1"><f>A1</f><v>0</v></c></row></sheetData></worksheet>';
  it('keeps the style, replaces the type and escapes text', () => {
    const out = writeCells(
      sheet,
      new Map([
        ['A1', { kind: 'text', text: 'A & <B>' }],
        ['B1', { kind: 'number', number: '12.5' }],
      ]),
    );
    expect(out).toContain(
      '<c r="A1" s="3" t="inlineStr"><is><t xml:space="preserve">A &amp; &lt;B&gt;</t></is></c>',
    );
    expect(out).toContain('<c r="B1" s="4"><v>12.5</v></c>');
  });
  it('refuses a formula cell and a cell the template does not have', () => {
    expect(() => writeCells(sheet, new Map([['C1', { kind: 'text', text: 'x' }]]))).toThrow(
      'Cell C1 holds a formula.',
    );
    expect(() => writeCells(sheet, new Map([['D1', { kind: 'text', text: 'x' }]]))).toThrow(
      'Cell D1 is not in the template.',
    );
  });
});

describe('control characters', () => {
  it('are removed before a value is recorded as written, so the read-back matches', () => {
    const data = structuredClone(sample);
    data.d.directors[0].name = 'DIRECTOR\u000b ONE\u0001 (FICTIONAL)';
    const { bytes, written } = fillWorkbook(blank, data);
    expect(written.find((w) => w.sheet === 'SectionD' && w.cell === 'F12')?.value).toBe(
      'DIRECTOR ONE (FICTIONAL)',
    );
    expect(readBack(bytes, written)).toEqual([]);
  });
});

describe('macros and embedded objects', () => {
  const message =
    'This workbook contains macros or embedded objects; save a fresh blank from mTool.';
  it("allows exactly what mTool's own workbooks carry", () => {
    for (const name of [
      'blank-first-return.xlsx',
      'blank-second.xlsx',
      'handfill.xlsx',
      'allrows-mtool.xlsx',
    ])
      expect(() => assertSafeWorkbook(readPackage(fixture(name))), name).not.toThrow();
    expect(readFilingInfo(blank).E24).toBe('AR1');
  });
  it('refuses a macro project, an OLE object, another control or another external link', () => {
    const cases: ((entries: ZipEntry[]) => void)[] = [
      (e) => e.push(entry('xl/vbaProject.bin', Buffer.from('macro'))),
      (e) => e.push(entry('xl/embeddings/oleObject1.bin', Buffer.from('ole'))),
      (e) => {
        const i = e.findIndex((x) => x.name === 'xl/activeX/activeX1.xml');
        e[i] = entry(
          'xl/activeX/activeX1.xml',
          Buffer.from('<ax:ocx ax:classid="{00000000-0000-0000-0000-000000000001}"/>'),
        );
      },
      (e) => {
        const i = e.findIndex((x) => x.name === 'xl/externalLinks/_rels/externalLink1.xml.rels');
        e[i] = entry(
          'xl/externalLinks/_rels/externalLink1.xml.rels',
          Buffer.from(
            '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/evil.xlsm" TargetMode="External"/></Relationships>',
          ),
        );
      },
    ];
    for (const edit of cases) {
      const bytes = altered(edit);
      expect(() => readFilingInfo(bytes)).toThrow(message);
      expect(() => fillWorkbook(bytes, sample)).toThrow(message);
    }
  });
});

describe('adding rows to a malformed sheet', () => {
  it('runs in linear time on unclosed formulas and validation ranges', () => {
    const junk = '<f>A1'.repeat(20_000) + '<dataValidation sqref="A1 '.repeat(20_000);
    const pkg = readPackage(blank);
    const path = sheetParts(pkg).get('SectionE_ii')!;
    const sheet = readText(pkg, path);
    setText(pkg, path, sheet.replace('</worksheet>', `${junk}</worksheet>`));
    const started = performance.now();
    addRows(pkg, [{ sheet: 'SectionE_ii', row: 12, add: 3 }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('links that leave the workbook', () => {
  const message =
    'This workbook contains macros or embedded objects; save a fresh blank from mTool.';
  /** The blank with the first external Target in `part` replaced. */
  const retarget = (part: (name: string) => boolean, target: string) =>
    altered((entries) => {
      const i = entries.findIndex((e) => part(e.name));
      const pkg = readPackage(blank);
      const xml = readText(pkg, entries[i].name);
      entries[i] = entry(
        entries[i].name,
        Buffer.from(xml.replace(/Target="[^"]*"( TargetMode="External")/, `Target="${target}"$1`)),
      );
    });
  const link = (name: string) => name === 'xl/externalLinks/_rels/externalLink2.xml.rels';
  it('refuses an external link to another host or scheme', () => {
    for (const target of [
      'file://evil.example/share/CMA%20_FVTPL%20I-file.xlsx',
      'https://evil.example/CMA%20_FVTPL%20I-file.xlsx',
      String.raw`\\evil.example\share\CMA%20_FVTPL%20I-file.xlsx`,
      '//evil.example/share/CMA%20_FVTPL%20I-file.xlsx',
    ])
      expect(() => readFilingInfo(retarget(link, target)), target).toThrow(message);
    // mTool's own shape, on a local drive, is still accepted.
    expect(() =>
      readFilingInfo(retarget(link, 'file:///C:/Users/x/CMA%20_FVTPL%20I-file.xlsx')),
    ).not.toThrow();
  });
  it('refuses an external picture outside mTool’s install folder', () => {
    const drawing = (name: string) =>
      name.startsWith('xl/drawings/_rels/') &&
      readText(readPackage(blank), name).includes('TargetMode="External"');
    for (const target of [
      'file://evil.example/share/Templateheader.png',
      'https://evil.example/Templateheader.png',
      String.raw`file:///C:\Other\Templateheader.png`,
      String.raw`file:///C:\SSM%20XBRL%20Preparation%20Tool\..\..\Other\x.png`,
    ])
      expect(() => readFilingInfo(retarget(drawing, target)), target).toThrow(message);
  });
  it('reads relationship attributes in any quote style or spacing', () => {
    const rels = (xml: string) =>
      altered((entries) => {
        const i = entries.findIndex((e) => e.name === 'xl/_rels/workbook.xml.rels');
        const pkg = readPackage(blank);
        const before = readText(pkg, entries[i].name);
        entries[i] = entry(
          entries[i].name,
          Buffer.from(before.replace('</Relationships>', `${xml}</Relationships>`)),
        );
      });
    const image = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
    for (const xml of [
      `<Relationship Id='rId90' Type='${image}' Target='https://evil.example/x.png' TargetMode='External'/>`,
      `<Relationship Id="rId90" Type="${image}" Target="https://evil.example/x.png" TargetMode = "External"/>`,
      `<Relationship Id="rId90" Type="${image}" Target="https://evil.example/x.png" TargetMode="&#69;xternal"/>`,
      `<Relationship Id="rId90" Type="${image}" Target="https://evil.example/x.png" TargetMode="external"/>`,
      `<Relationship Id="rId90" Type="${image}" Target="x.png" TargetMode="External" TargetMode="Internal"/>`,
      `<r:Relationship xmlns:r="x" Id="rId90" Type="${image}" Target="https://evil.example/x.png" TargetMode="External"/>`,
    ])
      expect(() => readFilingInfo(rels(xml)), xml).toThrow(message);
  });
});

describe('a workbook with rows already added in mTool', () => {
  it('is refused, since every position is counted from the blank', () => {
    const message = 'This workbook already has rows added in mTool.';
    const expanded = fixture('allrows-mtool.xlsx');
    expect(() => assertBlankTables(readPackage(expanded))).toThrow(message);
    expect(() => fillWorkbook(expanded, sample)).toThrow(message);
    for (const name of ['blank-first-return.xlsx', 'blank-second.xlsx', 'handfill.xlsx'])
      expect(() => assertBlankTables(readPackage(fixture(name))), name).not.toThrow();
    // A filled workbook is refused too, so it cannot be filled a second time.
    expect(() => assertBlankTables(readPackage(fillWorkbook(blank, sample).bytes))).toThrow(
      message,
    );
  });
});
