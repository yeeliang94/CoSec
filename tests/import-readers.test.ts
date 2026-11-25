import { expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph } from 'docx';
import { openFile, pageParts, surveyFile } from '../src/server/imports/readers';

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage();
  first.drawText('Annual return 2024 Meranti Trading Sdn. Bhd. registered office Jalan Ampang', {
    x: 40,
    y: 700,
    size: 10,
    font,
  });
  pdf.addPage(); // no text: reads as a scanned page
  return pdf.save();
}

it('reads digital PDF text and marks a page without text as one to look at', async () => {
  const opened = await openFile('pdf', 'a.pdf', await samplePdf());
  expect(opened.pages[0]).toContain('Meranti Trading');
  expect(opened.visual).toEqual([false, true]);
  const parts = await pageParts('pdf', 'a.pdf', await samplePdf(), 2, 9);
  expect(parts[0]).toMatchObject({ type: 'input_file', filename: 'a pages 2-2.pdf' });
});

it('reads Excel rows with their row numbers and Word paragraphs as text', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Members');
  ws.addRow(['Name', 'ID', 'Shares']);
  ws.addRow(['Lim Wei Jie', '900203101234', 10000]);
  const excel = await openFile('excel', 'm.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  expect(excel.pages[0]).toContain('row 2: Lim Wei Jie | 900203101234 | 10000');
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph('Board minutes March 2024'),
          new Paragraph('Tan Mei Ling resigned'),
        ],
      },
    ],
  });
  const word = await openFile('word', 'b.docx', new Uint8Array(await Packer.toBuffer(doc)));
  expect(word.pages[0]).toContain('Tan Mei Ling resigned');
});

it('reports damaged and unread files instead of failing', async () => {
  expect(
    (await surveyFile('pdf', 'bad.pdf', new TextEncoder().encode('%PDF-garbage'))).error,
  ).toMatch(/damaged/);
  expect((await surveyFile('other', 'x.xls', new Uint8Array([1]))).error).toMatch(
    /old Office format/,
  );
  expect((await surveyFile('excel', 'x.xlsx', new Uint8Array([1, 2, 3]))).error).toMatch(
    /not an .xlsx/,
  );
});
