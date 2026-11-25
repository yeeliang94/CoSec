'use client';
import { useEffect, useId, useState } from 'react';
import type { Company } from '@/domain/model';
import type { CompanyProfile } from '@/domain/resolution/model';
import {
  addressProblems,
  COMPANY_PARTICULAR_KEYS,
  companyAddress,
  companyAddressKey,
  companyParticularsAt,
  joinAddress,
  PARTS,
  validateCompanyParticulars,
  type Address,
  type Branch,
  type CompanyAddressGroup,
  type CompanyParticularKey,
} from '@/domain/ar1/company';
import { COMPANY_STATUSES, COMPANY_TYPES, ORIGINS } from '@/domain/ar1/mtool-lists';
import { formatYearEnd } from '@/domain/company';
import { currentDate, formatDate } from '@/components/workspace';
import { WarningLine } from '@/components/warning-line';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';
import { AddressFields } from '@/components/address-fields';

type Values = Record<CompanyParticularKey, string>;
const emptyValues = () => Object.fromEntries(COMPANY_PARTICULAR_KEYS.map((k) => [k, ''])) as Values;
const addressFrom = (values: Values, group: CompanyAddressGroup): Address =>
  Object.fromEntries(PARTS.map((p) => [p, values[companyAddressKey(group, p)]])) as Address;

/** MSIC code with its description, looked up from the server's copy of mTool's list. */
export function useMsicDescription(code: string) {
  const [description, setDescription] = useState<string | null>(null);
  useEffect(() => {
    if (!code) return;
    let live = true;
    getJson<{ description: string | null }>('/api/msic?code=' + encodeURIComponent(code))
      .then((r) => live && setDescription(r.description))
      .catch(() => live && setDescription(null));
    return () => {
      live = false;
    };
  }, [code]);
  return code ? description : null;
}

function MsicText({ code }: { code: string }) {
  const description = useMsicDescription(code);
  return (
    <>
      {code}
      {description ? ` ${description}` : ''}
    </>
  );
}

/** The Details panel of a company record, from the particulars in force today. */
export function CompanyDetails({
  company,
  profile,
  canEdit,
  onEdit,
  nextReturn,
}: {
  company: Company;
  profile: CompanyProfile | undefined;
  canEdit: boolean;
  onEdit: () => void;
  nextReturn?: React.ReactNode;
}) {
  const values = companyParticularsAt(profile?.particulars, currentDate());
  const registered = joinAddress(companyAddress(values, 'registered'));
  const principal = joinAddress(companyAddress(values, 'principal'));
  const codes = [values.msic1, values.msic2, values.msic3].filter(Boolean) as string[];
  const fact = (label: string, value: React.ReactNode) =>
    value ? (
      <div key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;
  return (
    <aside className="detail-aside">
      <div className="aside-heading">
        <h2>Details</h2>
        {canEdit ? (
          <button type="button" className="text-button section-link" onClick={onEdit}>
            Edit
          </button>
        ) : null}
      </div>
      <dl className="facts stacked">
        {fact('Legal status', company.legalStatus)}
        {fact('Status of company', values.status)}
        {fact('Type of company', values.companyType)}
        {fact('Former name', values.formerName)}
        {fact('Incorporation date', formatDate(company.incorporationDate))}
        {fact('Financial year end', formatYearEnd(company.financialYearEnd))}
        {nextReturn ? fact('Next annual return due', nextReturn) : null}
        {fact(
          'Nature of business',
          codes.length ? (
            <>
              {codes.map((code) => (
                <span className="fact-line" key={code}>
                  <MsicText code={code} />
                </span>
              ))}
            </>
          ) : (
            values.natureOfBusiness || company.activity
          ),
        )}
        {fact('Registered office', registered || company.address)}
        {fact('Principal place of business', principal)}
        {fact('Engagement status', company.engagementStatus)}
      </dl>
    </aside>
  );
}

function MsicInput({
  value,
  onChange,
  label,
  problem,
}: {
  value: string;
  onChange: (code: string) => void;
  label: string;
  problem?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ code: string; description: string }[]>([]);
  const description = useMsicDescription(value);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      getJson<{ codes: { code: string; description: string }[] }>(
        '/api/msic?q=' + encodeURIComponent(q),
      )
        .then((r) => live && setResults(r.codes))
        .catch(() => live && setResults([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  const listId = `msic-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const problemId = `${listId}-problem`;
  const field = (
    <label>
      {label}
      <input
        list={listId}
        aria-describedby={problem ? problemId : undefined}
        maxLength={10}
        value={value}
        placeholder="Code or words, for example 62010 or programming"
        onChange={(event) => {
          const text = event.target.value;
          const picked = results.find((r) => `${r.code} ${r.description}` === text);
          onChange(picked ? picked.code : (text.trim().split(' ')[0] ?? ''));
          setQuery(text);
        }}
      />
      <datalist id={listId}>
        {results.map((r) => (
          <option key={r.code} value={`${r.code} ${r.description}`} />
        ))}
      </datalist>
      {value && description ? <span className="field-note">{description}</span> : null}
    </label>
  );
  return problem ? (
    <div>
      {field}
      <WarningLine field blocking id={problemId}>
        {problem}
      </WarningLine>
    </div>
  ) : (
    field
  );
}

/**
 * Side panel that records company particulars as dated values. The annual return opens it with
 * `missing` to mark what mTool will reject.
 */
export function CompanyParticularsEdit({
  companyId,
  profile,
  onSaved,
  onClose,
  missing = [],
  saveLabel = 'Save particulars',
  asAt,
}: {
  companyId: string;
  profile: CompanyProfile;
  onSaved: () => Promise<void>;
  onClose: () => void;
  missing?: readonly CompanyParticularKey[];
  saveLabel?: string;
  /** Load and record as at this date (YYYY-MM-DD) instead of today: the annual return's date. */
  asAt?: string;
}) {
  const edit = useAction();
  const warningId = useId();
  const [initialDate] = useState(() => asAt ?? currentDate());
  const [initial] = useState<Values>(() => ({
    ...emptyValues(),
    ...companyParticularsAt(profile.particulars, initialDate),
  }));
  const [form, setForm] = useState<Values>(initial);
  const [effectiveDate, setEffectiveDate] = useState(initialDate);
  const [reason, setReason] = useState('');
  const changes = COMPANY_PARTICULAR_KEYS.filter((k) => form[k].trim() !== initial[k].trim());
  // MSIC codes are checked on the server, which holds mTool's list.
  const issues = validateCompanyParticulars(form, () => true);
  const issue = (key: CompanyParticularKey) => issues.find((i) => i.key === key)?.message;
  const dirty = Boolean(changes.length || reason || effectiveDate !== initialDate);
  const lateDate = Boolean(asAt && effectiveDate && effectiveDate > asAt);
  const set = (key: CompanyParticularKey) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const empty = (key: CompanyParticularKey) => missing.includes(key) && !form[key].trim();
  const describedBy = (key: CompanyParticularKey) =>
    issue(key) ? `${warningId}-${key}` : undefined;
  /** The field, with its problem as a warning line under it rather than inside the label. */
  const withIssue = (key: CompanyParticularKey, field: React.ReactNode) =>
    issue(key) ? (
      <div>
        {field}
        <WarningLine field blocking id={describedBy(key)}>
          {issue(key)}
        </WarningLine>
      </div>
    ) : (
      field
    );
  const select = (key: CompanyParticularKey, label: string, options: readonly string[]) =>
    withIssue(
      key,
      <label>
        {label}
        <select
          value={form[key]}
          className={empty(key) ? 'missing' : undefined}
          aria-describedby={describedBy(key)}
          onChange={(event) => set(key)(event.target.value)}
        >
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>,
    );
  const text = (key: CompanyParticularKey, label: string, type = 'text') =>
    withIssue(
      key,
      <label>
        {label}
        <input
          type={type}
          maxLength={255}
          value={form[key]}
          className={empty(key) ? 'missing' : undefined}
          aria-describedby={describedBy(key)}
          onChange={(event) => set(key)(event.target.value)}
        />
      </label>,
    );
  const address = (group: CompanyAddressGroup, countries?: readonly string[]) => (
    <AddressFields
      value={addressFrom(form, group)}
      countries={countries}
      missing={missing.some((k) => k.startsWith(group))}
      problems={addressProblems(addressFrom(form, group))}
      onChange={(next) =>
        setForm((f) => ({
          ...f,
          ...Object.fromEntries(PARTS.map((p) => [companyAddressKey(group, p), next[p]])),
        }))
      }
    />
  );
  const keptAt = (flag: 'membersRegisterAtRegistered' | 'financialRecordsAtRegistered') => (
    <label className="inline">
      <input
        type="checkbox"
        checked={form[flag] === 'Yes'}
        onChange={(event) => set(flag)(event.target.checked ? 'Yes' : '')}
      />
      Kept at the registered office
    </label>
  );
  return (
    <Drawer title="Company particulars" onClose={onClose}>
      <form
        className="form-stack grouped-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${companyId}/profile`, {
              action: 'set_particulars',
              expectedRevision: profile.revision,
              requestId: newRequestId(),
              values: Object.fromEntries(changes.map((k) => [k, form[k].trim() || null])),
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
        <fieldset className="form-group">
          <legend>Company</legend>
          <div className="form-stack">
            {select('origin', 'Origin', ORIGINS)}
            {select('status', 'Status of company', COMPANY_STATUSES)}
            {select('companyType', 'Type of company', COMPANY_TYPES)}
            {text('formerName', 'Former name (optional)')}
            {text('gstNumber', 'GST registration number (optional)')}
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Registered office</legend>
          <div className="form-stack">{address('registered', ['MALAYSIA'])}</div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Register of members</legend>
          <div className="form-stack">
            {keptAt('membersRegisterAtRegistered')}
            {form.membersRegisterAtRegistered === 'Yes' ? null : address('membersRegister')}
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Financial records</legend>
          <div className="form-stack">
            {keptAt('financialRecordsAtRegistered')}
            {form.financialRecordsAtRegistered === 'Yes' ? null : address('financialRecords')}
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Principal place of business</legend>
          <div className="form-stack">
            {address('principal')}
            {text('phone', 'Phone (optional)', 'tel')}
            {text('fax', 'Fax (optional)', 'tel')}
            {text('email', 'Email (optional)', 'email')}
            {text('website', 'Website (optional)')}
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend>Nature of business</legend>
          <div className="form-stack">
            <label>
              Description
              <textarea
                maxLength={2000}
                value={form.natureOfBusiness}
                className={empty('natureOfBusiness') ? 'missing' : undefined}
                onChange={(event) => set('natureOfBusiness')(event.target.value)}
              />
            </label>
            {(['msic1', 'msic2', 'msic3'] as const).map((key, i) => (
              <MsicInput
                key={key}
                label={i ? `MSIC code ${i + 1} (optional)` : 'Main MSIC code'}
                value={form[key]}
                problem={issue(key)}
                onChange={set(key)}
              />
            ))}
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
            disabled={edit.pending || !changes.length || issues.length > 0}
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

const emptyBranch = (): Branch => ({
  id: '',
  Line1: '',
  Line2: '',
  Line3: '',
  Postcode: '',
  Town: '',
  State: '',
  Country: 'MALAYSIA',
  phone: '',
  fax: '',
  email: '',
  website: '',
  from: null,
  until: null,
});

/** Branch offices, kept as one list; a closing date keeps a closed branch off later returns. */
export function BranchesEdit({
  companyId,
  profile,
  onSaved,
  onClose,
}: {
  companyId: string;
  profile: CompanyProfile;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [initial] = useState(() => JSON.stringify(profile.branches ?? []));
  const [branches, setBranches] = useState<Branch[]>(() =>
    profile.branches?.length ? structuredClone(profile.branches) : [emptyBranch()],
  );
  const [reason, setReason] = useState('');
  const dirty = JSON.stringify(branches) !== initial || Boolean(reason);
  const update = (i: number, next: Partial<Branch>) =>
    setBranches((list) => list.map((b, j) => (j === i ? { ...b, ...next } : b)));
  return (
    <Drawer title="Branches" onClose={onClose}>
      <form
        className="form-stack grouped-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${companyId}/profile`, {
              action: 'set_branches',
              expectedRevision: profile.revision,
              requestId: newRequestId(),
              branches: branches.map(({ id, ...b }) => ({ ...(id ? { id } : {}), ...b })),
              reason: reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {branches.map((branch, i) => (
          <fieldset className="form-group" key={branch.id || i}>
            <legend>Branch {i + 1}</legend>
            <div className="form-stack">
              <AddressFields
                value={branch}
                problems={addressProblems(branch)}
                onChange={(next) => update(i, next)}
              />
              <label>
                Phone (optional)
                <input
                  value={branch.phone}
                  onChange={(e) => update(i, { phone: e.target.value })}
                />
              </label>
              <label>
                Email (optional)
                <input
                  type="email"
                  value={branch.email}
                  onChange={(e) => update(i, { email: e.target.value })}
                />
              </label>
              <label>
                Opened (optional)
                <input
                  type="date"
                  value={branch.from ?? ''}
                  onChange={(e) => update(i, { from: e.target.value || null })}
                />
              </label>
              <label>
                Closed (optional)
                <input
                  type="date"
                  value={branch.until ?? ''}
                  onChange={(e) => update(i, { until: e.target.value || null })}
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setBranches((list) => list.filter((_, j) => j !== i))}
              >
                Remove branch {i + 1}
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="text-button section-link"
          onClick={() => setBranches((list) => [...list, emptyBranch()])}
        >
          Add branch
        </button>
        <label>
          Reason
          <input required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending || !dirty}>
            Save branches
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

/** Branch offices in force today, one per row. */
export function BranchList({ branches }: { branches: Branch[] }) {
  if (!branches.length) return <p className="muted">No branches recorded</p>;
  return (
    <div className="table-wrap">
      <table className="records-table">
        <caption className="sr-only">Branches</caption>
        <thead>
          <tr>
            <th>Address</th>
            <th className="col-date">Opened</th>
            <th className="col-date">Closed</th>
          </tr>
        </thead>
        <tbody>
          {branches.map((b) => {
            const text = joinAddress(b);
            return (
              <tr key={b.id}>
                <td title={text}>{text}</td>
                <td>{b.from ? formatDate(b.from) : ''}</td>
                <td>{b.until ? formatDate(b.until) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
