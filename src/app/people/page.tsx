'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  type CompanyRelationship,
  type OtherDirectorship,
  type Person,
  type RecordFieldDefinition,
  type ResolutionCase,
} from '@/domain/resolution/model';
import { ParticularsEdit, PersonParticulars } from '@/components/people/particulars';
import { caseStatus } from '@/domain/resolution/cases';
import type { AuditEntryView } from '@/domain/resolution/records';
import {
  currentDate,
  Empty,
  auditActionLabel,
  formatDate,
  Icon,
  PageHeader,
  useWorkspace,
} from '@/components/workspace';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { roleName } from '@/components/resolution/relationships';
import { AddToCompany } from '@/components/company/add-to-company';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { CustomValueInput } from '@/components/resolution/custom-value';
import { canLeaveEditing } from '@/components/edit-guard';
import { Tabs } from '@/components/tabs';
import type { PersonKind } from '@/domain/resolution/model';

type PersonRow = Person & { relationships: CompanyRelationship[] };

export default function PeoplePage() {
  return (
    <Suspense fallback={null}>
      <PeopleDirectory />
    </Suspense>
  );
}

function PeopleDirectory() {
  const { data } = useWorkspace();
  const router = useRouter();
  // Read reactively so same-route `?person=` links (relationship rows) select the person.
  const params = useSearchParams();
  const personParam = params.get('person');
  const kind: PersonKind = params.get('kind') === 'organisation' ? 'organisation' : 'individual';
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const people = useLoad(() => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (companyId) params.set('companyId', companyId);
    params.set('kind', kind);
    return getJson<{ people: PersonRow[] }>('/api/people?' + params);
  }, [search, companyId, kind]);
  const rows = people.data?.people;
  // Loaded once for the page; each person's resolutions are filtered from it.
  const cases = useLoad(() => getJson<{ cases: ResolutionCase[] }>('/api/resolution-cases'), []);
  // The first person shown stays selected while filters change, until a person is chosen.
  const firstPerson = useRef('');
  if (!firstPerson.current && rows?.length) firstPerson.current = rows[0].id;
  const selected = personParam || firstPerson.current;
  const selectedRow = useRef<HTMLButtonElement>(null);
  const listed = Boolean(rows?.some((person) => person.id === selected));
  useEffect(() => {
    // A link from a company record can select someone far down the list.
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, listed]);
  if (!data) return null;
  const canManage = data.actor.capabilities.includes('manage_people');
  const companyName = (id: string) => data.companies.find((c) => c.id === id)?.name || 'Company';
  const today = currentDate();
  const summary = (person: PersonRow) => {
    const links = person.relationships;
    if (!links.length) return 'Not linked yet';
    const current = links.filter((r) => !r.endDate || r.endDate > today);
    const first = current[0] ?? links[0];
    const text = `${companyName(first.companyId)}, ${roleName(first.role)}`;
    if (!current.length) return `${text}, ended ${formatDate(first.endDate)}`;
    return current.length > 1 ? `${text} and ${current.length - 1} more` : text;
  };
  const choose = async (id: string) => {
    if (id === selected || !(await canLeaveEditing())) return;
    router.push(`/people?kind=${kind}&person=` + encodeURIComponent(id), { scroll: false });
  };
  const chooseKind = async (next: PersonKind) => {
    if (next === kind || !(await canLeaveEditing())) return;
    firstPerson.current = '';
    router.push('/people?kind=' + next, { scroll: false });
  };
  return (
    <div className="people-page">
      <PageHeader title="People">
        {canManage ? (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon kind="plus" />
            {kind === 'organisation' ? 'New organisation' : 'New person'}
          </button>
        ) : null}
      </PageHeader>
      {creating ? (
        <NewPerson
          kind={kind}
          onDone={async (id) => {
            setCreating(false);
            await people.reload();
            if (id)
              router.push(`/people?kind=${kind}&person=` + encodeURIComponent(id), {
                scroll: false,
              });
          }}
        />
      ) : null}
      <Tabs
        tabs={[
          { id: 'individual' as const, label: 'Individuals' },
          { id: 'organisation' as const, label: 'Organisations' },
        ]}
        selected={kind}
        onChange={(next) => void chooseKind(next)}
        ariaLabel="People"
        idPrefix="people-kind"
        className="section-nav record-tabs people-kind-tabs"
        activeClassName="active"
        controls="people-kind-panel"
      />
      <div className="people-layout" id="people-kind-panel" role="tabpanel">
        <section className="people-list-panel" aria-label="People list">
          <div className="toolbar people-filters">
            <label className="search">
              <span className="sr-only">Search people</span>
              <Icon kind="search" />
              <input
                type="search"
                placeholder={kind === 'organisation' ? 'Search organisations' : 'Search by name'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Company</span>
              <select
                value={companyId}
                onChange={async (event) => {
                  const next = event.target.value;
                  if (await canLeaveEditing()) setCompanyId(next);
                }}
              >
                <option value="">All companies</option>
                {data.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="people-list-scroll">
            <LoadState
              loading={people.loading && !people.data}
              error={people.error}
              reload={() => void people.reload()}
              label="people"
            />
            {rows ? (
              rows.length ? (
                <ul className="people-list">
                  {rows.map((person) => {
                    const text = summary(person);
                    return (
                      <li key={person.id}>
                        <button
                          type="button"
                          className="person-row"
                          ref={person.id === selected ? selectedRow : undefined}
                          aria-current={person.id === selected ? 'true' : undefined}
                          onClick={() => void choose(person.id)}
                        >
                          <span className="person-row-name">{person.fullName}</span>
                          <span className="person-row-summary" title={text}>
                            {person.migrationNote ? `Needs review, ${text}` : text}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : search || query || companyId ? (
                <Empty>
                  {kind === 'organisation' ? 'No matching organisations' : 'No matching people'}
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setSearch('');
                      setCompanyId('');
                    }}
                  >
                    Clear filters
                  </button>
                </Empty>
              ) : (
                <Empty>{kind === 'organisation' ? 'No organisations yet' : 'No people yet'}</Empty>
              )
            ) : null}
          </div>
        </section>
        <section className="person-panel" aria-label="Person">
          {selected ? (
            <PersonDetail
              key={selected}
              id={selected}
              resolutions={cases.data?.cases.filter((item) => item.personId === selected)}
              onChanged={() => void people.reload()}
            />
          ) : rows ? (
            <Empty>Select a person</Empty>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function NewPerson({ kind, onDone }: { kind: PersonKind; onDone: (id?: string) => Promise<void> }) {
  const organisation = kind === 'organisation';
  const action = useAction();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  return (
    <Drawer title={organisation ? 'New organisation' : 'New person'} onClose={() => void onDone()}>
      <form
        className="form-grid"
        data-dirty={fullName || email || notes ? 'true' : 'false'}
        onChange={() => setRequestId(newRequestId())}
        onSubmit={async (event) => {
          event.preventDefault();
          const person = await action.run(
            () =>
              postJson<Person>('/api/people', {
                action: 'create',
                requestId,
                kind,
                fullName: fullName.trim(),
                email: email.trim() || null,
                notes,
              }),
            organisation ? 'Organisation created' : 'Person created',
          );
          if (person) await onDone(person.id);
        }}
      >
        <label>
          {organisation ? 'Name as registered' : 'Full name'}
          <input
            required
            maxLength={255}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="full">
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <div className="full form-footer">
          <ActionFeedback error={action.error} status={action.status} />
          <div className="actions">
            <button className="primary" disabled={action.pending}>
              {organisation ? 'Create organisation' : 'Create person'}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await canLeaveEditing()) await onDone();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}

type Panel = 'edit' | 'custom' | 'link' | 'particulars' | 'directorships';

function PersonDetail({
  id,
  resolutions,
  onChanged,
}: {
  id: string;
  /** Resolutions whose subject is this person; absent until they load. */
  resolutions?: ResolutionCase[];
  onChanged: () => void;
}) {
  const { data } = useWorkspace();
  const load = useLoad(
    () =>
      getJson<{ person: Person; relationships: CompanyRelationship[]; audit: AuditEntryView[] }>(
        '/api/people/' + id,
      ),
    [id],
  );
  const definitions = useLoad(
    () => getJson<{ definitions: RecordFieldDefinition[] }>('/api/record-fields?scope=person'),
    [],
  );
  const [panel, setPanel] = useState<Panel | null>(null);
  const [status, setStatus] = useState('');
  const open = (next: Panel) => {
    setStatus('');
    setPanel(next);
  };
  // The drawer closes on success, so the result is announced here on the page.
  const saved = (message: string) => async () => {
    await load.reload();
    onChanged();
    setStatus(message);
  };
  const person = load.data?.person;
  const canManage = Boolean(data?.actor.capabilities.includes('manage_people'));
  const activeDefinitions = (definitions.data?.definitions ?? []).filter((d) => !d.archived);
  const customValues = Object.entries(person?.customValues ?? {});
  const relationships = load.data?.relationships ?? [];
  const showSource = relationships.some((r) => r.projectedFrom);
  return (
    <>
      <LoadState
        loading={false}
        error={load.error}
        reload={() => void load.reload()}
        label="person"
      />
      {load.loading && !load.data && !load.error ? (
        <div className="loading person-skeleton" role="status" aria-busy="true">
          <div className="skeleton short" />
          <div className="skeleton heading" />
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton short" />
          <span className="sr-only">Loading person</span>
        </div>
      ) : null}
      {person && data ? (
        <>
          <div className="person-heading">
            <h2>{person.fullName}</h2>
            {canManage ? (
              <div className="header-actions">
                <button type="button" onClick={() => open('edit')}>
                  Edit
                </button>
                <button type="button" onClick={() => open('link')}>
                  Add to a company
                </button>
              </div>
            ) : null}
          </div>
          {status ? (
            <p className="success person-status" role="status">
              {status}
            </p>
          ) : null}
          <dl className="record-meta person-facts">
            <div>
              <dt>Email</dt>
              <dd>{person.email}</dd>
            </div>
          </dl>
          {person.migrationNote ? <p className="warning">{person.migrationNote}</p> : null}
          {person.notes ? <p className="prose person-notes">{person.notes}</p> : null}
          <PersonParticulars
            person={person}
            relationships={relationships}
            canManage={canManage}
            canViewIdentity={data.actor.capabilities.includes('view_identity')}
            onEdit={() => open('particulars')}
          />
          <section className="section">
            <h3>Companies</h3>
            {relationships.length ? (
              <div className="table-wrap">
                <table className="records-table person-companies-table">
                  <caption className="sr-only">Companies this person is linked to</caption>
                  <thead>
                    <tr>
                      <th className="col-company">Company</th>
                      <th className="col-role">Role</th>
                      <th className="col-date">From</th>
                      <th className="col-date">Until</th>
                      {showSource ? <th className="col-source">Source</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {relationships.map((r) => {
                      const company =
                        data.companies.find((c) => c.id === r.companyId)?.name || 'Company';
                      const role = roleName(r.role) + (r.capacity ? `, ${r.capacity}` : '');
                      return (
                        <tr key={r.id}>
                          <td title={company}>
                            <Link href={'/companies/' + r.companyId}>{company}</Link>
                          </td>
                          <td title={role}>{role}</td>
                          <td>{r.startDate ? formatDate(r.startDate) : ''}</td>
                          <td>{r.endDate ? formatDate(r.endDate) : ''}</td>
                          {showSource ? (
                            <td>
                              {r.projectedFrom
                                ? 'shareEntryIds' in r.projectedFrom
                                  ? 'Share register'
                                  : 'Officer record'
                                : ''}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                Not linked to a company yet
                {canManage ? (
                  <button type="button" onClick={() => open('link')}>
                    Add to a company
                  </button>
                ) : null}
              </Empty>
            )}
          </section>
          {person.kind === 'organisation' ? null : (
            <OtherDirectorships
              person={person}
              canManage={canManage}
              onEdit={() => open('directorships')}
            />
          )}
          {resolutions ? (
            <section className="section">
              <h3>Resolutions</h3>
              {resolutions.length ? (
                <ul className="list-plain person-resolutions">
                  {resolutions.map((item) => (
                    <li key={item.id}>
                      <Link href={'/resolutions/' + item.id}>{item.title}</Link>
                      <span>
                        {caseStatus(
                          item,
                          (userId) => data.users.find((u) => u.id === userId)?.name || userId,
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No resolutions about this person</p>
              )}
            </section>
          ) : null}
          {person.nameHistory.length ? (
            <section className="section">
              <h3>Name history</h3>
              <ul className="list-plain">
                {person.nameHistory.map((entry, i) => (
                  <li key={i}>
                    {entry.name}
                    <p className="metadata">
                      Until {formatDate(entry.until)}, {entry.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {customValues.length || (canManage && activeDefinitions.length) ? (
            <section className="section">
              <div className="person-section-heading">
                <h3>Custom values</h3>
                {canManage && activeDefinitions.length ? (
                  <button type="button" onClick={() => open('custom')}>
                    Set a custom value
                  </button>
                ) : null}
              </div>
              {customValues.length ? (
                <dl className="custom-values">
                  {customValues.map(([key, values]) => {
                    const current = values.at(-1);
                    return (
                      <div key={key}>
                        <dt>
                          {definitions.data?.definitions.find((d) => d.id === key)?.label || key}
                        </dt>
                        <dd>
                          {String(current?.value ?? '')}
                          <span className="metadata">
                            , from {formatDate(current?.effectiveDate)}
                          </span>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              ) : null}
            </section>
          ) : null}
          <details className="disclosure">
            <summary>Record history</summary>
            <dl className="record-meta">
              <div>
                <dt>Created</dt>
                <dd>{formatDate(person.createdAt)}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{person.revision}</dd>
              </div>
            </dl>
            <ul className="list-plain">
              {load.data!.audit.map((entry) => (
                <li key={entry.id}>
                  {auditActionLabel(entry.action)}
                  <p className="metadata">
                    {entry.actorName}, {formatDate(entry.at)}
                    {entry.reason ? `, ${entry.reason}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          {panel === 'edit' ? (
            <PersonEdit
              person={person}
              onSaved={saved('Details corrected')}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === 'custom' ? (
            <PersonCustomValue
              person={person}
              definitions={activeDefinitions}
              onSaved={saved('Value recorded')}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === 'particulars' ? (
            <ParticularsEdit
              person={person}
              roles={relationships.map((r) => r.role)}
              canViewIdentity={data.actor.capabilities.includes('view_identity')}
              onSaved={saved('Particulars recorded')}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === 'directorships' ? (
            <OtherDirectorshipsEdit
              person={person}
              onSaved={saved('Other directorships saved')}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === 'link' ? (
            <AddToCompany
              personId={person.id}
              onAdded={saved('Added to the company')}
              onClose={() => setPanel(null)}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function PersonEdit({
  person,
  onSaved,
  onClose,
}: {
  person: Person;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [form, setForm] = useState({
    fullName: person.fullName,
    email: person.email || '',
    notes: person.notes,
    reason: '',
  });
  const changed =
    form.fullName !== person.fullName ||
    form.email !== (person.email || '') ||
    form.notes !== person.notes;
  return (
    <Drawer title="Correct details" onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={changed || form.reason ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson('/api/people', {
              action: 'update',
              id: person.id,
              expectedRevision: person.revision,
              requestId: newRequestId(),
              fullName: form.fullName.trim(),
              email: form.email.trim() || null,
              notes: form.notes,
              reason: form.reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        <label>
          Full name
          <input
            required
            value={form.fullName}
            onChange={(event) => setForm({ ...form, fullName: event.target.value })}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </label>
        <label>
          Notes
          <textarea
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
        </label>
        <label>
          Reason for the correction
          <input
            required
            value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })}
          />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending || !changed}>
            Save correction
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

function PersonCustomValue({
  person,
  definitions,
  onSaved,
  onClose,
}: {
  person: Person;
  definitions: RecordFieldDefinition[];
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const custom = useAction();
  const [initialDate] = useState(currentDate);
  const [value, setValue] = useState({
    definitionId: '',
    value: '',
    effectiveDate: initialDate,
    reason: '',
  });
  const definition = definitions.find((d) => d.id === value.definitionId);
  const dirty = Boolean(
    value.definitionId || value.value || value.reason || value.effectiveDate !== initialDate,
  );
  return (
    <Drawer title="Set a custom value" onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await custom.run(() =>
            postJson('/api/people', {
              action: 'set_custom',
              id: person.id,
              expectedRevision: person.revision,
              requestId: newRequestId(),
              definitionId: value.definitionId,
              value: definition?.valueType === 'boolean' ? value.value === 'true' : value.value,
              effectiveDate: value.effectiveDate,
              reason: value.reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        <label>
          Field
          <select
            required
            value={value.definitionId}
            onChange={(event) =>
              setValue({ ...value, definitionId: event.target.value, value: '' })
            }
          >
            <option value="">Select…</option>
            {definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <CustomValueInput
          definition={definition}
          value={value.value}
          onChange={(v) => setValue({ ...value, value: v })}
        />
        <label>
          Applies from
          <input
            type="date"
            required
            value={value.effectiveDate}
            onChange={(event) => setValue({ ...value, effectiveDate: event.target.value })}
          />
        </label>
        <label>
          Reason
          <input
            required
            value={value.reason}
            onChange={(event) => setValue({ ...value, reason: event.target.value })}
          />
        </label>
        <ActionFeedback error={custom.error} status={custom.status} conflict={custom.conflict} />
        <div className="actions">
          <button className="primary" disabled={custom.pending}>
            Record value
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

function OtherDirectorships({
  person,
  canManage,
  onEdit,
}: {
  person: Person;
  canManage: boolean;
  onEdit: () => void;
}) {
  const rows = person.otherDirectorships ?? [];
  if (!rows.length && !canManage) return null;
  return (
    <section className="section">
      <div className="person-section-heading">
        <h3>Other directorships</h3>
        {canManage ? (
          <button type="button" onClick={onEdit}>
            Edit other directorships
          </button>
        ) : null}
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table className="records-table person-companies-table">
            <caption className="sr-only">Directorships in companies outside the workspace</caption>
            <thead>
              <tr>
                <th className="col-company">Company</th>
                <th className="col-date">Appointed</th>
                <th className="col-date">Ceased</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td title={row.companyName}>{row.companyName}</td>
                  <td>{row.appointedOn ? formatDate(row.appointedOn) : ''}</td>
                  <td>{row.ceasedOn ? formatDate(row.ceasedOn) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No directorships outside the workspace recorded</p>
      )}
    </section>
  );
}

type DirectorshipRow = {
  key: string;
  id?: string;
  companyName: string;
  appointedOn: string;
  ceasedOn: string;
};

function OtherDirectorshipsEdit({
  person,
  onSaved,
  onClose,
}: {
  person: Person;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [initial] = useState<DirectorshipRow[]>(() =>
    (person.otherDirectorships ?? []).map((d: OtherDirectorship) => ({
      key: d.id,
      id: d.id,
      companyName: d.companyName,
      appointedOn: d.appointedOn ?? '',
      ceasedOn: d.ceasedOn ?? '',
    })),
  );
  const [rows, setRows] = useState(initial);
  const [reason, setReason] = useState('');
  const strip = (list: DirectorshipRow[]) =>
    JSON.stringify(
      list.map((row) => [row.id, row.companyName.trim(), row.appointedOn, row.ceasedOn]),
    );
  const changed = strip(rows) !== strip(initial);
  const update = (key: string, patch: Partial<DirectorshipRow>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  return (
    <Drawer title="Other directorships" onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={changed || reason ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson('/api/people', {
              action: 'set_other_directorships',
              id: person.id,
              expectedRevision: person.revision,
              requestId: newRequestId(),
              directorships: rows.map((row) => ({
                ...(row.id ? { id: row.id } : {}),
                companyName: row.companyName.trim(),
                appointedOn: row.appointedOn || null,
                ceasedOn: row.ceasedOn || null,
              })),
              reason: reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {rows.length ? (
          <table className="records-table other-directorships-edit">
            <caption className="sr-only">Directorships in companies outside the workspace</caption>
            <thead>
              <tr>
                <th className="col-company">Company</th>
                <th className="col-date">Appointed</th>
                <th className="col-date">Ceased</th>
                <th className="col-action">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <td>
                    <input
                      required
                      maxLength={255}
                      aria-label={`Company ${index + 1}`}
                      value={row.companyName}
                      onChange={(event) => update(row.key, { companyName: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      aria-label={`Appointed ${index + 1}`}
                      value={row.appointedOn}
                      onChange={(event) => update(row.key, { appointedOn: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      aria-label={`Ceased ${index + 1}`}
                      value={row.ceasedOn}
                      onChange={(event) => update(row.key, { ceasedOn: event.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No other directorships</p>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={rows.length >= 50}
            onClick={() =>
              setRows([
                ...rows,
                { key: newRequestId(), companyName: '', appointedOn: '', ceasedOn: '' },
              ])
            }
          >
            Add a directorship
          </button>
        </div>
        <label>
          Reason
          <input required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending || !changed}>
            Save other directorships
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
