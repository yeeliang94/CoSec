import { z } from 'zod';
import {
  CITATION_KEYS,
  DIRECTOR_DESIGNATIONS,
  PARTICULAR_KEYS,
} from '../../domain/resolution/model';
import { isCalendarDate } from '../../domain/resolution/records';
import { COMPANY_PARTICULAR_KEYS } from '../../domain/ar1/company';
import { CONSIDERATIONS, SHARE_ENTRY_KINDS, SHARE_KINDS } from '../../domain/ar1/shares';
import { TRUSTEE_TYPES } from '../../domain/ar1/mtool-lists';

/** Zod request schemas for the records routes. */
export const recordId = z.string().min(1).max(100);
export const date = z.string().refine(isCalendarDate, 'Enter a calendar date (YYYY-MM-DD).');
const optionalDate = date.nullable().optional();
const requestId = z.string().uuid();
const expectedRevision = z.number().int().min(0);
const reason = z.string().trim().min(1).max(2000);
const name = z.string().trim().min(1).max(255);
const evidenceIds = z.array(recordId).max(50);
const fieldValue = z.union([z.string().max(4000), z.boolean(), z.null()]);
const mutation = { requestId, expectedRevision };

export const personInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    requestId,
    kind: z.enum(['individual', 'organisation']).optional(),
    fullName: name,
    email: z.email().max(255).nullable().optional(),
    notes: z.string().max(4000).optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: recordId,
    ...mutation,
    fullName: name.optional(),
    email: z.email().max(255).nullable().optional(),
    notes: z.string().max(4000).optional(),
    reason,
  }),
  z.object({
    action: z.literal('set_custom'),
    id: recordId,
    ...mutation,
    definitionId: recordId,
    value: fieldValue,
    effectiveDate: date,
    reason,
  }),
  z.object({
    action: z.literal('set_particulars'),
    id: recordId,
    ...mutation,
    values: z
      .partialRecord(z.enum(PARTICULAR_KEYS), z.string().max(2000).nullable())
      .refine((v) => Object.keys(v).length > 0, 'Enter at least one particular.'),
    effectiveDate: date,
    reason,
  }),
  z.object({
    action: z.literal('set_other_directorships'),
    id: recordId,
    ...mutation,
    directorships: z
      .array(
        z.object({
          id: recordId.optional(),
          companyName: name,
          appointedOn: date.nullable(),
          ceasedOn: date.nullable(),
        }),
      )
      .max(50, 'Record up to 50 other directorships.'),
    reason,
  }),
]);

export const relationshipInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    requestId,
    personId: recordId,
    role: z.enum(['director', 'member', 'secretary', 'manager', 'auditor', 'other']),
    capacity: z.string().trim().max(200).default(''),
    startDate: date.nullable(),
    evidenceIds: evidenceIds.default([]),
  }),
  z.object({
    action: z.literal('end'),
    id: recordId,
    ...mutation,
    endDate: date,
    reason,
    cessation: z.enum(['resignation', 'removal', 'other_cessation']).optional(),
  }),
  z.object({
    action: z.literal('set_capacity'),
    id: recordId,
    ...mutation,
    capacity: z.string().trim().max(200),
    reason,
  }),
  z.object({
    action: z.literal('set_appointment'),
    id: recordId,
    ...mutation,
    designation: z.enum(DIRECTOR_DESIGNATIONS),
    alternateTo: recordId.nullable(),
    nominee: z.boolean(),
    /** When a recorded value changes: the date the new value applies from. */
    effectiveDate: date.nullable().optional(),
    reason,
  }),
]);

export const profileInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_citation'),
    ...mutation,
    key: z.enum(CITATION_KEYS),
    value: z.string().trim().min(1).max(2000),
    effectiveDate: date,
    reason,
  }),
  z.object({
    action: z.literal('set_custom'),
    ...mutation,
    definitionId: recordId,
    value: fieldValue,
    effectiveDate: date,
    reason,
  }),
  z.object({
    action: z.literal('set_particulars'),
    ...mutation,
    values: z
      .partialRecord(z.enum(COMPANY_PARTICULAR_KEYS), z.string().max(4000).nullable())
      .refine((v) => Object.keys(v).length > 0, 'Enter at least one particular.'),
    effectiveDate: date,
    reason,
  }),
  z.object({
    action: z.literal('set_share_classes'),
    ...mutation,
    classes: z
      .array(
        z.object({
          id: recordId.optional(),
          name: z.string().trim().min(1).max(100),
          kind: z.enum(SHARE_KINDS),
        }),
      )
      .max(20),
    reason,
  }),
  z.object({
    action: z.literal('set_branches'),
    ...mutation,
    branches: z
      .array(
        z.object({
          id: recordId.optional(),
          Line1: z.string().trim().max(255),
          Line2: z.string().trim().max(255),
          Line3: z.string().trim().max(255),
          Postcode: z.string().trim().max(20),
          Town: z.string().trim().max(255),
          State: z.string().trim().max(255),
          Country: z.string().trim().max(255),
          phone: z.string().trim().max(50),
          fax: z.string().trim().max(50),
          email: z.string().trim().max(255),
          website: z.string().trim().max(255),
          from: date.nullable(),
          until: date.nullable(),
        }),
      )
      .max(50),
    reason,
  }),
]);

const option = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200),
});
export const fieldDefinitionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    requestId,
    id: z.string().min(2).max(64),
    scope: z.enum(['company', 'person', 'case']),
    label: name,
    valueType: z.enum(['text', 'date', 'number', 'boolean', 'choice']),
    options: z.array(option).max(100).optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: recordId,
    ...mutation,
    label: name.optional(),
    options: z.array(option).max(100).optional(),
    reason,
  }),
  z.object({ action: z.literal('archive'), id: recordId, ...mutation, reason }),
]);

export const createCaseInput = z.object({
  requestId,
  companyId: recordId,
  kind: z.enum(['board', 'director_appointment', 'director_resignation']),
  title: z.string().trim().min(1).max(300),
  personId: recordId.nullable().optional(),
  instructionDate: optionalDate,
  resolutionDate: optionalDate,
  effectiveDate: optionalDate,
});

const stepKind = z.enum(['instruction', 'preparation', 'review', 'execution', 'custom']);
const stepState = z.enum(['Pending', 'In progress', 'Waiting', 'Complete', 'Not applicable']);
export const caseActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_details'),
    ...mutation,
    title: z.string().trim().min(1).max(300).optional(),
    instructionDate: optionalDate,
    resolutionDate: optionalDate,
    effectiveDate: optionalDate,
    ownerId: recordId.optional(),
    personId: recordId.nullable().optional(),
  }),
  z.object({
    action: z.literal('add_step'),
    ...mutation,
    kind: stepKind.default('custom'),
    label: z.string().trim().min(1).max(200),
    ownerId: recordId.optional(),
    dueDate: optionalDate,
    dependsOn: z.array(recordId).max(50).optional(),
  }),
  z.object({
    action: z.literal('update_step'),
    ...mutation,
    stepId: recordId,
    label: z.string().trim().min(1).max(200).optional(),
    state: stepState.optional(),
    ownerId: recordId.optional(),
    dueDate: optionalDate,
    reason: z.string().trim().max(2000).nullable().optional(),
    evidenceIds: evidenceIds.optional(),
    dependsOn: z.array(recordId).max(50).optional(),
  }),
  z.object({
    action: z.literal('record_decision'),
    ...mutation,
    status: z.enum(['Not recorded', 'Passed', 'Not passed']),
    date: date.nullable(),
    evidenceIds: evidenceIds.default([]),
    note: z.string().max(4000).optional(),
  }),
  z.object({ action: z.literal('cancel'), ...mutation, reason }),
  z.object({ action: z.literal('complete'), ...mutation }),
  z.object({ action: z.literal('send_for_review'), ...mutation, reviewerId: recordId }),
  z.object({
    action: z.literal('review'),
    ...mutation,
    decision: z.enum(['Approved', 'Returned']),
    comment: z.string().trim().max(4000).default(''),
  }),
  z.object({ action: z.literal('reopen'), ...mutation }),
  z.object({
    action: z.literal('set_custom'),
    ...mutation,
    definitionId: recordId,
    value: fieldValue,
    effectiveDate: date,
    reason,
  }),
]);

const filterText = z.string().trim().min(1).max(100).optional();
export const auditFilterInput = z.object({
  companyId: filterText,
  entityType: filterText,
  entityId: filterText,
  action: filterText,
  actorId: filterText,
  from: date.optional(),
  to: date.optional(),
});
/** Query-string params with empty values dropped. */
export function searchParams(request: Request) {
  return Object.fromEntries(
    [...new URL(request.url).searchParams.entries()].filter(([, v]) => v.trim() !== ''),
  );
}

const holder = z
  .object({
    partyIds: z.array(recordId).min(1).max(10),
    trustee: z
      .object({
        type: z.enum(TRUSTEE_TYPES),
        subjectName: z.string().trim().min(1).max(255),
        subjectIdType: z.string().trim().max(100),
        subjectIdNumber: z.string().trim().max(50),
        subjectNationality: z.string().trim().max(100),
      })
      .nullable()
      .optional(),
  })
  .nullable();
const entryFields = {
  kind: z.enum(SHARE_ENTRY_KINDS),
  date,
  classId: recordId,
  shares: z.string().regex(/^\d{1,15}$/, 'Enter the number of shares as a whole number.'),
  from: holder,
  to: holder,
  amountPayable: z.string().max(20).nullable(),
  amountPaid: z.string().max(20).nullable(),
  consideration: z.enum(CONSIDERATIONS).nullable(),
  sourceDocumentId: recordId.nullable(),
  sourceCaseId: recordId.nullable(),
  note: z.string().max(2000).default(''),
};
export const shareEntryInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record'), requestId, ...entryFields }),
  z.object({
    action: z.literal('correct'),
    requestId,
    id: recordId,
    voids: z.boolean().default(false),
    ...entryFields,
  }),
  z.object({ action: z.literal('post'), id: recordId, ...mutation }),
  z.object({ action: z.literal('withdraw'), id: recordId, ...mutation, reason }),
]);

const chargeFields = {
  registeredNumber: z.string().trim().min(1).max(100),
  registeredOn: date,
  nature: z.string().trim().min(1).max(500),
  chargee: z.string().trim().min(1).max(255),
  amount: z.string().trim().min(1).max(30),
  dischargedOn: date.nullable(),
  note: z.string().max(2000).default(''),
};
export const chargeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record'), requestId, ...chargeFields }),
  z.object({ action: z.literal('update'), id: recordId, ...mutation, reason, ...chargeFields }),
]);
