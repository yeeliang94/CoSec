import { describe, expect, it } from 'vitest';
import { bindingInfo, resolveBinding } from '../src/domain/resolution/bindings';
import { signatureLabel } from '../src/domain/resolution/compile';
import { signerPool, signersOf } from '../src/domain/resolution/form';
import { maskContext } from '../src/domain/resolution/particulars';
import { personProperty } from '../src/domain/resolution/values';
import { sampleContext } from '../src/server/resolution/samples';

const ctx = sampleContext();
const appointee = ctx.proposedPeople[0];
const secretary = ctx.secretaries![0];

describe('person particulars in templates', () => {
  it('allows every particular of a selected person and types dates', () => {
    expect(bindingInfo('selection.appointee.identityNumber')).toMatchObject({ valueType: 'text' });
    expect(bindingInfo('selection.appointee.dateOfBirth')).toMatchObject({ valueType: 'date' });
    expect(bindingInfo('selection.appointee.otherDirectorships')).not.toBeNull();
    expect(bindingInfo('selection.appointee.password')).toBeNull();
    expect(bindingInfo('firm.registrationNumber')).not.toBeNull();
  });

  it('resolves particulars, other directorships and firm lodger details', () => {
    const pick = () => appointee;
    expect(resolveBinding('selection.appointee.identityNumber', ctx, pick)).toBe('900101-14-0000');
    expect(resolveBinding('selection.appointee.dateOfBirth', ctx, pick)).toBe('1990-01-01');
    expect(resolveBinding('selection.appointee.otherDirectorships', ctx, pick)).toContain(
      'Example Trading',
    );
    // Not recorded: null, so a required field reports the missing record.
    expect(resolveBinding('selection.appointee.passportExpiry', ctx, pick)).toBeNull();
    expect(resolveBinding('firm.phone', ctx, pick)).toBe('03-0000 0000 (fictional)');
  });

  it('prints date particulars as long dates', () => {
    expect(personProperty(appointee, 'dateOfBirth')).toBe('1 January 1990');
    expect(personProperty(appointee, 'gender')).toBe('Female');
    expect(personProperty(appointee, 'passportExpiry')).toBe('');
  });

  it('masks identity values in every pool for staff without the identity permission', () => {
    const masked = maskContext(ctx);
    expect(masked.proposedPeople[0].particulars).toMatchObject({
      identityNumber: '900101-**-****',
      gender: 'Female',
    });
    expect(masked.proposedPeople[0].particulars!.dateOfBirth).toBeUndefined();
    expect(masked.secretaries![0].particulars!.identityNumber).toBe('850505-**-****');
    // The original context is unchanged.
    expect(ctx.proposedPeople[0].particulars!.identityNumber).toBe('900101-14-0000');
  });
});

describe('signers of individual forms', () => {
  it('fills particular tokens in signature labels and drops lines with nothing recorded', () => {
    const label = '{capacity}\n{name}\n{secretaryLicence}\nSSM PC NO.: {practisingCertificate}';
    expect(signatureLabel(label, secretary)).toBe(
      'Secretary\nLim Siew Ling (fictional secretary)\nMAICSA 0000000 (fictional)\nSSM PC NO.: 202000000000 (fictional)',
    );
    expect(signatureLabel(label, ctx.directors[0])).toBe(
      'Director\nNur Aisyah binti Abdullah Rahman (fictional)',
    );
    expect(signatureLabel('Name: {name}\nPassport/NRIC No.: {identityNumber}', appointee)).toBe(
      'Name: Aminah binti Yusof (fictional)\nPassport/NRIC No.: 900101-14-0000',
    );
    // A value that looks like a token is not expanded again.
    expect(signatureLabel('{name}', { ...appointee, name: '{capacity}' })).toBe('{capacity}');
  });

  it('offers company people and proposed people as the subject, and nobody as witness', () => {
    const subject = signerPool(ctx, 'subject').map((p) => p.id);
    expect(subject).toContain(appointee.id);
    expect(subject).toContain(ctx.directors[0].id);
    expect(new Set(subject).size).toBe(subject.length);
    expect(signerPool(ctx, 'witness')).toEqual([]);
    expect(signersOf({ directors: ['a'], members: [], certifiers: [] }, 'subject')).toEqual([]);
    expect(
      signersOf({ directors: [], members: [], certifiers: [], subject: ['p'] }, 'subject'),
    ).toEqual(['p']);
  });
});
