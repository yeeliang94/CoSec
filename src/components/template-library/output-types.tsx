'use client';
import { useState } from 'react';
import { type OutputType, type ResolutionBody } from '@/domain/resolution/model';
import { newRequestId, postJson } from '@/components/resolution/api';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { slugId } from '@/components/template-editor/fields';
import { Drawer } from '@/components/resolution/drawer';
import { canLeaveEditing } from '@/components/edit-guard';
import { Empty, Icon } from '@/components/workspace';
import { RowMenu } from '@/components/menu';
import { NoMatches } from './versions';

const BODY_LABELS: Record<ResolutionBody, string> = {
  directors: 'Directors',
  members: 'Members',
  individual: 'One person',
};

export function OutputTypes({
  types,
  reload,
  creating,
  onCreating,
}: {
  types: OutputType[];
  reload: () => Promise<void>;
  creating: boolean;
  onCreating: (value: boolean) => void;
}) {
  const action = useAction();
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const term = query.trim().toLowerCase();
  const rows = types.filter(
    (type) =>
      (!state || (state === 'active') === type.active) &&
      (!term || type.name.toLowerCase().includes(term)),
  );
  const filtered = Boolean(query || state);
  const clearFilters = () => {
    setQuery('');
    setState('');
  };
  return (
    <section aria-labelledby="output-types">
      <h2 id="output-types" className="sr-only">
        Document types
      </h2>
      <div className="toolbar tl-toolbar">
        <label className="search">
          <span className="sr-only">Search document types</span>
          <Icon kind="search" />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">State</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        {filtered && rows.length ? (
          <button type="button" className="quiet" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
      {!creating ? <ActionFeedback error={action.error} status={action.status} /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="library-table tl-table">
            <caption className="sr-only">Document types</caption>
            <thead>
              <tr>
                <th>Document type</th>
                <th>Body</th>
                <th>State</th>
                <th className="tl-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((type) => (
                <tr key={type.id}>
                  <td title={type.name}>{type.name}</td>
                  <td>{BODY_LABELS[type.body]}</td>
                  <td>{type.active ? 'Active' : 'Inactive'}</td>
                  <td className="tl-actions">
                    <RowMenu
                      name={type.name}
                      disabled={action.pending}
                      items={[
                        {
                          label: type.active ? 'Deactivate' : 'Activate',
                          onSelect: async () => {
                            const ok = await action.run(
                              () =>
                                postJson('/api/output-types', {
                                  action: 'update',
                                  requestId: newRequestId(),
                                  id: type.id,
                                  active: !type.active,
                                }),
                              `${type.name} ${type.active ? 'deactivated' : 'activated'}`,
                            );
                            if (ok) await reload();
                          },
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : filtered ? (
        <NoMatches onClear={clearFilters} />
      ) : (
        <Empty>No document types yet</Empty>
      )}
      {creating ? (
        <CreateOutputType
          types={types}
          reload={reload}
          onClose={() => onCreating(false)}
          onCreated={(name) => {
            action.setError('');
            action.setStatus(`${name} added`);
            onCreating(false);
          }}
        />
      ) : null}
    </section>
  );
}

/** The draft and creation feedback live only as long as the drawer is open. */
function CreateOutputType({
  types,
  reload,
  onClose,
  onCreated,
}: {
  types: OutputType[];
  reload: () => Promise<void>;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const action = useAction();
  const [name, setName] = useState('');
  const [body, setBody] = useState<ResolutionBody>('directors');
  return (
    <Drawer title="New document type" onClose={onClose}>
      <form
        className="form-grid"
        data-dirty={name || body !== 'directors' ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await action.run(
            () =>
              postJson('/api/output-types', {
                action: 'create',
                requestId: newRequestId(),
                id: slugId(
                  name,
                  types.map((t) => t.id),
                ),
                name: name.trim(),
                body,
                order: (types.at(-1)?.order ?? 0) + 10,
              }),
            `${name.trim()} added`,
          );
          if (ok) {
            await reload();
            onCreated(name.trim());
          }
        }}
      >
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Body
          <select value={body} onChange={(e) => setBody(e.target.value as typeof body)}>
            <option value="directors">Directors</option>
            <option value="members">Members</option>
            <option value="individual">One person</option>
          </select>
        </label>
        <div className="full">
          <ActionFeedback error={action.error} status={action.status} />
        </div>
        <div className="actions">
          <button className="primary" disabled={action.pending}>
            Add document type
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
