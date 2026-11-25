'use client';
import { canLeaveEditing } from '@/components/edit-guard';
import { Drawer } from '@/components/resolution/drawer';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CLAUSE_CATEGORIES,
  type ClauseCategory,
  type UsageContext,
} from '@/domain/resolution/model';
import { Empty, Icon } from '@/components/workspace';
import {
  newRequestId,
  postJson,
  USAGE_CONTEXTS,
  type ClauseWithVersions,
  statusOf,
} from '@/components/resolution/api';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { RowMenu } from '@/components/menu';
import { NoMatches, updatedText, versionText } from './versions';

/** "Hidden" covers hidden and archived; everything else filters on the latest version's status. */
function clauseStatus(clause: ClauseWithVersions) {
  return clause.hidden || clause.archived
    ? 'hidden'
    : (statusOf(clause.versions).last?.status ?? '');
}

export function ClauseLibrary({
  clauses,
  canManage,
  creating,
  onCreating,
  reload,
}: {
  clauses: ClauseWithVersions[];
  canManage: boolean;
  creating: boolean;
  onCreating: (value: boolean) => void;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [act, setAct] = useState('');
  const [status, setStatus] = useState('');
  const action = useAction();
  const acts = [...new Set(clauses.map((c) => c.governingAct).filter(Boolean))].sort();
  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matching = clauses.filter(
      (c) =>
        (status ? clauseStatus(c) === status : clauseStatus(c) !== 'hidden') &&
        (!category || c.category === category) &&
        (!act || c.governingAct === act) &&
        (!term || `${c.name} ${c.description}`.toLowerCase().includes(term)),
    );
    return CLAUSE_CATEGORIES.flatMap((name) =>
      matching
        .filter((c) => c.category === name)
        .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
    );
  }, [clauses, query, category, act, status]);
  const update = (clause: ClauseWithVersions, patch: Record<string, unknown>, message: string) =>
    action
      .run(
        () =>
          postJson('/api/clause-templates', {
            action: 'update',
            requestId: newRequestId(),
            id: clause.id,
            expectedRevision: clause.revision,
            ...patch,
          }),
        message,
      )
      .then(async (ok) => {
        if (ok) await reload();
      });
  const filtered = Boolean(query || category || act || status);
  const clearFilters = () => {
    setQuery('');
    setCategory('');
    setAct('');
    setStatus('');
  };
  const showAvailability = status === 'hidden';
  return (
    <>
      {creating ? (
        <CreateClause
          onCancel={() => onCreating(false)}
          onCreated={(id) => router.push('/templates/clauses/' + id)}
        />
      ) : null}
      <div className="toolbar tl-toolbar">
        <label className="search">
          <span className="sr-only">Search wording</span>
          <Icon kind="search" />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {CLAUSE_CATEGORIES.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Governing Act</span>
          <select value={act} onChange={(event) => setAct(event.target.value)}>
            <option value="">All Acts</option>
            {acts.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All in use</option>
            <option value="Draft">Draft</option>
            <option value="Returned">Returned</option>
            <option value="In review">In review</option>
            <option value="hidden">Hidden or archived</option>
          </select>
        </label>
        {filtered && rows.length ? (
          <button type="button" className="quiet" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
      <ActionFeedback
        error={action.error}
        status={action.status}
        conflict={action.conflict}
        onReload={() => void reload()}
      />
      {rows.length ? (
        <div className="table-wrap">
          <table className="library-table tl-table">
            <caption className="sr-only">Standard wording</caption>
            <thead>
              <tr>
                <th>Wording</th>
                <th>Version</th>
                <th>Category</th>
                {showAvailability ? <th>Availability</th> : null}
                <th>Updated</th>
                {canManage ? (
                  <th className="tl-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((clause) => (
                <tr key={clause.id}>
                  <td>
                    <Link href={'/templates/clauses/' + clause.id} title={clause.name}>
                      {clause.name}
                    </Link>
                  </td>
                  <td>{versionText(clause.versions)}</td>
                  <td>{clause.category}</td>
                  {showAvailability ? (
                    <td>{clause.archived ? 'Archived' : 'Hidden from new resolutions'}</td>
                  ) : null}
                  <td className="tl-date">{updatedText(clause.versions)}</td>
                  {canManage ? (
                    <td className="tl-actions">
                      <RowMenu
                        name={clause.name}
                        disabled={action.pending}
                        items={[
                          {
                            label: 'Copy',
                            onSelect: async () => {
                              const copy = await action.run(
                                () =>
                                  postJson<ClauseWithVersions>('/api/clause-templates', {
                                    action: 'copy',
                                    requestId: newRequestId(),
                                    sourceId: clause.id,
                                    name: `Copy of ${clause.name}`.slice(0, 160),
                                  }),
                                `Copied ${clause.name}`,
                              );
                              if (copy) router.push('/templates/clauses/' + copy.id);
                            },
                          },
                          ...(!clause.archived
                            ? [
                                {
                                  label: clause.hidden
                                    ? 'Show in new resolutions'
                                    : 'Hide from new resolutions',
                                  onSelect: () =>
                                    void update(
                                      clause,
                                      { hidden: !clause.hidden },
                                      `${clause.name} ${clause.hidden ? 'shown in' : 'hidden from'} the library`,
                                    ),
                                },
                              ]
                            : []),
                          clause.archived
                            ? {
                                label: 'Restore',
                                onSelect: () =>
                                  void update(
                                    clause,
                                    { archived: false },
                                    `${clause.name} restored`,
                                  ),
                              }
                            : {
                                label: 'Archive',
                                confirm: { label: `Archive ${clause.name}`, cancelLabel: 'Keep' },
                                onSelect: () =>
                                  void update(
                                    clause,
                                    { archived: true, reason: 'Archived from standard wording' },
                                    `${clause.name} archived`,
                                  ),
                              },
                        ]}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : filtered ? (
        <NoMatches onClear={clearFilters} />
      ) : (
        <Empty>No wording yet</Empty>
      )}
    </>
  );
}

export function UsageChecks({
  value,
  onChange,
}: {
  value: UsageContext[];
  onChange: (value: UsageContext[]) => void;
}) {
  return (
    <fieldset className="full">
      <legend>Used for</legend>
      {USAGE_CONTEXTS.map((context) => (
        <label className="inline" key={context.value}>
          <input
            type="checkbox"
            checked={value.includes(context.value)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, context.value]
                  : value.filter((v) => v !== context.value),
              )
            }
          />
          {context.label}
        </label>
      ))}
    </fieldset>
  );
}

function CreateClause({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [requestId, setRequestId] = useState(newRequestId);
  const initialForm = {
    name: '',
    category: 'Director' as ClauseCategory,
    governingAct: 'Companies Act 2016',
    displayOrder: '100',
    description: '',
    usageContexts: ['board'] as UsageContext[],
  };
  const [form, setForm] = useState(initialForm);
  return (
    <Drawer title="New wording" onClose={onCancel}>
      <form
        className="form-grid"
        data-dirty={JSON.stringify(form) !== JSON.stringify(initialForm) ? 'true' : 'false'}
        onChange={() => setRequestId(newRequestId())}
        onSubmit={async (event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const created = await action.run(
            () =>
              postJson<ClauseWithVersions>('/api/clause-templates', {
                action: 'create',
                requestId,
                name: form.name.trim(),
                category: form.category,
                governingAct: form.governingAct.trim(),
                displayOrder: Number(form.displayOrder) || 0,
                description: form.description.trim(),
                usageContexts: form.usageContexts,
              }),
            'Wording created',
          );
          if (created) {
            formElement.setAttribute('data-dirty', 'false');
            onCreated(created.id);
          }
        }}
      >
        <label className="full">
          Name
          <input
            required
            maxLength={160}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Category
          <select
            value={form.category}
            onChange={(event) =>
              setForm({ ...form, category: event.target.value as ClauseCategory })
            }
          >
            {CLAUSE_CATEGORIES.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Governing Act
          <input
            value={form.governingAct}
            maxLength={160}
            onChange={(event) => setForm({ ...form, governingAct: event.target.value })}
          />
        </label>
        <label>
          Display order
          <input
            type="number"
            min={0}
            value={form.displayOrder}
            onChange={(event) => setForm({ ...form, displayOrder: event.target.value })}
          />
        </label>
        <UsageChecks
          value={form.usageContexts}
          onChange={(usageContexts) => setForm({ ...form, usageContexts })}
        />
        <label className="full">
          Description
          <input
            maxLength={1000}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <div className="full form-footer">
          <ActionFeedback error={action.error} status={action.status} />
          <div className="actions">
            <button className="primary" disabled={action.pending || !form.usageContexts.length}>
              Create wording
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await canLeaveEditing()) onCancel();
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
