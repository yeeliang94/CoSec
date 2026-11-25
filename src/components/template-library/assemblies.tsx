'use client';
import { canLeaveEditing } from '@/components/edit-guard';
import { Drawer } from '@/components/resolution/drawer';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type OutputType, type UsageContext } from '@/domain/resolution/model';
import { Empty, Icon } from '@/components/workspace';
import {
  newRequestId,
  postJson,
  type AssemblyWithVersions,
  statusOf,
} from '@/components/resolution/api';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { UsageChecks } from './clauses';
import { RowMenu } from '@/components/menu';
import { NoMatches, updatedText, versionText } from './versions';

function assemblyStatus(assembly: AssemblyWithVersions) {
  return assembly.archived ? 'archived' : (statusOf(assembly.versions).last?.status ?? '');
}

export function AssemblyLibrary({
  assemblies,
  outputTypes,
  canManage,
  creating,
  onCreating,
  reload,
}: {
  assemblies: AssemblyWithVersions[];
  outputTypes: OutputType[];
  canManage: boolean;
  creating: boolean;
  onCreating: (value: boolean) => void;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const action = useAction();
  const typeName = (id: string) => outputTypes.find((t) => t.id === id)?.name || id;
  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return assemblies.filter(
      (a) =>
        (status ? assemblyStatus(a) === status : !a.archived) &&
        (!term || `${a.name} ${a.description}`.toLowerCase().includes(term)),
    );
  }, [assemblies, query, status]);
  const filtered = Boolean(query || status);
  const clearFilters = () => {
    setQuery('');
    setStatus('');
  };
  return (
    <>
      {creating ? (
        <CreateAssembly
          outputTypes={outputTypes.filter((t) => t.active)}
          onCancel={() => onCreating(false)}
          onCreated={(id) => router.push('/templates/assemblies/' + id)}
        />
      ) : null}
      <div className="toolbar tl-toolbar">
        <label className="search">
          <span className="sr-only">Search layouts</span>
          <Icon kind="search" />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All in use</option>
            <option value="Draft">Draft</option>
            <option value="Returned">Returned</option>
            <option value="In review">In review</option>
            <option value="archived">Archived</option>
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
            <caption className="sr-only">Layouts</caption>
            <thead>
              <tr>
                <th>Layout</th>
                <th>Version</th>
                <th>Document type</th>
                <th>Updated</th>
                {canManage ? (
                  <th className="tl-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((assembly) => (
                <tr key={assembly.id}>
                  <td>
                    <Link href={'/templates/assemblies/' + assembly.id} title={assembly.name}>
                      {assembly.name}
                    </Link>
                  </td>
                  <td>{versionText(assembly.versions)}</td>
                  <td>{typeName(assembly.outputTypeId)}</td>
                  <td className="tl-date">{updatedText(assembly.versions)}</td>
                  {canManage ? (
                    <td className="tl-actions">
                      <RowMenu
                        name={assembly.name}
                        disabled={action.pending}
                        items={[
                          {
                            label: 'Copy',
                            onSelect: async () => {
                              const copy = await action.run(
                                () =>
                                  postJson<AssemblyWithVersions>('/api/resolution-assemblies', {
                                    action: 'copy',
                                    requestId: newRequestId(),
                                    sourceId: assembly.id,
                                    name: `Copy of ${assembly.name}`.slice(0, 160),
                                  }),
                                `Copied ${assembly.name}`,
                              );
                              if (copy) router.push('/templates/assemblies/' + copy.id);
                            },
                          },
                          {
                            label: assembly.archived ? 'Restore' : 'Archive',
                            onSelect: async () => {
                              const ok = await action.run(
                                () =>
                                  postJson('/api/resolution-assemblies', {
                                    action: 'update',
                                    requestId: newRequestId(),
                                    id: assembly.id,
                                    expectedRevision: assembly.revision,
                                    archived: !assembly.archived,
                                  }),
                                `${assembly.name} ${assembly.archived ? 'restored' : 'archived'}`,
                              );
                              if (ok) await reload();
                            },
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
        <Empty>No layouts yet</Empty>
      )}
    </>
  );
}

function CreateAssembly({
  outputTypes,
  onCancel,
  onCreated,
}: {
  outputTypes: OutputType[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const [requestId, setRequestId] = useState(newRequestId);
  const initialForm = {
    name: '',
    outputTypeId: outputTypes[0]?.id || '',
    description: '',
    usageContexts: ['board'] as UsageContext[],
  };
  const [form, setForm] = useState(initialForm);
  return (
    <Drawer title="New layout" onClose={onCancel}>
      <form
        className="form-grid"
        data-dirty={JSON.stringify(form) !== JSON.stringify(initialForm) ? 'true' : 'false'}
        onChange={() => setRequestId(newRequestId())}
        onSubmit={async (event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const created = await action.run(
            () =>
              postJson<AssemblyWithVersions>('/api/resolution-assemblies', {
                action: 'create',
                requestId,
                name: form.name.trim(),
                outputTypeId: form.outputTypeId,
                description: form.description.trim(),
                usageContexts: form.usageContexts,
              }),
            'Layout created',
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
          Document type
          <select
            value={form.outputTypeId}
            onChange={(event) => setForm({ ...form, outputTypeId: event.target.value })}
          >
            {outputTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
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
              Create layout
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
