/**
 * Fictional sample values and fictional starter wording.
 *
 * Fictional sample wording — not approved legal precedent. No section numbers, time limits or
 * statements here come from an approved source; they exist to exercise the clause/assembly
 * engine until the firm supplies reviewed wording.
 */
import type {
  AnswerValue,
  Answers,
  AssemblyVersion,
  BlockNode,
  ClauseCategory,
  ClauseVersion,
  FieldDefinition,
  InlineNode,
  Mark,
  OutputType,
  PersonSnapshot,
  Predicate,
  RecordProperty,
  ResolutionContext,
  SignerSelection,
  UsageContext,
} from '../../domain/resolution/model';
import { defaultLayout } from '../../domain/resolution/schema';

export const SAMPLE_SOURCE = 'Fictional sample wording — not approved legal precedent';
export const SAMPLE_BANNER = 'SAMPLE — fictional values';

// ---------------------------------------------------------------- tiny builders
export const t = (text: string, ...marks: Mark[]): InlineNode =>
  marks.length ? { type: 'text', text, marks } : { type: 'text', text };
export const f = (
  fieldId: string,
  property?: 'name' | 'capacity' | 'appointedOn' | 'ceasedOn',
): InlineNode => (property ? { type: 'field', fieldId, property } : { type: 'field', fieldId });
// Empty strings are dropped, so p('') is an empty paragraph (for example a blank table cell).
const inline = (parts: (string | InlineNode)[]) =>
  parts.filter((x) => x !== '').map((x) => (typeof x === 'string' ? t(x) : x));
export const p = (...parts: (string | InlineNode)[]): BlockNode => ({
  type: 'paragraph',
  content: inline(parts),
});
export const pc = (...parts: (string | InlineNode)[]): BlockNode => ({
  type: 'paragraph',
  align: 'center',
  content: inline(parts),
});
export const h = (level: 1 | 2 | 3, text: string, align?: 'center'): BlockNode => ({
  type: 'heading',
  level,
  ...(align ? { align } : {}),
  content: [t(text)],
});
export const when = (predicate: Predicate, ...content: BlockNode[]): BlockNode => ({
  type: 'condition',
  when: predicate,
  content,
});
export const repeat = (fieldId: string, ...content: BlockNode[]): BlockNode => ({
  type: 'repeat',
  fieldId,
  content,
});
const question = (
  id: string,
  label: string,
  valueType: FieldDefinition['valueType'],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id,
  label,
  valueType,
  source: { kind: 'question' },
  scope: 'clause',
  required: true,
  ...extra,
});
const bound = (
  id: string,
  label: string,
  path: string,
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  id,
  label,
  valueType: 'text',
  source: { kind: 'binding', path },
  scope: 'clause',
  required: true,
  ...extra,
});
const resolutionDate = question('resolution_date', 'Resolution date', 'date', {
  scope: 'case',
  format: { date: 'long' },
});

/** Output types the starters need beyond the two the migration seeds. */
export const STARTER_OUTPUT_TYPES: Pick<OutputType, 'id' | 'name' | 'body' | 'order'>[] = [
  { id: 'individual_form', name: 'Individual form', body: 'individual', order: 30 },
];

// Asked once per case and shared by every document of a director appointment set.
const appointee = question('appointee', 'Proposed director', 'recordReference', {
  scope: 'case',
  record: { context: 'proposedPerson' },
});
const appointeeName = bound(
  'appointee_name',
  'Proposed director name',
  'selection.appointee.name',
  {
    scope: 'case',
    format: { case: 'upper' },
  },
);
const appointmentDate = question('appointment_date', 'Appointment date', 'date', {
  scope: 'case',
  format: { date: 'long' },
});
/** A particular of the proposed director, read from the person record. */
const appointeeParticular = (
  property: Exclude<RecordProperty, 'name'>,
  label: string,
  extra: Partial<FieldDefinition> = {},
) =>
  bound(`appointee_${snake(property)}`, label, `selection.appointee.${property}`, {
    scope: 'case',
    ...extra,
  });
const snake = (text: string) => text.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// ---------------------------------------------------------------- starter clauses
export type StarterClause = {
  key: string;
  name: string;
  category: ClauseCategory;
  usageContexts: UsageContext[];
  displayOrder: number;
  description: string;
  content: Pick<ClauseVersion, 'wordings' | 'fields'>;
};
export const STARTER_CLAUSES: StarterClause[] = [
  {
    key: 'appointment',
    name: 'Appointment of director',
    category: 'Director',
    usageContexts: ['board', 'director_appointment'],
    displayOrder: 10,
    description:
      'Appoints one proposed director, who has made the section 201 declaration, from a date. Fictional sample wording.',
    content: {
      // Case-wide, so every document of an appointment set names the same person and date.
      fields: [appointee, appointeeName, appointmentDate],
      wordings: {
        directors_written: [
          p(t('APPOINTMENT OF DIRECTOR', 'bold', 'underline')),
          p(t('RESOLVED:-', 'bold')),
          p(
            t('THAT ', 'bold'),
            f('appointee_name'),
            ' who has made a declaration under Section 201 of the Companies Act 2016 ("the Act") be and is hereby appointed as Director of the Company with effect from ',
            f('appointment_date'),
            '.',
          ),
        ],
        members_written: [
          p(t('Appointment of director', 'bold')),
          p(
            'THAT ',
            f('appointee_name'),
            ' be appointed as a director of the Company with effect from ',
            f('appointment_date'),
            '.',
          ),
        ],
      },
    },
  },
  {
    key: 'appointment_registers',
    name: 'Registers and lodgement after appointment',
    category: 'Secretary',
    usageContexts: ['director_appointment'],
    displayOrder: 15,
    description:
      'Authorises the secretaries to update the register of directors and lodge the change. Fictional sample wording.',
    content: {
      fields: [],
      wordings: {
        directors_written: [
          p(t('THAT ', 'bold'), 'the Secretaries be authorised to:'),
          {
            type: 'list',
            ordered: true,
            items: [
              [
                p(
                  'update the Register of Directors, Managers and Secretaries pursuant to Section 57 of the Act; and',
                ),
              ],
              [
                p(
                  'lodge the form pursuant to Section 58 of the Act on the change of directors, managers and secretaries with the Registrar of Companies for and on behalf of the Company.',
                ),
              ],
            ],
          },
        ],
      },
    },
  },
  {
    key: 'annual_return',
    name: 'Submission of annual return',
    category: 'Other',
    usageContexts: ['board'],
    displayOrder: 5,
    description:
      'Notes the annual return as correct and authorises the secretaries to lodge it, with an optional extension of time. Fictional sample wording.',
    content: {
      fields: [
        question('return_year', 'Calendar year of the annual return', 'text'),
        question('made_up_to', 'Made up to', 'date', { format: { date: 'long' } }),
        question('include_extension', 'Include authority to apply for more time', 'boolean'),
      ],
      wordings: {
        directors_written: [
          p(t('SUBMISSION OF ANNUAL RETURN FOR THE CALENDAR YEAR ', 'bold'), f('return_year')),
          p(t('RESOLVED:-', 'bold')),
          p(
            t('THAT ', 'bold'),
            'the information set out in the Annual Return made up to ',
            f('made_up_to'),
            ', pursuant to Section 68 of the Companies Act 2016 ("the Act"), annexed as Appendix A ("AR ',
            f('return_year'),
            '"), be noted as true and correct and the Board of Directors authorises AR ',
            f('return_year'),
            ' to be lodged with the Companies Commission of Malaysia ("CCM").',
          ),
          p(
            t('THAT ', 'bold'),
            'notwithstanding that AR ',
            f('return_year'),
            ' is to be lodged by the Company Secretaries, the Board of Directors acknowledges its responsibility for the accuracy, correctness and truthfulness of AR ',
            f('return_year'),
            ', knowing that it is an offence under Section 591 of the Act to knowingly provide information or documents that are false or misleading in any material particular.',
          ),
          p(
            t('THAT ', 'bold'),
            'the Company Secretaries be authorised to sign or digitally sign (whichever is applicable) and lodge AR ',
            f('return_year'),
            ' with the CCM.',
          ),
          when(
            { op: 'isTrue', fieldId: 'include_extension' },
            p(
              t('THAT ', 'bold'),
              'if necessary, the Company Secretaries be authorised to apply under Section 609 of the Act for an extension of time to lodge the annual return ("EOT") with the CCM.',
            ),
          ),
          p(
            t('FURTHER THAT ', 'bold'),
            'the Company Secretaries be indemnified for any costs incurred in any proceedings, in relation to the submission of AR ',
            f('return_year'),
            ' and any EOT, for any act or omission in their capacity as Company Secretaries in which judgment is given in their favour, they are acquitted or granted relief under the Act, or the proceedings are discontinued or not pursued.',
          ),
        ],
      },
    },
  },
  {
    key: 'resignation',
    name: 'Resignation of director',
    category: 'Director',
    usageContexts: ['board', 'director_resignation'],
    displayOrder: 20,
    description: 'Notes a director’s written resignation. Fictional sample wording.',
    content: {
      fields: [
        question('resigning_director', 'Resigning director', 'recordReference', {
          record: { context: 'currentDirectors' },
        }),
        bound('resigning_name', 'Resigning director name', 'selection.resigning_director.name'),
        question('resignation_date', 'Resignation effective date', 'date', {
          format: { date: 'long' },
        }),
      ],
      wordings: {
        directors_written: [
          p(t('Resignation of director', 'bold')),
          p(
            'THAT the written notice of resignation of ',
            f('resigning_name'),
            ' as a director of the Company, effective ',
            f('resignation_date'),
            ', be received and noted, and that the Company Secretary be instructed to update the records of the Company accordingly.',
          ),
        ],
      },
    },
  },
  {
    key: 'auditors',
    name: 'Appointment of auditors',
    category: 'Auditor',
    usageContexts: ['board'],
    displayOrder: 10,
    description: 'Appoints or recommends auditors for a financial year. Fictional sample wording.',
    content: {
      fields: [
        question('auditor_firm', 'Audit firm', 'text'),
        question('audit_year_end', 'Financial year ending', 'date', { format: { date: 'long' } }),
      ],
      wordings: {
        directors_written: [
          p(t('Appointment of auditors', 'bold')),
          p(
            'THAT ',
            f('auditor_firm'),
            ' be recommended to the members for appointment as auditors of the Company for the financial year ending ',
            f('audit_year_end'),
            '.',
          ),
        ],
        members_written: [
          p(t('Appointment of auditors', 'bold')),
          p(
            'THAT ',
            f('auditor_firm'),
            ' be appointed as auditors of the Company for the financial year ending ',
            f('audit_year_end'),
            ' and that the directors be authorised to fix their remuneration.',
          ),
        ],
      },
    },
  },
  {
    key: 'fees',
    name: "Directors' fees",
    category: 'Members',
    usageContexts: ['board'],
    displayOrder: 20,
    description:
      'Approves a fee per director, or records that no fees are payable. Fictional sample wording.',
    content: {
      fields: [
        question('fees_payable', "Directors' fees are payable for the year", 'boolean'),
        question('fee_year_end', 'Financial year ending', 'date', { format: { date: 'long' } }),
        question('fee_directors', 'Directors receiving fees', 'recordList', {
          record: { context: 'currentDirectors' },
        }),
        question('fee_amount', 'Fee', 'number', {
          repeatScope: 'fee_directors',
          format: { decimals: 2, prefix: 'RM ' },
          validation: { min: '0' },
        }),
        {
          id: 'fee_total',
          label: 'Total fees',
          valueType: 'number',
          source: { kind: 'derived', op: 'sum', fieldId: 'fee_amount' },
          scope: 'clause',
          required: true,
          format: { decimals: 2, prefix: 'RM ' },
        },
      ],
      wordings: {
        members_written: [
          p(t("Directors' fees", 'bold')),
          when(
            { op: 'isTrue', fieldId: 'fees_payable' },
            p(
              "THAT the payment of directors' fees of ",
              f('fee_total'),
              ' for the financial year ending ',
              f('fee_year_end'),
              ' be approved, payable as follows:',
            ),
            repeat('fee_directors', {
              type: 'table',
              columnWidths: [70, 30],
              rows: [
                {
                  header: true,
                  cells: [
                    [p('Director')],
                    [{ type: 'paragraph', align: 'right', content: [t('Fee')] }],
                  ],
                },
                {
                  cells: [
                    [p(f('fee_directors', 'name'))],
                    [{ type: 'paragraph', align: 'right', content: [f('fee_amount')] }],
                  ],
                },
              ],
            }),
            {
              type: 'table',
              columnWidths: [70, 30],
              rows: [
                {
                  cells: [
                    [p(t('Total', 'bold'))],
                    [{ type: 'paragraph', align: 'right', content: [f('fee_total')] }],
                  ],
                },
              ],
            },
          ),
          when(
            { op: 'isFalse', fieldId: 'fees_payable' },
            p(
              "THAT no directors' fees be paid for the financial year ending ",
              f('fee_year_end'),
              '.',
            ),
          ),
        ],
        directors_written: [
          p(t("Directors' fees", 'bold')),
          when(
            { op: 'isTrue', fieldId: 'fees_payable' },
            p(
              "THAT the directors recommend to the members the payment of directors' fees totalling ",
              f('fee_total'),
              ' for the financial year ending ',
              f('fee_year_end'),
              ', namely:',
            ),
            repeat('fee_directors', {
              type: 'table',
              columnWidths: [70, 30],
              rows: [
                {
                  header: true,
                  cells: [
                    [p('Director')],
                    [{ type: 'paragraph', align: 'right', content: [t('Fee')] }],
                  ],
                },
                {
                  cells: [
                    [p(f('fee_directors', 'name'))],
                    [{ type: 'paragraph', align: 'right', content: [f('fee_amount')] }],
                  ],
                },
              ],
            }),
          ),
          when(
            { op: 'isFalse', fieldId: 'fees_payable' },
            p(
              "THAT the directors recommend that no directors' fees be paid for the financial year ending ",
              f('fee_year_end'),
              '.',
            ),
          ),
        ],
      },
    },
  },
  {
    key: 'authority',
    name: 'Authority to sign documents',
    category: 'Other',
    usageContexts: ['board', 'director_appointment', 'director_resignation'],
    displayOrder: 10,
    description: 'Authorises one director to sign named documents. Fictional sample wording.',
    content: {
      fields: [
        question('authorised_director', 'Authorised director', 'recordReference', {
          record: { context: 'currentDirectors' },
        }),
        question('documents_to_sign', 'Documents to sign', 'text', {
          validation: { maxLength: 300 },
        }),
      ],
      wordings: {
        directors_written: [
          p(t('Authority to sign documents', 'bold')),
          p(
            'THAT ',
            f('authorised_director', 'name'),
            ' be authorised to sign ',
            f('documents_to_sign'),
            ' and any other document needed to give effect to these resolutions.',
          ),
        ],
        members_written: [
          p(t('Authority to sign documents', 'bold')),
          p(
            'THAT ',
            f('authorised_director', 'name'),
            ' be authorised to sign ',
            f('documents_to_sign'),
            ' on behalf of the Company.',
          ),
        ],
      },
    },
  },
  {
    key: 'general',
    name: 'General business',
    category: 'Other',
    usageContexts: ['board'],
    displayOrder: 20,
    description:
      'Free-text resolution for business with no library clause. Fictional sample wording.',
    content: {
      fields: [
        question('business_title', 'Heading', 'text', { validation: { maxLength: 120 } }),
        question('business_text', 'Resolution text', 'multiline', {
          validation: { maxLength: 4000 },
        }),
      ],
      wordings: {
        directors_written: [p(f('business_title')), p(f('business_text'))],
        members_written: [p(f('business_title')), p(f('business_text'))],
      },
    },
  },
];

// ---------------------------------------------------------------- starter assemblies
export type StarterAssembly = {
  key: string;
  name: string;
  outputTypeId: string;
  usageContexts: UsageContext[];
  description: string;
  starterKeys: string[];
  content: Pick<AssemblyVersion, 'header' | 'closing' | 'signature' | 'fields' | 'layout'>;
};
const companyFields = (authority: 'directorAuthority' | 'memberAuthority'): FieldDefinition[] => [
  bound('company_name', 'Company name', 'company.name', {
    scope: 'case',
    format: { case: 'upper' },
  }),
  bound('company_number', 'Registration number', 'company.registrationNumber', { scope: 'case' }),
  bound(
    authority === 'directorAuthority' ? 'director_authority' : 'member_authority',
    authority === 'directorAuthority'
      ? "Directors' authority citation"
      : "Members' authority citation",
    `company.citation.${authority}`,
    { scope: 'case' },
  ),
  resolutionDate,
];
const companyBlock: BlockNode[] = [
  pc(f('company_name')),
  pc('(Registration No. ', f('company_number'), ')'),
];
const directorsAssembly = (title: string): StarterAssembly['content'] => ({
  fields: companyFields('directorAuthority'),
  header: [
    ...companyBlock,
    h(1, title, 'center'),
    p(
      'Pursuant to ',
      f('director_authority'),
      ', we, the undersigned, being all the directors of the Company, resolve as follows:',
    ),
    { type: 'clauseSlot', numbering: 'decimal' },
  ],
  closing: [
    p('Dated: ', f('resolution_date')),
    { type: 'signatureBlock', role: 'directors', heading: 'Directors' },
  ],
  signature: { columns: 2, showDate: false, label: '{name}\nDirector' },
  layout: {
    ...defaultLayout,
    header: [f('company_name')],
    footer: [t(`${title} — ${SAMPLE_SOURCE}`)],
  },
});
// ---------------------------------------------------------------- director appointment set
const incorporatedBlock: BlockNode[] = [
  pc(f('company_name')),
  pc('Registration No. ', f('company_number')),
  pc('(Incorporated in Malaysia)'),
];
const plainCompanyFields: FieldDefinition[] = [
  bound('company_name', 'Company name', 'company.name', {
    scope: 'case',
    format: { case: 'upper' },
  }),
  bound('company_number', 'Registration number', 'company.registrationNumber', { scope: 'case' }),
];
const sampleLayout = (title: string): AssemblyVersion['layout'] => ({
  ...defaultLayout,
  header: [],
  footer: [t(`${title} — ${SAMPLE_SOURCE}`)],
});
/** The firm's circular resolution style: no numbering, "BOARD OF DIRECTORS" signatures. */
const circularAssembly = (title: string): StarterAssembly['content'] => ({
  fields: [...plainCompanyFields],
  header: [...incorporatedBlock, p(t(title, 'bold')), { type: 'clauseSlot', numbering: 'none' }],
  closing: [
    { type: 'signatureBlock', role: 'directors', heading: 'BOARD OF DIRECTORS:-' },
    p('Date:'),
  ],
  signature: { columns: 2, showDate: false, label: '{name}' },
  layout: sampleLayout(title),
});
const firmField = (id: string, label: string, path: string) =>
  bound(id, label, path, { scope: 'case', required: false });
const lodgerFields: FieldDefinition[] = [
  question('lodger', 'Company secretary lodging', 'recordReference', {
    scope: 'case',
    record: { context: 'companySecretaries' },
  }),
  bound('lodger_name', 'Lodger name', 'selection.lodger.name', {
    scope: 'case',
    format: { case: 'upper' },
  }),
  bound('lodger_licence', 'Lodger licence', 'selection.lodger.secretaryLicence', {
    scope: 'case',
    required: false,
  }),
  bound(
    'lodger_certificate',
    'Lodger practising certificate',
    'selection.lodger.practisingCertificate',
    {
      scope: 'case',
      required: false,
    },
  ),
  bound('lodger_identity', 'Lodger NRIC', 'selection.lodger.identityNumber', {
    scope: 'case',
    required: false,
  }),
  firmField('firm_name', 'Firm name', 'firm.name'),
  firmField('firm_registration', 'Firm registration number', 'firm.registrationNumber'),
  firmField('firm_address', 'Firm address', 'firm.address'),
  firmField('firm_phone', 'Firm phone', 'firm.phone'),
  firmField('firm_email', 'Firm email', 'firm.email'),
];
const row = (...cells: (string | InlineNode)[][]) => ({
  cells: cells.map((parts) => [p(...parts)]),
});
const lodgerTable: BlockNode = {
  type: 'table',
  border: 'none',
  columnWidths: [22, 3, 75],
  rows: [
    row(['Name'], [':'], [f('lodger_name'), ' (', f('lodger_licence'), ')']),
    row(['SSM PC no.'], [':'], [f('lodger_certificate')]),
    row(['NRIC No'], [':'], [f('lodger_identity')]),
    row(
      ['Company'],
      [':'],
      [f('firm_name'), { type: 'hardBreak' }, 'Registration No. ', f('firm_registration')],
    ),
    row(['Address'], [':'], [f('firm_address')]),
    row(['Phone No'], [':'], [f('firm_phone')]),
    row(['Email'], [':'], [f('firm_email')]),
  ],
};

const s201Fields: FieldDefinition[] = [
  ...plainCompanyFields,
  appointee,
  appointeeName,
  appointeeParticular('identityNumber', 'Proposed director NRIC or passport number'),
  question('leave_paragraph', 'Leave of the court (paragraphs 4 and 5)', 'choice', {
    scope: 'case',
    options: [
      { id: 'none', label: 'Neither applies' },
      { id: 'bankrupt_leave', label: 'Undischarged bankrupt with leave under section 198(3)(b)' },
      { id: 'court_leave', label: 'Leave of the court under section 198' },
    ],
    defaultValue: 'none',
  }),
  question('leave_corporation', 'Corporation named in the court order', 'text', {
    scope: 'case',
    required: false,
  }),
  question('declarant_capacity', 'Signing as', 'choice', {
    scope: 'case',
    options: [
      { id: 'director', label: 'Director(s)' },
      { id: 'promoter', label: 'Promoter(s)' },
    ],
    defaultValue: 'director',
  }),
];
const numbered = (n: string, ...content: BlockNode[]) => ({ cells: [[p(`${n}.`)], content] });
const leaveIs = (id: string): Predicate => ({
  op: 'equals',
  fieldId: 'leave_paragraph',
  value: id,
});
const notLeave = (id: string): Predicate => ({
  op: 'notEquals',
  fieldId: 'leave_paragraph',
  value: id,
});
const s201Declaration: StarterAssembly['content'] = {
  fields: s201Fields,
  header: [
    p('Registration No.'),
    p(f('company_number')),
    pc(t('COMPANIES ACT 2016', 'bold')),
    pc(t('Section 201', 'bold')),
    pc(
      t(
        'DECLARATION BY A PERSON BEFORE APPOINTMENT AS DIRECTOR, OR BY A PROMOTER BEFORE INCORPORATION OF CORPORATION',
        'bold',
      ),
    ),
    pc(f('company_name')),
    {
      type: 'table',
      border: 'grid',
      columnWidths: [8, 92],
      rows: [
        { header: true, cells: [[pc(t('No.', 'bold'))], [pc(t('DECLARATION', 'bold'))]] },
        { cells: [[p('')], [p('I solemnly and sincerely declare that:')]] },
        numbered('1', p('I am not an undischarged bankrupt.')),
        numbered(
          '2',
          p('I have not been convicted whether within or outside Malaysia of any offence:'),
          {
            type: 'list',
            ordered: false,
            items: [
              [
                p(
                  '(a) in connection with the promotion, formation or management of a corporation;',
                ),
              ],
              [p('(b) involving bribery, fraud or dishonesty; or')],
              [
                p(
                  '(c) under section 213, 217, 218, 228 or 539, within a period of five years preceding the date of this declaration.',
                ),
              ],
            ],
          },
        ),
        numbered(
          '3',
          p(
            'I have not been imprisoned for any offence referred to in paragraph 2 within the period of five years immediately preceding the date of this declaration.',
          ),
        ),
        // Paragraphs 4 and 5 are struck out unless chosen, as on the printed form.
        numbered(
          '4',
          when(
            leaveIs('bankrupt_leave'),
            p(
              '*I am an undischarged bankrupt but have been granted leave by the court under section 198(3)(b) to act as a director of ',
              f('leave_corporation'),
              '.',
            ),
          ),
          when(
            notLeave('bankrupt_leave'),
            p(
              t(
                '*I am an undischarged bankrupt but have been granted leave by the court under section 198(3)(b) to act as a director of ................ (name of corporation)',
                'strike',
              ),
            ),
          ),
        ),
        numbered(
          '5',
          when(
            leaveIs('court_leave'),
            p(
              '*I have been granted leave by Court under section 198 to be a director of ',
              f('leave_corporation'),
              '. I attach herewith an office copy of the court order.',
            ),
          ),
          when(
            notLeave('court_leave'),
            p(
              t(
                '*I have been granted leave by Court under section 198 to be a director of ................ (name of corporation) or a promoter of ................ (name of proposed corporation). I attach herewith an office copy of the court order.',
                'strike',
              ),
            ),
          ),
          p(t('*Strike out whichever is inapplicable', 'italic')),
        ),
        numbered(
          '6', // No full stop: Malaysian company names already end in "Bhd.".
          p('I hereby consent to act as director of ', f('company_name')),
        ),
      ],
    },
    p('I confirm that the facts and information stated in this document are true.'),
    p(
      'Sign by ',
      { type: 'choiceText', fieldId: 'declarant_capacity', style: 'strikeOthers' },
      ':',
    ),
    // Every layout has a clause slot; this form has no clauses, so it prints nothing.
    { type: 'clauseSlot', numbering: 'none' },
  ],
  closing: [
    { type: 'signatureBlock', role: 'subject' },
    {
      type: 'signatureBlock',
      role: 'witness',
      heading: 'In the presence of a Solicitor/ Notary Public/ Commissioner for Oaths:-',
    },
  ],
  signature: {
    columns: 1,
    showDate: false,
    label: 'Name: {name}\nPassport/NRIC No.: {identityNumber}\nDate of Declaration:',
  },
  layout: sampleLayout('Section 201 declaration'),
};

const disclosureFields: FieldDefinition[] = [
  ...plainCompanyFields,
  appointee,
  appointeeName,
  appointeeParticular('identityNumber', 'NRIC or passport number'),
  appointeeParticular('passportExpiry', 'Passport expiry date', {
    required: false,
    valueType: 'date',
    format: { date: 'long' },
  }),
  appointeeParticular('dateOfBirth', 'Date of birth', {
    valueType: 'date',
    format: { date: 'long' },
  }),
  appointeeParticular('gender', 'Gender'),
  appointeeParticular('race', 'Race'),
  appointeeParticular('nationality', 'Nationality'),
  appointeeParticular('occupation', 'Business occupation'),
  appointeeParticular('residentialAddress', 'Residential address'),
  appointeeParticular('serviceAddress', 'Service address'),
  appointeeParticular('serviceEmail', 'Service email', { required: false }),
  appointeeParticular('otherDirectorships', 'Other directorships', { required: false }),
  question('director_status', 'New or existing director', 'choice', {
    scope: 'case',
    options: [
      { id: 'new', label: 'new' },
      { id: 'existing', label: 'existing' },
    ],
    defaultValue: 'new',
  }),
  question('notice_particulars', 'Section I: particulars for the register', 'boolean', {
    scope: 'case',
    defaultValue: true,
  }),
  question('notice_interests', 'Section II: interests in shares and debentures', 'boolean', {
    scope: 'case',
    defaultValue: true,
  }),
  question(
    'notice_contracts',
    'Section III: interests in contracts, property and offices',
    'boolean',
    {
      scope: 'case',
      defaultValue: true,
    },
  ),
  question('interest_details', 'Interests in the company or related corporations', 'multiline', {
    scope: 'case',
    required: false,
    help: 'Leave blank when there are none; the notice then reads N/A.',
  }),
  question('contract_details', 'Interests in contracts, property or offices', 'multiline', {
    scope: 'case',
    required: false,
    help: 'Leave blank when there are none; the notice then reads N/A.',
  }),
];
const boxed = (...content: BlockNode[]): BlockNode => ({
  type: 'table',
  border: 'outer',
  rows: [{ cells: [content] }],
});
const tick = (fieldId: string, text: string) => ({
  cells: [[p({ type: 'checkbox', fieldId })], [p(text)]],
});
const particular = (label: string, ...value: (string | InlineNode)[]) => ({
  cells: [[p(label)], [p(...value)]],
});
const naUnlessAnswered = (fieldId: string): BlockNode[] => [
  when({ op: 'isNotEmpty', fieldId }, p(f(fieldId))),
  when({ op: 'isEmpty', fieldId }, p('N/A')),
];
const disclosureNotice: StarterAssembly['content'] = {
  fields: disclosureFields,
  header: [
    boxed(
      pc(
        t(
          'NOTICE OF DISCLOSURE BY NEW/EXISTING DIRECTOR UNDER SECTIONS 57, 58, 59, 219 AND 221 OF THE COMPANIES ACT 2016 ("THE ACT")',
          'bold',
        ),
      ),
    ),
    boxed(
      p(
        'To the Board of Directors and Company Secretary of ',
        f('company_name'),
        ' [Registration No.: ',
        f('company_number'),
        '] ("the Company")',
      ),
    ),
    p(
      'I, ',
      f('appointee_name'),
      ', being a ',
      { type: 'choiceText', fieldId: 'director_status', style: 'strikeOthers' },
      ' Director of the Company, hereby give you notice of the following particulars as required under the Act:',
    ),
    {
      type: 'table',
      border: 'none',
      columnWidths: [8, 92],
      rows: [
        tick(
          'notice_particulars',
          'Particulars of Director required for the Register of Directors (Section I)',
        ),
        tick(
          'notice_interests',
          "Disclosure of Director's particulars relating to shares, debentures, participatory interests, rights, options and contracts under Section 219(1) of the Act in the Company and/or related companies for inclusion in the Register of Directors' Shareholdings, etc. (Section II)",
        ),
        tick(
          'notice_contracts',
          'Disclosure of interest in contracts, proposed contracts, property, offices, etc. (Section III)',
        ),
      ],
    },
    p(t('Please tick (✓) the appropriate box.', 'italic')),
    when(
      { op: 'isTrue', fieldId: 'notice_particulars' },
      { type: 'pageBreak' },
      boxed(
        p(
          t(
            'SECTION I: Sections 57 and 58 of the Act — Particulars of Director required for the Register of Directors',
            'bold',
          ),
        ),
        p(
          t(
            'A new or existing Director shall, as soon as practicable, notify the Company of his or her particulars so that the Company can update the Register of Directors and notify the Registrar of Companies (fictional sample summary).',
            'italic',
          ),
        ),
      ),
      pc(
        t(
          'PARTICULARS OF DIRECTOR REQUIRED FOR REGISTER OF DIRECTORS PURSUANT TO SECTIONS 57 AND 58 OF THE COMPANIES ACT 2016',
          'bold',
        ),
      ),
      {
        type: 'table',
        border: 'grid',
        columnWidths: [40, 60],
        rows: [
          particular('(i) Name', f('appointee_name')),
          particular('(ii) NRIC/ Passport No.', f('appointee_identity_number')),
          particular('(iii) Passport No. Expiry Date', f('appointee_passport_expiry')),
          particular('(iv) Date of Birth', f('appointee_date_of_birth')),
          particular('(v) Gender', f('appointee_gender')),
          particular('(vi) Race', f('appointee_race')),
          particular('(vii) Nationality', f('appointee_nationality')),
          particular('(viii) Business Occupation', f('appointee_occupation')),
          particular('(ix) Residential Address', f('appointee_residential_address')),
          particular(
            '(x) Service Address',
            f('appointee_service_address'),
            { type: 'hardBreak' },
            f('appointee_service_email'),
          ),
          particular('(xi) Other directorships', f('appointee_other_directorships')),
        ],
      },
      { type: 'signatureBlock', role: 'subject' },
    ),
    when(
      { op: 'isTrue', fieldId: 'notice_interests' },
      { type: 'pageBreak' },
      boxed(
        p(
          t(
            'SECTION II: Sections 59 and 219 of the Act — Disclosure of Director’s interests',
            'bold',
          ),
        ),
        p(
          t(
            'A Director shall notify the Company of his or her interests in shares, debentures, participatory interests, rights, options and contracts in the Company and its related corporations (fictional sample summary).',
            'italic',
          ),
        ),
      ),
      p(
        'I, ',
        f('appointee_name'),
        ', declare my interests in the Company and/or related corporations as per the Notice of Director’s Interests enclosed.',
      ),
      { type: 'section', orientation: 'landscape' },
      pc(
        t(
          "NOTICE OF DIRECTOR'S INTERESTS IN SHARES, DEBENTURES, PARTICIPATORY INTERESTS, RIGHTS, OPTIONS AND CONTRACTS IN THE COMPANY OR ITS RELATED CORPORATIONS PURSUANT TO SECTIONS 59 AND 219 OF THE ACT",
          'bold',
        ),
      ),
      p('Name of Company: ', f('company_name')),
      p('Name of Director: ', f('appointee_name')),
      {
        type: 'table',
        border: 'grid',
        columnWidths: [16, 14, 10, 10, 12, 14, 12, 12],
        rows: [
          {
            header: true,
            cells: [
              [p('Name of Company')],
              [p('Description of Interest')],
              [p('Direct')],
              [p('Indirect')],
              [p('Consideration (RM)')],
              [p('How held')],
              [p('Date acquired')],
              [p('Date ceased')],
            ],
          },
          {
            cells: [
              naUnlessAnswered('interest_details'),
              [p('')],
              [p('')],
              [p('')],
              [p('')],
              [p('')],
              [p('')],
              [p('')],
            ],
          },
        ],
      },
      { type: 'signatureBlock', role: 'subject' },
      { type: 'section', orientation: 'portrait' },
    ),
    when(
      { op: 'isTrue', fieldId: 'notice_contracts' },
      { type: 'pageBreak' },
      boxed(
        p(
          t(
            'SECTION III: Section 221 of the Act — Disclosure of interest in contracts, property, offices, etc.',
            'bold',
          ),
        ),
        p(
          t(
            'A Director who is interested in a contract or proposed contract with the Company, or holds an office or property that may create a conflict, shall disclose it to the Board (fictional sample summary).',
            'italic',
          ),
        ),
      ),
      ...naUnlessAnswered('contract_details'),
      { type: 'signatureBlock', role: 'subject' },
    ),
    // Every layout has a clause slot; this form has no clauses, so it prints nothing.
    { type: 'clauseSlot', numbering: 'none' },
  ],
  closing: [],
  signature: { columns: 1, showDate: true, label: 'Signature of Director\n{name}' },
  layout: {
    ...defaultLayout,
    header: [
      t('Notice of Disclosure by New/Existing Director under Companies Act 2016'),
      { type: 'hardBreak' },
      f('company_name'),
      { type: 'hardBreak' },
      t('Registration No.: '),
      f('company_number'),
    ],
    footer: [t(`Notice of disclosure — ${SAMPLE_SOURCE}`)],
  },
};

export const STARTER_ASSEMBLIES: StarterAssembly[] = [
  {
    key: 'directors',
    name: "Directors' written resolution",
    outputTypeId: 'directors_written',
    usageContexts: ['board', 'director_resignation'],
    description:
      'Header citing the directors’ authority, numbered clauses, directors’ signatures. Fictional sample.',
    starterKeys: [],
    content: directorsAssembly("DIRECTORS' WRITTEN RESOLUTION"),
  },
  {
    key: 'members',
    name: "Members' written resolution",
    outputTypeId: 'members_written',
    usageContexts: ['board'],
    description:
      'Header citing the members’ authority, numbered clauses, members’ signatures and a sample lapse notice.',
    starterKeys: [],
    content: {
      fields: [
        ...companyFields('memberAuthority'),
        {
          id: 'lapse_date',
          label: 'Lapse date',
          valueType: 'date',
          // No approved source for this period yet, so the value is labelled a sample.
          source: {
            kind: 'derived',
            op: 'addDays',
            fieldId: 'resolution_date',
            days: 28,
            sourceNote: '',
          },
          scope: 'case',
          required: true,
          format: { date: 'long' },
        },
      ],
      header: [
        ...companyBlock,
        h(1, "MEMBERS' WRITTEN RESOLUTION", 'center'),
        p(
          'Pursuant to ',
          f('member_authority'),
          ', we, the undersigned, being the members of the Company entitled to vote, resolve as follows:',
        ),
        { type: 'clauseSlot', numbering: 'decimal' },
      ],
      closing: [
        p('Dated: ', f('resolution_date')),
        { type: 'signatureBlock', role: 'members', heading: 'Members' },
        { type: 'pageBreak' },
        h(2, 'Notes for members (fictional sample)'),
        {
          type: 'list',
          ordered: true,
          items: [
            [p('Sign and return this resolution to the Company Secretary.')],
            [
              p(
                'This resolution lapses if it is not passed by ',
                f('lapse_date'),
                ' (sample period, no approved source).',
              ),
            ],
          ],
        },
      ],
      signature: { columns: 2, showDate: true, label: '{name}\nMember' },
      layout: {
        ...defaultLayout,
        header: [f('company_name')],
        footer: [t(`Members' written resolution — ${SAMPLE_SOURCE}`)],
      },
    },
  },
  {
    key: 'appointment',
    name: "Directors' circular resolution: appointment of director",
    outputTypeId: 'directors_written',
    usageContexts: ['director_appointment'],
    description:
      'Appointment of a director with authority to update the registers and lodge the change. Fictional sample.',
    starterKeys: ['appointment', 'appointment_registers'],
    content: circularAssembly(
      "DIRECTORS' CIRCULAR RESOLUTION IN WRITING MADE PURSUANT TO THE THIRD SCHEDULE OF THE COMPANIES ACT 2016",
    ),
  },
  {
    key: 'certified_extract',
    name: 'Certified extract: appointment of director',
    outputTypeId: 'directors_written',
    usageContexts: ['director_appointment'],
    description:
      'Certified extract of the appointment resolution, signed by a director and the secretary, with lodger details. Fictional sample.',
    starterKeys: ['appointment'],
    content: {
      fields: [...plainCompanyFields, resolutionDate, ...lodgerFields],
      header: [
        ...incorporatedBlock,
        p(
          t(
            "CERTIFIED EXTRACT OF THE DIRECTORS' CIRCULAR RESOLUTION IN WRITING MADE PURSUANT TO THE CONSTITUTION OF THE COMPANY DATED ",
            'bold',
          ),
          f('resolution_date'),
        ),
        { type: 'clauseSlot', numbering: 'none' },
      ],
      closing: [
        pc(t('CERTIFIED TRUE AND CORRECT:-', 'bold')),
        { type: 'signatureBlock', role: 'certifiers' },
        p('Date:'),
        pc(t('LODGER INFORMATION', 'bold')),
        lodgerTable,
      ],
      signature: {
        columns: 2,
        showDate: false,
        label: '{capacity}\n{name}\n{secretaryLicence}\nSSM PC NO.: {practisingCertificate}',
      },
      layout: sampleLayout('Certified extract'),
    },
  },
  {
    key: 's201_declaration',
    name: 'Section 201 declaration',
    outputTypeId: 'individual_form',
    usageContexts: ['director_appointment'],
    description:
      'Declaration and consent by a person before appointment as director, witnessed by a Commissioner for Oaths. Fictional sample.',
    starterKeys: [],
    content: s201Declaration,
  },
  {
    key: 'disclosure_notice',
    name: 'Notice of disclosure by director',
    outputTypeId: 'individual_form',
    usageContexts: ['director_appointment'],
    description:
      'Notice of particulars, interests in shares and interests in contracts by a new or existing director. Fictional sample.',
    starterKeys: [],
    content: disclosureNotice,
  },
  {
    key: 'annual_return',
    name: 'Annual return resolution',
    outputTypeId: 'directors_written',
    usageContexts: ['board'],
    description:
      "Directors' written resolution approving the annual return for lodgement. Fictional sample.",
    starterKeys: ['annual_return'],
    content: circularAssembly(
      "DIRECTORS' WRITTEN RESOLUTION PURSUANT TO THE THIRD SCHEDULE OF THE COMPANIES ACT 2016",
    ),
  },
  {
    key: 'resignation',
    name: 'Director resignation resolution',
    outputTypeId: 'directors_written',
    usageContexts: ['director_resignation'],
    description: 'Starter: resignation of a director plus authority to sign. Fictional sample.',
    starterKeys: ['resignation', 'authority'],
    content: directorsAssembly("DIRECTORS' WRITTEN RESOLUTION"),
  },
];

// ---------------------------------------------------------------- fictional context
const person = (
  id: string,
  name: string,
  capacity: string,
  appointedOn: string | null,
): PersonSnapshot => ({
  id,
  name,
  capacity,
  appointedOn,
  ceasedOn: null,
});
export function sampleContext(asAt = '2026-10-26'): ResolutionContext {
  const directors = [
    person('sample-d1', 'Nur Aisyah binti Abdullah Rahman (fictional)', 'Director', '2019-03-01'),
    person('sample-d2', 'Tan Wei Ming 陈伟明 (fictional)', 'Non-executive director', '2021-07-15'),
    person(
      'sample-d3',
      'Ravichandran a/l Subramaniam Pillai (fictional)',
      'Director',
      '2023-01-09',
    ),
  ];
  const members = [
    person('sample-m1', 'Example Holdings Nominees Sdn. Bhd. (fictional)', 'Member', null),
    person('sample-m2', 'Zoë Lefèvre-Østergaard (fictional)', 'Member', null),
    directors[0],
  ];
  return {
    asAt,
    preparedOn: '2026-10-26',
    firm: {
      name: 'Example Secretarial Services (fictional)',
      registrationNumber: '201901000001 (fictional)',
      address: '2 Example Avenue, 50000 Kuala Lumpur (fictional)',
      phone: '03-0000 0000 (fictional)',
      email: 'secretarial@example.invalid',
    },
    company: {
      id: 'sample-company',
      name: 'Example Holdings Sdn. Bhd. (fictional)',
      registrationNumber: '202601999999 (fictional)',
      address: '1 Example Road, 50000 Kuala Lumpur (fictional)',
      incorporationDate: '2019-03-01',
      financialYearEnd: '12-31',
      revision: 1,
      profileRevision: 1,
      citations: {
        directorAuthority: 'Clause 99 of the Constitution (fictional citation)',
        memberAuthority: 'Clause 98 of the Constitution (fictional citation)',
        electionAuthority: 'Clause 97 of the Constitution (fictional citation)',
      },
      custom: {},
    },
    case: {
      id: 'sample-case',
      kind: 'board',
      title: 'Sample resolution (fictional)',
      revision: 1,
      instructionDate: asAt,
      resolutionDate: asAt,
      effectiveDate: asAt,
      custom: {},
    },
    directors,
    members,
    companyPeople: [...directors, secretary],
    secretaries: [secretary],
    proposedPeople: [
      {
        ...person('sample-p1', 'Aminah binti Yusof (fictional)', 'Proposed director', null),
        particulars: {
          identityType: 'MyKad',
          identityNumber: '900101-14-0000',
          dateOfBirth: '1990-01-01',
          gender: 'Female',
          race: 'MALAY',
          nationality: 'MALAYSIA',
          occupation: 'Director',
          residentialAddress: '3 Example Lane, 47000 Sungai Buloh, Selangor (fictional)',
          serviceAddress: '3 Example Lane, 47000 Sungai Buloh, Selangor (fictional)',
          serviceEmail: 'aminah@example.invalid',
        },
        otherDirectorships: 'Example Trading Sdn. Bhd. (fictional) (appointed 1 March 2020)',
      },
    ],
  };
}
const secretary: PersonSnapshot = {
  ...person('sample-s1', 'Lim Siew Ling (fictional secretary)', 'Secretary', '2019-03-01'),
  particulars: {
    identityType: 'MyKad',
    identityNumber: '850505-10-0000',
    secretaryBody: 'Malaysian Institute of Chartered Secretaries and Administrators (MAICSA)',
    secretaryLicence: 'MAICSA 0000000 (fictional)',
    practisingCertificate: '202000000000 (fictional)',
  },
};

/** Plausible fictional answers for every question, by type. */
export function sampleAnswers(fields: FieldDefinition[], ctx: ResolutionContext): Answers {
  const answers: Answers = {};
  const pool = (field: FieldDefinition) =>
    field.record?.context === 'currentMembers'
      ? ctx.members
      : field.record?.context === 'companyPeople'
        ? ctx.companyPeople
        : field.record?.context === 'companySecretaries'
          ? (ctx.secretaries ?? [])
          : field.record?.context === 'proposedPerson'
            ? ctx.proposedPeople
            : ctx.directors;
  for (const field of fields) {
    if (field.source.kind !== 'question') continue;
    if (field.repeatScope) {
      const list = fields.find((x) => x.id === field.repeatScope);
      const rows: Record<string, AnswerValue> = {};
      (list ? pool(list) : []).forEach((item, i) => (rows[item.id] = sampleScalar(field, i)));
      answers[field.id] = rows;
    } else if (field.valueType === 'recordReference')
      answers[field.id] = pool(field)[0]?.id ?? null;
    else if (field.valueType === 'recordList') answers[field.id] = pool(field).map((x) => x.id);
    else answers[field.id] = sampleScalar(field, 0);
  }
  return answers;
}
function sampleScalar(field: FieldDefinition, index: number): AnswerValue {
  switch (field.valueType) {
    case 'boolean':
      return true;
    case 'date':
      return '2026-11-02';
    case 'number':
      return ['1000.10', '2000.25', '1500.00'][index % 3];
    case 'choice':
      return field.options?.[0]?.id ?? null;
    case 'multiChoice':
      return field.options?.slice(0, 1).map((o) => o.id) ?? [];
    case 'multiline':
      return `Sample ${field.label.toLowerCase()} (fictional).\nSecond line of sample text.`;
    default:
      return `Sample ${field.label.toLowerCase()} (fictional)`;
  }
}
export function sampleSigners(ctx: ResolutionContext): SignerSelection {
  return {
    directors: ctx.directors.map((d) => d.id),
    members: ctx.members.map((m) => m.id),
    // A certified extract is signed by a director and the secretary.
    certifiers: [
      ...ctx.companyPeople.slice(0, 1).map((p) => p.id),
      ...(ctx.secretaries ?? []).slice(0, 1).map((p) => p.id),
    ],
    subject: ctx.proposedPeople.slice(0, 1).map((p) => p.id),
  };
}
