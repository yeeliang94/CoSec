'use client';
import { useState } from 'react';
import { Drawer } from '@/components/resolution/drawer';
import { errorText, postJson } from '@/components/resolution/api';
import { nameKey } from '@/domain/imports';
import type { ImportView } from './types';

/** Files an agent set aside as plainly about another company; a person chooses where each goes. */
export function StrayFiles({
  view,
  onClose,
  onSaved,
}: {
  view: ImportView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const stray = view.files.filter((f) => f.result === 'Another company');
  const open = view.companies.filter((c) => !['Applied', 'Left out'].includes(c.status));
  const suggestedFor = (other: string | undefined) => {
    const key = nameKey(other ?? '');
    return open.find(
      (c) =>
        key &&
        (nameKey(c.name) === key ||
          nameKey(c.name).startsWith(key + ' ') ||
          key.startsWith(nameKey(c.name) + ' ')),
    );
  };
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(stray.map((f) => [f.id, suggestedFor(f.otherCompany)?.id ?? 'leave_out'])),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function save() {
    setPending(true);
    setError('');
    try {
      for (const f of stray)
        await postJson(`/api/imports/${view.batch.id}/companies/${f.companyRowId}`, {
          action: 'move_file',
          fileId: f.id,
          toRowId: choices[f.id] === 'leave_out' ? null : choices[f.id],
        });
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <Drawer title="Files that look like another company" onClose={onClose}>
      <table className="records-table import-table">
        <caption className="sr-only">Files that look like another company</caption>
        <colgroup>
          <col style={{ width: '28%' }} />
          <col style={{ width: '24%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>File</th>
            <th>In folder</th>
            <th>Use for</th>
          </tr>
        </thead>
        <tbody>
          {stray.map((f) => {
            const suggested = suggestedFor(f.otherCompany);
            return (
              <tr key={f.id}>
                <td title={f.path}>{f.name}</td>
                <td title={f.companyName}>
                  {view.companies.find((c) => c.id === f.companyRowId)?.folder}
                </td>
                <td>
                  <select
                    aria-label={`Use ${f.name} for`}
                    value={choices[f.id]}
                    onChange={(e) => setChoices({ ...choices, [f.id]: e.target.value })}
                  >
                    {suggested ? (
                      <option value={suggested.id}>{suggested.name} (suggested)</option>
                    ) : null}
                    <option value="leave_out">Leave out{suggested ? '' : ' (suggested)'}</option>
                    {open
                      .filter((c) => c.id !== suggested?.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="import-drawer-actions">
        {error ? (
          <p className="feedback error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={pending} onClick={() => void save()}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}
