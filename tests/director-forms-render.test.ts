import { describe, expect, it } from 'vitest';
import { compileDocument, resolvedText } from '../src/domain/resolution/compile';
import type { CaseInput } from '../src/domain/resolution/form';
import { errorsOnly } from '../src/domain/resolution/validate';
import { readZip, renderDocx } from '../src/server/resolution/render-docx';
import {
  sampleAnswers,
  sampleContext,
  sampleSigners,
  STARTER_ASSEMBLIES,
  STARTER_CLAUSES,
} from '../src/server/resolution/samples';

const OUTPUT_NAMES: Record<string, string> = {
  directors_written: "Directors' written resolution",
  individual_form: 'Individual form',
};

/** A case input for one starter layout with its starter wording and fictional answers. */
function starterInput(key: string, answers: Record<string, unknown> = {}): CaseInput {
  const a = STARTER_ASSEMBLIES.find((x) => x.key === key)!;
  const clauses = a.starterKeys.map((k) => {
    const c = STARTER_CLAUSES.find((x) => x.key === k)!;
    return { key: `k_${k}`, name: c.name, version: { id: `v_${k}`, ...c.content } };
  });
  const ctx = sampleContext();
  const sharedFields = [
    ...a.content.fields,
    ...clauses.flatMap((c) => c.version.fields.filter((f) => f.scope === 'case')),
  ];
  return {
    outputType: { id: a.outputTypeId, name: OUTPUT_NAMES[a.outputTypeId] },
    assembly: { name: a.name, version: { id: `v_${key}`, ...a.content } },
    clauses,
    ctx,
    answers: {
      shared: { ...sampleAnswers(sharedFields, ctx), ...answers } as never,
      clauses: Object.fromEntries(
        clauses.map((c) => [
          c.key,
          sampleAnswers(
            c.version.fields.filter((f) => f.scope === 'clause'),
            ctx,
          ),
        ]),
      ),
    },
    signers: sampleSigners(ctx),
  };
}
const xmlOf = async (input: CaseInput) => {
  const compiled = compileDocument(input, 'final');
  expect(errorsOnly(compiled.issues)).toEqual([]);
  const bytes = await renderDocx(compiled.resolved);
  return {
    text: resolvedText(compiled.resolved),
    xml: readZip(bytes).get('word/document.xml')!.toString('utf8'),
    compiled,
  };
};

describe('starter documents for a director appointment and the annual return', () => {
  it('generates the section 201 declaration with struck alternatives and a witness block', async () => {
    const { text, xml, compiled } = await xmlOf(starterInput('s201_declaration'));
    expect(text).toContain('Name: Aminah binti Yusof (fictional)');
    expect(text).toContain('Passport/NRIC No.: 900101-14-0000');
    expect(text).toContain('In the presence of a Solicitor/ Notary Public/ Commissioner for Oaths');
    expect(xml).toContain('<w:strike/>');
    // Only the person signs; the witness is not a record.
    expect(compiled.executionRequirements).toEqual([{ personId: 'sample-p1', role: 'subject' }]);
  });

  it('prints the chosen leave paragraph unstruck with the corporation named', async () => {
    const { text } = await xmlOf(
      starterInput('s201_declaration', {
        leave_paragraph: 'court_leave',
        leave_corporation: 'Example Court Order Sdn. Bhd. (fictional)',
      }),
    );
    expect(text).toContain(
      'to be a director of Example Court Order Sdn. Bhd. (fictional). I attach herewith',
    );
  });

  it('generates the disclosure notice with particulars, tick boxes and a landscape section', async () => {
    const { text, xml } = await xmlOf(
      starterInput('disclosure_notice', { notice_contracts: false }),
    );
    expect(text).toContain('900101-14-0000');
    expect(text).toContain('1 January 1990');
    expect(text).toContain('Example Trading Sdn. Bhd.');
    expect(text).toContain('☑');
    expect(text).toContain('☐');
    expect(text).not.toContain('SECTION III');
    expect(xml).toContain('w:orient="landscape"');
  });

  it('generates the certified extract with the secretary and lodger details', async () => {
    const { text } = await xmlOf(starterInput('certified_extract'));
    expect(text).toContain('CERTIFIED TRUE AND CORRECT');
    expect(text).toContain('MAICSA 0000000 (fictional)');
    expect(text).toContain('SSM PC NO.: 202000000000 (fictional)');
    expect(text).toContain('Example Secretarial Services (fictional)');
    expect(text).toContain('Section 201');
  });

  it('generates the circular appointment resolution and the annual return resolution', async () => {
    const appointment = await xmlOf(starterInput('appointment'));
    expect(appointment.text).toContain('update the Register of Directors');
    expect(appointment.text).toContain('BOARD OF DIRECTORS');

    const withExtension = await xmlOf(starterInput('annual_return', {}));
    const ar = withExtension.compiled.resolved;
    expect(resolvedText(ar)).toContain('Section 68 of the Companies Act 2016');
  });
});
