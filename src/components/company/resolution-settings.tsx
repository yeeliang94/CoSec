'use client';
import { Fragment, useState } from 'react';
import {
  CITATION_KEYS,
  type CitationKey,
  type CompanyProfile,
  type DatedValue,
  type RecordFieldDefinition,
} from '@/domain/resolution/model';
import { entryAt } from '@/domain/resolution/records';
import { currentDate, formatDate, useWorkspace } from '@/components/workspace';
import { canLeaveEditing } from '@/components/edit-guard';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { CustomValueInput } from '@/components/resolution/custom-value';
import { Drawer } from '@/components/resolution/drawer';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';

const CITATION_LABELS: Record<CitationKey, string> = {
  directorAuthority: "Directors' authority",
  memberAuthority: "Members' authority",
  electionAuthority: 'Election of directors',
};

type Entry = {
  key: string;
  label: string;
  values: DatedValue[] | undefined;
  definition?: RecordFieldDefinition;
  onSave: (value: string, effectiveDate: string, reason: string) => Promise<unknown>;
};

function display(v: DatedValue['value'] | undefined, definition?: RecordFieldDefinition) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return definition?.options?.find((o) => o.id === v)?.label || String(v);
}

/** Constitution citations and company custom values: dated, with their history kept. */
export function CompanyResolutionSettings({ companyId }: { companyId: string }) {
  const { data } = useWorkspace();
  const profile = useLoad(
    () => getJson<CompanyProfile>(`/api/companies/${companyId}/profile`),
    [companyId],
  );
  const definitions = useLoad(
    () => getJson<{ definitions: RecordFieldDefinition[] }>('/api/record-fields?scope=company'),
    [],
  );
  const caps = data?.actor.capabilities ?? [];
  const canEdit = caps.includes('manage_people') || caps.includes('confirm_record');
  const save = (body: Record<string, unknown>) =>
    postJson<CompanyProfile>(`/api/companies/${companyId}/profile`, {
      ...body,
      expectedRevision: profile.data!.revision,
      requestId: newRequestId(),
    }).then((next) => {
      profile.setData(next);
      return next;
    });
  const fields = (definitions.data?.definitions ?? []).filter((d) => !d.archived);
  return (
    <>
      <LoadState
        loading={profile.loading && !profile.data}
        error={profile.error}
        reload={() => void profile.reload()}
        label="company settings"
      />
      {profile.data ? (
        <>
          <section className="section" aria-labelledby="citations">
            <h2 id="citations">Constitution citations</h2>
            <DatedTable
              caption="Constitution citations"
              nameHeader="Citation"
              valueHeader="Current wording"
              canEdit={canEdit}
              entries={CITATION_KEYS.map((key) => ({
                key,
                label: CITATION_LABELS[key],
                values: profile.data!.citations[key],
                onSave: (value, effectiveDate, reason) =>
                  save({ action: 'set_citation', key, value, effectiveDate, reason }),
              }))}
            />
          </section>
          {fields.length ? (
            <section className="section" aria-labelledby="custom-values">
              <h2 id="custom-values">Company custom values</h2>
              <DatedTable
                caption="Company custom values"
                nameHeader="Field"
                valueHeader="Current value"
                canEdit={canEdit}
                entries={fields.map((definition) => ({
                  key: definition.id,
                  label: definition.label,
                  definition,
                  values: Object.hasOwn(profile.data!.customValues, definition.id)
                    ? profile.data!.customValues[definition.id]
                    : undefined,
                  onSave: (value, effectiveDate, reason) =>
                    save({
                      action: 'set_custom',
                      definitionId: definition.id,
                      value: definition.valueType === 'boolean' ? value === 'true' : value,
                      effectiveDate,
                      reason,
                    }),
                }))}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function DatedTable({
  caption,
  nameHeader,
  valueHeader,
  entries,
  canEdit,
}: {
  caption: string;
  nameHeader: string;
  valueHeader: string;
  entries: Entry[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState('');
  const [history, setHistory] = useState('');
  const [status, setStatus] = useState('');
  const editingEntry = entries.find((entry) => entry.key === editing);
  return (
    <>
      <div className="table-wrap">
        <table className="records-table dated-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th>{nameHeader}</th>
              <th>{valueHeader}</th>
              <th>Effective</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const now = entryAt(entry.values, currentDate());
              const value = display(now?.value, entry.definition);
              const open = history === entry.key;
              return (
                <Fragment key={entry.key}>
                  <tr>
                    <td title={entry.label}>{entry.label}</td>
                    <td title={value}>{value}</td>
                    <td>{now ? formatDate(now.effectiveDate) : ''}</td>
                    <td className="cell-action">
                      <div className="row-actions">
                        {entry.values?.length ? (
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`History of ${entry.label}`}
                            aria-expanded={open}
                            onClick={() => setHistory(open ? '' : entry.key)}
                          >
                            History
                          </button>
                        ) : null}
                        {canEdit ? (
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`Change ${entry.label}`}
                            onClick={() => {
                              setStatus('');
                              setEditing(entry.key);
                            }}
                          >
                            Change
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="dated-history">
                      <td colSpan={4}>
                        <ul className="compact-list">
                          {[...(entry.values ?? [])].reverse().map((v, i) => (
                            <li key={i}>
                              {display(v.value, entry.definition)}, from{' '}
                              {formatDate(v.effectiveDate)}, recorded {formatDate(v.recordedAt)}
                              {v.reason ? `, ${v.reason}` : ''}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {status ? (
        <p className="success dated-status" role="status">
          {status}
        </p>
      ) : null}
      {editingEntry ? (
        <RecordValue
          entry={editingEntry}
          onClose={() => setEditing('')}
          onSaved={() => {
            setEditing('');
            setStatus(`${editingEntry.label} recorded`);
          }}
        />
      ) : null}
    </>
  );
}

function RecordValue({
  entry,
  onClose,
  onSaved,
}: {
  entry: Entry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { label, definition } = entry;
  const now = entryAt(entry.values, currentDate());
  const initialValue =
    typeof now?.value === 'boolean'
      ? String(now.value)
      : typeof now?.value === 'string'
        ? now.value
        : '';
  const [initialDate] = useState(currentDate);
  const action = useAction();
  const [value, setValue] = useState(initialValue);
  const [effectiveDate, setEffectiveDate] = useState(initialDate);
  const [reason, setReason] = useState('');
  const dirty = value !== initialValue || effectiveDate !== initialDate || Boolean(reason);
  return (
    <Drawer title={`Change ${label.toLowerCase()}`} onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await action.run(() =>
            entry.onSave(value.trim(), effectiveDate, reason.trim()),
          );
          if (ok !== undefined) onSaved();
        }}
      >
        {definition ? (
          <CustomValueInput definition={definition} value={value} onChange={setValue} />
        ) : (
          <label>
            Citation
            <input required value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        )}
        <label>
          Applies from
          <input
            type="date"
            required
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </label>
        <label>
          Reason and source
          <input required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <ActionFeedback error={action.error} status="" conflict={action.conflict} />
        <div className="actions">
          <button className="primary" disabled={action.pending}>
            Record {label.toLowerCase()}
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
