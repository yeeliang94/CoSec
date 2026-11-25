import { z } from 'zod';
import {
  APPLICATIONS,
  BO_EXEMPT_CATEGORIES,
  BO_STATUSES,
  NOMINEE_STATUSES,
} from '../../domain/ar1/mtool-lists';

const requestId = z.string().uuid();
const expectedRevision = z.number().int().min(0);
const amount = z
  .string()
  .trim()
  .max(20)
  .refine((v) => v === '' || /^\d{1,15}(\.\d{1,4})?$/.test(v), 'Enter an amount such as 1000.00.');
const count = z
  .string()
  .trim()
  .max(15)
  .refine((v) => v === '' || /^\d{1,15}$/.test(v), 'Enter a whole number.');
const perKind = (value: z.ZodType<string>) =>
  z.object({ Ordinary: value.optional(), Preference: value.optional(), Other: value.optional() });
const yesNo = z.enum(['Yes', 'No']).nullable();
const notes = z.string().max(4000);

export const answersInput = z.object({
  sharesQuoted: yesNo,
  sectionB: z.object({
    forfeitedShares: perKind(count),
    calledUp: perKind(amount),
    callsReceived: perKind(amount),
    consideredPaidFullyPaid: perKind(amount),
    consideredPaidPartlyPaid: perKind(amount),
    callsUnpaid: perKind(amount),
    paidOnForfeited: perKind(amount),
    commission: amount,
    discount: amount,
    notesOnShares: notes,
    notesOnDebentures: notes,
  }),
  notesOnIndebtedness: notes,
  jointAnalyses: z.record(z.string().max(1000), z.string().max(200)).optional(),
  certificate: z.object({
    unclaimedMoneys: yesNo,
    noPublicInvitation: yesNo,
    overFifty: yesNo,
    overFiveHundred: yesNo,
    boStatus: z.enum(BO_STATUSES).nullable(),
    boExemptCategory: z.enum(BO_EXEMPT_CATEGORIES).nullable(),
    nomineeStatus: z.enum(NOMINEE_STATUSES).nullable(),
  }),
});

export const startReturnInput = z.object({
  requestId,
  companyId: z.string().min(1).max(100),
  calendarYear: z.number().int().min(1900).max(2200),
  application: z.enum(APPLICATIONS),
  rectificationDeclaration: z.string().max(2000).default(''),
  courtOrderReference: z.string().max(200).default(''),
});

export const returnActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    requestId,
    expectedRevision,
    application: z.enum(APPLICATIONS).optional(),
    rectificationDeclaration: z.string().max(2000).optional(),
    courtOrderReference: z.string().max(200).optional(),
    answers: answersInput.optional(),
  }),
  z.object({ action: z.literal('create_download'), requestId, expectedRevision }),
]);
