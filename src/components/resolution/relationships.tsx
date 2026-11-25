'use client';
import { canLeaveEditing } from '@/components/edit-guard';
import { useRef, useState } from 'react';
import Link from 'next/link';
import type {
  CompanyRelationship,
  Person,
  PersonSnapshot,
  RelationshipRole,
} from '@/domain/resolution/model';
import { currentDate, Empty, formatDate, useWorkspace } from '@/components/workspace';
import { getJson, newRequestId, postJson } from './api';
import { LoadState, useLoad } from './use-load';
import { ActionFeedback, useAction } from './use-action';
import { Drawer } from './drawer';
import { emptyPick, PersonField, resolvePick } from '@/components/person-field';

type RelationshipView = CompanyRelationship & { personName: string };
const ROLE_NAMES: Record<RelationshipRole, string> = {
  director: 'Director',
  member: 'Member (shareholder)',
  secretary: 'Secretary',
  manager: 'Manager',
  auditor: 'Auditor',
  other: 'Other',
};
export const roleName = (role: RelationshipRole) => ROLE_NAMES[role] || role;

type Cessation = 'resignation' | 'removal' | 'other_cessation';
const CESSATIONS: [Cessation, string][] = [
  ['resignation', 'Resigned'],
  ['removal', 'Removed'],
  ['other_cessation', 'Other (for example death or disqualification)'],
];

export const ROLE_ORDER: RelationshipRole[] = [
  'director',
  'secretary',
  'member',
  'manager',
  'auditor',
  'other',
];

/** Everyone linked to a company as at a date, with add and end actions. */
export function CompanyRelationships({
  companyId,
  asAt,
  onAsAtChange,
}: {
  companyId: string;
  /** Held by the record page, so the chosen date survives moving between tabs. */
  asAt: string;
  onAsAtChange: (asAt: string) => void;
}) {
  const { data } = useWorkspace();
  const load = useLoad(
    () =>
      getJson<{ relationships: RelationshipView[]; directorsAsAt: PersonSnapshot[] }>(
        `/api/companies/${companyId}/relationships?asAt=${asAt}`,
      ),
    [companyId, asAt],
  );
  const changed = async () => {
    await load.reload();
  };
  const canManage = Boolean(data?.actor.capabilities.includes('manage_people'));
  const active = (r: RelationshipView) =>
    (!r.startDate || r.startDate <= asAt) && (!r.endDate || r.endDate > asAt);
  const sorted = [...(load.data?.relationships ?? [])].sort(
    (a, b) =>
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
      a.personName.localeCompare(b.personName),
  );
  const ended = sorted.filter((r) => !active(r));
  // Capacity is rarely set: the column appears only when a row has one.
  const showCapacity = sorted.some((r) => r.capacity);
  const [adding, setAdding] = useState(false);
  const isToday = asAt === currentDate();
  const canAdd = canManage && isToday;
  return (
    <section className="section relationships" aria-label="People">
      <div className="record-toolbar">
        <div className="record-toolbar-date">
          <label>
            Record as at
            <input
              type="date"
              value={asAt}
              onChange={(event) => event.target.value && onAsAtChange(event.target.value)}
            />
          </label>
          {!isToday ? (
            <>
              <span className="metadata">Historical view, read only</span>
              <button
                type="button"
                className="text-button"
                onClick={() => onAsAtChange(currentDate())}
              >
                Back to today
              </button>
            </>
          ) : null}
        </div>
        {canAdd ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add person
          </button>
        ) : null}
      </div>
      <LoadState
        loading={load.loading && !load.data}
        error={load.error}
        reload={() => void load.reload()}
        label="people"
      />
      {load.data ? (
        <>
          <RelationshipTable
            key={asAt}
            rows={sorted.filter(active)}
            companyId={companyId}
            canManage={canManage && isToday}
            showCapacity={showCapacity}
            onChanged={changed}
          />
          {ended.length ? (
            <details className="advanced-filters">
              <summary>Former and future</summary>
              <RelationshipTable
                rows={ended}
                companyId={companyId}
                canManage={false}
                showCapacity={showCapacity}
                onChanged={changed}
              />
            </details>
          ) : null}
          {adding ? (
            <AddRelationship
              companyId={companyId}
              onAdded={changed}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RelationshipTable({
  rows,
  companyId,
  canManage,
  showCapacity,
  onChanged,
}: {
  rows: RelationshipView[];
  companyId: string;
  canManage: boolean;
  showCapacity: boolean;
  onChanged: () => Promise<void>;
}) {
  const [ending, setEnding] = useState<{ id: string; initialEndDate: string } | null>(null);
  const endingRow = rows.find((row) => row.id === ending?.id);
  const [endDate, setEndDate] = useState(currentDate());
  const [reason, setReason] = useState('');
  const [cessation, setCessation] = useState<Cessation | ''>('');
  const action = useAction();
  if (!rows.length) return <Empty>No people on this date</Empty>;
  return (
    <>
      <ActionFeedback
        error={action.error}
        status={action.status}
        conflict={action.conflict}
        onReload={() => void onChanged()}
      />
      <div className="table-wrap">
        <table className="relationship-table records-table">
          <caption className="sr-only">Relationships</caption>
          <thead>
            <tr>
              <th className="col-person">Person</th>
              <th className="col-role">Role</th>
              {showCapacity ? <th className="col-capacity">Capacity</th> : null}
              <th className="col-date">From</th>
              <th className="col-date">Until</th>
              {canManage ? (
                <th className="col-action">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td title={row.personName}>
                  <Link href={`/people?person=${row.personId}`}>{row.personName}</Link>
                </td>
                <td>{roleName(row.role)}</td>
                {showCapacity ? <td title={row.capacity}>{row.capacity}</td> : null}
                <td>{row.startDate ? formatDate(row.startDate) : ''}</td>
                <td>{row.endDate ? formatDate(row.endDate) : ''}</td>
                {canManage ? (
                  <td className="cell-action">
                    {!row.endDate ? (
                      <button
                        type="button"
                        className="quiet"
                        aria-label={`End ${roleName(row.role)} relationship for ${row.personName}`}
                        onClick={() => {
                          const today = currentDate();
                          setEnding({ id: row.id, initialEndDate: today });
                          setEndDate(today);
                          setReason('');
                          setCessation('');
                        }}
                      >
                        End
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ending && endingRow ? (
        <Drawer
          title={`End ${endingRow.personName} as ${roleName(endingRow.role).toLowerCase()}`}
          onClose={() => setEnding(null)}
        >
          <form
            className="form-stack"
            data-dirty={reason || cessation || endDate !== ending.initialEndDate ? 'true' : 'false'}
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await action.run(
                () =>
                  postJson(`/api/companies/${companyId}/relationships`, {
                    action: 'end',
                    id: endingRow.id,
                    expectedRevision: endingRow.revision,
                    requestId: newRequestId(),
                    endDate,
                    reason: reason.trim(),
                    ...(endingRow.role === 'director' ? { cessation } : {}),
                  }),
                `Ended ${endingRow.personName}'s relationship`,
              );
              if (ok) {
                setEnding(null);
                await onChanged();
              }
            }}
          >
            <label>
              End date
              <input
                type="date"
                required
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </label>
            {endingRow.role === 'director' ? (
              <label>
                How the appointment ended
                <select
                  required
                  value={cessation}
                  onChange={(event) => setCessation(event.target.value as Cessation)}
                >
                  <option value="">Choose…</option>
                  {CESSATIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Reason
              <input required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <ActionFeedback
              error={action.error}
              status={action.status}
              conflict={action.conflict}
              onReload={() => void onChanged()}
            />
            <div className="actions">
              <button className="primary" disabled={action.pending}>
                End relationship
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (await canLeaveEditing()) setEnding(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Drawer>
      ) : null}
    </>
  );
}

function AddRelationship({
  companyId,
  onAdded,
  onClose,
}: {
  companyId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const { data } = useWorkspace();
  const people = useLoad(() => getJson<{ people: Person[] }>('/api/people'), []);
  const creationRequest = useRef<{ name: string; requestId: string } | null>(null);
  const action = useAction();
  const [form, setForm] = useState({
    person: emptyPick(),
    role: 'director' as RelationshipRole,
    capacity: '',
    startDate: '',
    evidenceIds: [] as string[],
  });
  const evidence = data?.documents.filter((d) => d.companyId === companyId) ?? [];
  const dirty = Boolean(
    form.person.name ||
    form.person.choice ||
    form.role !== 'director' ||
    form.capacity ||
    form.startDate ||
    form.evidenceIds.length,
  );
  return (
    <Drawer title="Add a person" onClose={onClose}>
      <form
        className="form-grid"
        inert={action.pending}
        aria-busy={action.pending}
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await action.run(async () => {
            const pick = resolvePick(people.data?.people ?? [], form.person);
            let personId: string;
            if ('personId' in pick) personId = pick.personId;
            else {
              // A retry after a failed link must reuse the person this attempt already created.
              if (creationRequest.current?.name !== pick.fullName)
                creationRequest.current = { name: pick.fullName, requestId: newRequestId() };
              const person = await postJson<Person>('/api/people', {
                action: 'create',
                requestId: creationRequest.current.requestId,
                fullName: pick.fullName,
              });
              personId = person.id;
              people.setData((current) => ({
                people: [...(current?.people ?? []).filter((p) => p.id !== person.id), person],
              }));
              setForm((current) => ({
                ...current,
                person: { name: person.fullName, choice: person.id },
              }));
              creationRequest.current = null;
            }
            return postJson(`/api/companies/${companyId}/relationships`, {
              action: 'add',
              requestId: newRequestId(),
              personId,
              role: form.role,
              capacity: form.capacity.trim(),
              startDate: form.startDate || null,
              evidenceIds: form.evidenceIds,
            });
          }, 'Person added');
          if (ok) {
            setForm({
              person: emptyPick(),
              role: 'director',
              capacity: '',
              startDate: '',
              evidenceIds: [],
            });
            await onAdded();
            onClose();
          }
        }}
      >
        <PersonField
          required
          people={people.data?.people ?? []}
          pick={form.person}
          onChange={(person) => setForm({ ...form, person })}
          listId={`people-${companyId}`}
        />
        <label>
          Role
          <select
            value={form.role}
            onChange={(event) => setForm({ ...form, role: event.target.value as typeof form.role })}
          >
            <option value="director">Director</option>
            <option value="member">Member (shareholder)</option>
            <option value="secretary">Secretary</option>
            <option value="auditor">Auditor</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Capacity
          <input
            maxLength={200}
            value={form.capacity}
            onChange={(event) => setForm({ ...form, capacity: event.target.value })}
          />
        </label>
        <label>
          Start date
          <input
            type="date"
            value={form.startDate}
            onChange={(event) => setForm({ ...form, startDate: event.target.value })}
          />
        </label>
        {evidence.length ? (
          <fieldset className="full">
            <legend>Evidence</legend>
            <div className="check-list">
              {evidence.map((doc) => (
                <label className="inline" key={doc.id}>
                  <input
                    type="checkbox"
                    checked={form.evidenceIds.includes(doc.id)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        evidenceIds: event.target.checked
                          ? [...form.evidenceIds, doc.id]
                          : form.evidenceIds.filter((id) => id !== doc.id),
                      })
                    }
                  />
                  {doc.title}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="full form-footer">
          <ActionFeedback error={action.error || people.error} status={action.status} />
          <div className="actions">
            <button className="primary" disabled={action.pending}>
              Add person
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
        </div>
      </form>
    </Drawer>
  );
}
