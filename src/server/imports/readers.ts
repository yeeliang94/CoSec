import { PDFDocument } from 'pdf-lib';
import type { FileKind } from '../../domain/imports';

/**
 * Opens client files inside the app. Text from Word, Excel and digital PDFs is extracted here
 * and sent as text. Scanned PDFs and photos are sent to the model as the file itself, a few
 * pages at a time, and the model reads them by eye; nothing is drawn or converted on the server.
 * Everything here is plain JavaScript, so it runs the same on Windows, macOS and Linux hosts.
 */

/** Characters per "page" for files without real pages (Word, Excel, text). */
const PAGE_CHARS = 6000;
/** A PDF page with less text than this is treated as a scan. */
const SCAN_TEXT_MIN = 40;
export const MAX_EXCEL_BYTES = 25 * 1024 * 1024;
export const MAX_VIEW_PAGES = 5;

export type Survey = {
  kind: FileKind;
  pages: number | null;
  /** True when the pages must be looked at rather than read as text. */
  visual: boolean;
  preview: string;
  error: string | null;
};
export type Opened = { pages: string[]; visual: boolean[] };

export class ReadError extends Error {}

async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy();
    const name = (error as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new ReadError('password protected');
    throw new ReadError('the PDF is damaged or not a PDF');
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[])
        text += (item.str ?? '') + (item.hasEOL ? '\n' : ' ');
      pages.push(text.replace(/[ \t]+/g, ' ').trim());
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > PAGE_CHARS) {
    let cut = rest.lastIndexOf('\n', PAGE_CHARS);
    if (cut < PAGE_CHARS / 2) cut = PAGE_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest || !out.length) out.push(rest);
  return out;
}

async function wordText(bytes: Uint8Array) {
  const mammoth = await import('mammoth');
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return chunk(result.value);
  } catch {
    throw new ReadError('the Word file is damaged or password protected');
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    return '';
  }
  return String(value);
}
async function excelText(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_EXCEL_BYTES) throw new ReadError('the workbook is over 25 MB');
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw new ReadError('the workbook is damaged or password protected');
  }
  const pages: string[] = [];
  workbook.eachSheet((sheet) => {
    const lines: string[] = [`Sheet "${sheet.name}"`];
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      const cells = (row.values as unknown[]).slice(1).map(cellText);
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) lines.push(`row ${number}: ${cells.join(' | ')}`);
    });
    pages.push(...chunk(lines.join('\n')));
  });
  return pages.length ? pages : [''];
}

function isZip(bytes: Uint8Array) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Opens a file into pages of text, marking which pages must be looked at instead. */
export async function openFile(kind: FileKind, name: string, bytes: Uint8Array): Promise<Opened> {
  if (kind === 'pdf') {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new ReadError('not a PDF');
    const pages = await pdfText(bytes);
    return { pages, visual: pages.map((p) => p.replace(/\s/g, '').length < SCAN_TEXT_MIN) };
  }
  if (kind === 'word') {
    if (!isZip(bytes)) throw new ReadError('not a .docx file');
    const pages = await wordText(bytes);
    return { pages, visual: pages.map(() => false) };
  }
  if (kind === 'excel') {
    if (!isZip(bytes)) throw new ReadError('not an .xlsx file');
    const pages = await excelText(bytes);
    return { pages, visual: pages.map(() => false) };
  }
  if (kind === 'image') return { pages: [''], visual: [true] };
  if (kind === 'text') {
    const text = new TextDecoder('utf-8').decode(bytes);
    const pages = chunk(text);
    return { pages, visual: pages.map(() => false) };
  }
  const ext = name.split('.').pop()?.toLowerCase();
  throw new ReadError(
    ext === 'xls' || ext === 'doc'
      ? 'old Office format; save it as .xlsx or .docx'
      : 'this file type is not read',
  );
}

export async function surveyFile(kind: FileKind, name: string, bytes: Uint8Array): Promise<Survey> {
  try {
    const opened = await openFile(kind, name, bytes);
    const visual = opened.visual.every(Boolean);
    return {
      kind,
      pages: kind === 'pdf' ? opened.pages.length : kind === 'image' ? 1 : null,
      visual,
      preview: visual ? '' : (opened.pages.find((p) => p.trim())?.slice(0, 1200) ?? ''),
      error: null,
    };
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    return { kind, pages: null, visual: false, preview: '', error: error.message };
  }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/**
 * The model input parts that show pages `from`..`to` (1-based, inclusive) of a scan or photo:
 * the image itself, or a PDF holding only those pages.
 */
export async function pageParts(
  kind: FileKind,
  name: string,
  bytes: Uint8Array,
  from: number,
  to: number,
) {
  if (kind === 'image') {
    const ext = name.split('.').pop()!.toLowerCase();
    return [
      {
        type: 'input_image',
        image_url: `data:${MIME[ext] ?? 'image/jpeg'};base64,${Buffer.from(bytes).toString('base64')}`,
        detail: 'high',
      },
    ];
  }
  if (kind !== 'pdf') throw new ReadError('only PDFs and images have pages to look at');
  let source: PDFDocument;
  try {
    // Some PDFs only restrict copying or printing; their pages still open.
    source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new ReadError('these pages could not be shown; the PDF is damaged or locked');
  }
  const count = source.getPageCount();
  const first = Math.max(1, from);
  const last = Math.min(count, to, first + MAX_VIEW_PAGES - 1);
  if (first > count) throw new ReadError(`the file has ${count} pages`);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    source,
    Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i),
  );
  pages.forEach((p) => out.addPage(p));
  const data = Buffer.from(await out.save()).toString('base64');
  return [
    {
      type: 'input_file',
      filename: `${name.replace(/\.pdf$/i, '')} pages ${first}-${last}.pdf`,
      file_data: `data:application/pdf;base64,${data}`,
    },
  ];
}
