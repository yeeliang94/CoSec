'use client';
import { useId, useState } from 'react';
import {
  PARTICULAR_KEYS,
  type AddressGroup,
  type CompanyRelationship,
  type ParticularKey,
  type Person,
  type RelationshipRole,
} from '@/domain/resolution/model';
import {
  addressGroupLabel,
  addressKey,
  addressOf,
  DATE_PARTICULARS,
  formatAddress,
  formatIdentity,
  IDENTITY_KEYS,
  isAddressEmpty,
  MALAYSIA,
  PASSPORT,
  particularLabel,
  particularOptions,
  particularsAt,
  validateParticulars,
} from '@/domain/resolution/particulars';
import { entryAt } from '@/domain/resolution/records';
import { currentDate, formatDate } from '@/components/workspace';
import { WarningLine } from '@/components/warning-line';
import { newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';

/** Which parts of the particulars apply to someone, from their kind and roles. */
export function particularScope(person: Pick<Person, 'kind'>, roles: RelationshipRole[]) {
  const organisation = person.kind === 'organisation';
  return {
    organisation,
    secretary: roles.includes('secretary'),
    director: roles.includes('director'),
    member: roles.includes('member'),
    auditor: roles.includes('auditor'),
    // mTool asks managers and secretaries for a business address.
    business: roles.includes('secretary') || roles.includes('manager'),
  };
}
type Scope = ReturnType<typeof particularScope>;

const IDENTITY_ROWS: ParticularKey[] = [
  'title',
  'identityType',
  'identityNumber',
  'passportExpiry',
  'dateOfBirth',
  'gender',
  'race',
  'nationality',
  'analysis',
];
const ORGANISATION_ROWS: ParticularKey[] = [
  'identityType',
  'identityNumber',
  'auditFirmNumber',
  'placeOfIncorporation',
  'analysis',
];
const SECRETARY_ROWS: ParticularKey[] = [
  'secretaryBody',
  'secretaryLicence',
  'practisingCertificate',
];

function addressGroups(scope: Scope, values: Record<string, string | undefined>): AddressGroup[] {
  if (scope.organisation) return ['registered'];
  const has = (group: AddressGroup) => !isAddressEmpty(addressOf(values, group));
  return [
    'residential',
    'service',
    ...(scope.business || has('business') ? (['business'] as const) : []),
  ];
}

/** The particulars in force today, one per row, with the date each applies from. */
export function PersonParticulars({
  person,
  relationships,
  canManage,
  canViewIdentity,
  onEdit,
}: {
  person: Person;
  relationships: CompanyRelationship[];
  canManage: boolean;
  canViewIdentity: boolean;
  onEdit: () => void;
}) {
  const today = currentDate();
  const values = particularsAt(person, today);
  const scope = particularScope(
    person,
    relationships.map((r) => r.role),
  );
  const kind = person.kind ?? 'individual';
  const rows: { key: string; label: string; text: string; from: string }[] = [];
  const from = (key: ParticularKey) => {
    const entry = entryAt(person.particulars?.[key], today);
    return entry ? formatDate(entry.effectiveDate) : '';
  };
  const plain = (key: ParticularKey) => {
    const value = values[key];
    // Without view_identity the API blanks these dates; say so instead of showing nothing.
    const hidden =
      !canViewIdentity &&
      !value &&
      entryAt(person.particulars?.[key], today) &&
      (IDENTITY_KEYS as readonly string[]).includes(key);
    const text = value
      ? DATE_PARTICULARS.includes(key)
        ? formatDate(value)
        : key === 'identityNumber'
          ? formatIdentity(values.identityType, value)
          : value
      : hidden
        ? 'Hidden'
        : '';
    rows.push({ key, label: particularLabel(key, kind), text, from: text ? from(key) : '' });
  };
  const identity = scope.organisation ? ORGANISATION_ROWS : IDENTITY_ROWS;
  for (const key of identity) {
    if (key === 'passportExpiry' && values.identityType !== PASSPORT && !values[key]) continue;
    if (key === 'auditFirmNumber' && !scope.auditor && !values[key]) continue;
    if (key === 'analysis' && !scope.member && !values[key]) continue;
    plain(key);
  }
  for (const group of addressGroups(scope, values)) {
    const same = group === 'service' && values.serviceSameAsResidential === 'Yes';
    const text = same ? 'Same as residential address' : formatAddress(addressOf(values, group));
    rows.push({
      key: group,
      label: addressGroupLabel(group),
      text,
      from: text ? from(same ? 'serviceSameAsResidential' : addressKey(group, 'Line1')) : '',
    });
  }
  plain('serviceEmail');
  if (!scope.organisation) plain('occupation');
  if (scope.secretary || SECRETARY_ROWS.some((k) => values[k])) SECRETARY_ROWS.forEach(plain);
  const warning = validateParticulars(values, kind).find((i) => i.severity === 'warning');
  return (
    <section className="section">
      <div className="person-section-heading">
        <h3>Particulars</h3>
        {canManage ? (
          <button type="button" onClick={onEdit}>
            Edit particulars
          </button>
        ) : null}
      </div>
      {warning ? <WarningLine>{warning.message}</WarningLine> : null}
      <div className="table-wrap">
        <table className="records-table person-particulars-table">
          <caption className="sr-only">Particulars in force today</caption>
          <thead>
            <tr>
              <th className="col-particular">Particular</th>
              <th>Value</th>
              <th className="col-date">From</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td title={row.text}>{row.text}</td>
                <td>{row.from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ParticularForm = Record<ParticularKey, string>;
const emptyParticulars = () =>
  Object.fromEntries(PARTICULAR_KEYS.map((key) => [key, ''])) as ParticularForm;

/**
 * Side panel that records particulars as dated values. Used from the person page and from the
 * annual return, where `missing` marks the fields mTool will reject and `saveLabel` names where
 * the change is saved. `asAt` loads the values in force on that date and starts the change from
 * it, so the annual return edits what it reads as at its return date.
 */
export function ParticularsEdit({
  person,
  roles,
  canViewIdentity,
  onSaved,
  onClose,
  missing = [],
  title = 'Edit particulars',
  saveLabel = 'Save particulars',
  asAt,
}: {
  person: Person;
  roles: RelationshipRole[];
  canViewIdentity: boolean;
  onSaved: () => Promise<void>;
  onClose: () => void;
  missing?: readonly ParticularKey[];
  title?: string;
  saveLabel?: string;
  /** Load and record as at this date (YYYY-MM-DD) instead of today. */
  asAt?: string;
}) {
  const edit = useAction();
  const warningId = useId();
  const kind = person.kind ?? 'individual';
  const scope = particularScope(person, roles);
  const [initialDate] = useState(() => asAt ?? currentDate());
  const [initial] = useState<ParticularForm>(() => ({
    ...emptyParticulars(),
    ...particularsAt(person, initialDate),
  }));
  const [form, setForm] = useState<ParticularForm>(initial);
  const [effectiveDate, setEffectiveDate] = useState(initialDate);
  const [reason, setReason] = useState('');
  const passport = form.identityType === PASSPORT;
  // A passport expiry no longer applies once the ID type is not a passport.
  const submitted: ParticularForm =
    passport || kind === 'organisation' ? form : { ...form, passportExpiry: '' };
  const changes = PARTICULAR_KEYS.filter((key) => submitted[key].trim() !== initial[key].trim());
  const issues = validateParticulars(
    canViewIdentity
      ? submitted
      : // Hidden values are unknown here; the server checks them against the stored ones.
        Object.fromEntries(
          PARTICULAR_KEYS.filter(
            (k) => !(IDENTITY_KEYS as readonly string[]).includes(k) || changes.includes(k),
          ).map((k) => [k, submitted[k]]),
        ),
    kind,
  );
  const dirty = Boolean(changes.length || reason || effectiveDate !== initialDate);
  const lateDate = Boolean(asAt && effectiveDate && effectiveDate > asAt);
  const set = (key: ParticularKey) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const input = (key: ParticularKey, label = particularLabel(key, kind)) => {
    const options = particularOptions(key, kind);
    const value = form[key];
    const onChange = set(key);
    const empty = missing.includes(key) && !value.trim();
    const issue = issues.find((i) => i.key === key);
    const describedBy = issue ? `${warningId}-${key}` : undefined;
    const control = options ? (
      <select
        value={value}
        aria-invalid={empty || undefined}
        aria-describedby={describedBy}
        className={empty ? 'missing' : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {/* A stored value outside the list stays visible so it is not lost silently. */}
        {value && !options.includes(value) ? <option value={value}>{value}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : (
      <input
        type={DATE_PARTICULARS.includes(key) ? 'date' : key === 'serviceEmail' ? 'email' : 'text'}
        maxLength={255}
        inputMode={key.endsWith('Postcode') ? 'numeric' : undefined}
        aria-invalid={empty || undefined}
        aria-describedby={describedBy}
        className={empty ? 'missing' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
    const field = (
      <label key={key}>
        {label}
        {control}
      </label>
    );
    return issue ? (
      <div key={key}>
        {field}
        <WarningLine field blocking={issue.severity === 'error'} id={describedBy}>
          {issue.message}
        </WarningLine>
      </div>
    ) : (
      field
    );
  };
  const address = (group: AddressGroup) => {
    const malaysia = form[addressKey(group, 'Country')] === MALAYSIA;
    return (
      <>
        {input(addressKey(group, 'Line1'), 'Line 1')}
        {input(addressKey(group, 'Line2'), 'Line 2')}
        {input(addressKey(group, 'Line3'), 'Line 3')}
        {input(addressKey(group, 'Country'), 'Country')}
        {input(addressKey(group, 'Postcode'), malaysia ? 'Postcode' : 'Postcode (optional)')}
        {input(addressKey(group, 'Town'), malaysia ? 'Town' : 'Town (optional)')}
        {malaysia || form[addressKey(group, 'State')]
          ? input(addressKey(group, 'State'), 'State')
          : null}
      </>
    );
  };
  const groups = addressGroups(scope, form);
  return (
    <Drawer title={title} onClose={onClose}>
      <form
        className="form-stack grouped-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const values = Object.fromEntries(
            changes.map((key) => [key, submitted[key].trim() || null]),
          );
          const ok = await edit.run(() =>
            postJson('/api/people', {
              action: 'set_particulars',
              id: person.id,
              expectedRevision: person.revision,
              requestId: newRequestId(),
              values,
              effectiveDate,
              reason: reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {scope.organisation ? (
          <fieldset className="form-group">
            <legend>Organisation</legend>
            <div className="form-stack">
              {input('identityType')}
              {input('identityNumber')}
              {scope.auditor || form.auditFirmNumber ? input('auditFirmNumber') : null}
              {input('placeOfIncorporation')}
              {scope.member || form.analysis ? input('analysis') : null}
            </div>
          </fieldset>
        ) : (
          <fieldset className="form-group">
            <legend>Identity</legend>
            <div className="form-stack">
              {input('title', 'Title (optional)')}
              {input('identityType')}
              {input('identityNumber')}
              {passport ? input('passportExpiry') : null}
              {input('nationality')}
              {input('race')}
              {scope.member || form.analysis ? input('analysis') : null}
              {input('gender')}
              {input('dateOfBirth')}
            </div>
          </fieldset>
        )}
        {groups.map((group) => (
          <fieldset className="form-group" key={group}>
            <legend>{addressGroupLabel(group)}</legend>
            <div className="form-stack">
              {group === 'service' ? (
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.serviceSameAsResidential === 'Yes'}
                    onChange={(event) =>
                      set('serviceSameAsResidential')(event.target.checked ? 'Yes' : '')
                    }
                  />
                  Same as residential address
                </label>
              ) : null}
              {group === 'service' && form.serviceSameAsResidential === 'Yes'
                ? null
                : address(group)}
            </div>
          </fieldset>
        ))}
        <fieldset className="form-group">
          <legend>Contact and work</legend>
          <div className="form-stack">
            {input('serviceEmail')}
            {scope.organisation
              ? null
              : input('occupation', scope.director ? 'Business occupation' : 'Occupation')}
            {scope.secretary || SECRETARY_ROWS.some((k) => form[k])
              ? SECRETARY_ROWS.map((k) => input(k))
              : null}
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Record the change</legend>
          <div className="form-stack">
            <label>
              Applies from
              <input
                type="date"
                required
                value={effectiveDate}
                aria-describedby={lateDate ? `${warningId}-date` : undefined}
                onChange={(event) => setEffectiveDate(event.target.value)}
              />
            </label>
            {lateDate ? (
              <WarningLine field id={`${warningId}-date`}>
                The return reads particulars as at {formatDate(asAt)}; it will not see this change.
              </WarningLine>
            ) : null}
            <label>
              Reason
              <input required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
          </div>
        </fieldset>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button
            className="primary"
            disabled={edit.pending || !changes.length || issues.some((i) => i.severity === 'error')}
          >
            {saveLabel}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (await canLeaveEditing()) onClose();
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
