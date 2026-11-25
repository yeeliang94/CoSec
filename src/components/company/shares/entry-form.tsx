'use client';
import { useState } from 'react';
import type { ResolutionCase } from '@/domain/resolution/model';
import {
  CONSIDERATIONS,
  SHARE_ENTRY_LABELS,
  type Holder,
  type ShareClass,
  type ShareEntry,
  type ShareEntryKind,
  type TrusteeType,
} from '@/domain/ar1/shares';
import { TRUSTEE_TYPES } from '@/domain/ar1/mtool-lists';
import { useWorkspace } from '@/components/workspace';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { useLoad } from '@/components/resolution/use-load';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';
import { HolderPicker } from './holder-picker';

type HolderForm = {
  partyIds: string[];
  trustee: boolean;
  trusteeType: string;
  subjectName: string;
  subjectIdType: string;
  subjectIdNumber: string;
  subjectNationality: string;
};
const holderForm = (h: Holder | null | undefined): HolderForm => ({
  partyIds: h?.partyIds.length ? [...h.partyIds] : [''],
  trustee: Boolean(h?.trustee),
  trusteeType: h?.trustee?.type ?? '',
  subjectName: h?.trustee?.subjectName ?? '',
  subjectIdType: h?.trustee?.subjectIdType ?? '',
  subjectIdNumber: h?.trustee?.subjectIdNumber ?? '',
  subjectNationality: h?.trustee?.subjectNationality ?? '',
});
const toHolder = (f: HolderForm): Holder => ({
  partyIds: f.partyIds.filter(Boolean),
  trustee: f.trustee
    ? {
        type: f.trusteeType as TrusteeType,
        subjectName: f.subjectName,
        subjectIdType: f.subjectIdType,
        subjectIdNumber: f.subjectIdNumber,
        subjectNationality: f.subjectNationality,
      }
    : null,
});

function HolderFields({
  legend,
  value,
  onChange,
  nameOf,
  onPicked,
  allowTrust,
}: {
  legend: string;
  value: HolderForm;
  onChange: (next: HolderForm) => void;
  nameOf: (id: string) => string;
  onPicked: (id: string, name: string) => void;
  allowTrust: boolean;
}) {
  return (
    <fieldset className="form-group">
      <legend>{legend}</legend>
      <div className="form-stack">
        {value.partyIds.map((id, i) => (
          <HolderPicker
            key={i}
            label={
              i ? `Joint holder ${i + 1}` : value.partyIds.length > 1 ? 'Joint holder 1' : 'Holder'
            }
            required={i === 0}
            value={id}
            name={id ? nameOf(id) : ''}
            onChange={(next, name) => {
              if (next) onPicked(next, name);
              onChange({
                ...value,
                partyIds: value.partyIds.map((x, j) => (j === i ? next : x)),
              });
            }}
          />
        ))}
        <button
          type="button"
          className="text-button section-link"
          onClick={() => onChange({ ...value, partyIds: [...value.partyIds, ''] })}
        >
          Add joint holder
        </button>
        {allowTrust ? (
          <>
            <label className="inline">
              <input
                type="checkbox"
                checked={value.trustee}
                onChange={(e) => onChange({ ...value, trustee: e.target.checked })}
              />
              Held as trustee
            </label>
            {value.trustee ? (
              <div className="form-stack dependent">
                <label>
                  Type of trustee
                  <select
                    required
                    value={value.trusteeType}
                    onChange={(e) => onChange({ ...value, trusteeType: e.target.value })}
                  >
                    <option value="">Select…</option>
                    {TRUSTEE_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Held for (name)
                  <input
                    required
                    value={value.subjectName}
                    onChange={(e) => onChange({ ...value, subjectName: e.target.value })}
                  />
                </label>
                <label>
                  Their ID type
                  <input
                    value={value.subjectIdType}
                    onChange={(e) => onChange({ ...value, subjectIdType: e.target.value })}
                  />
                </label>
                <label>
                  Their ID number
                  <input
                    value={value.subjectIdNumber}
                    onChange={(e) => onChange({ ...value, subjectIdNumber: e.target.value })}
                  />
                </label>
                <label>
                  Their nationality
                  <input
                    value={value.subjectNationality}
                    onChange={(e) => onChange({ ...value, subjectNationality: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </fieldset>
  );
}

/** Side panel that records, or corrects, one share register entry as a draft for review. */
export function ShareEntryEdit({
  companyId,
  kind: initialKind,
  correcting,
  classes,
  names,
  onSaved,
  onClose,
}: {
  companyId: string;
  kind: ShareEntryKind;
  correcting?: ShareEntry;
  classes: ShareClass[];
  /** Names of the people the register already names, by id. */
  names: Map<string, string>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { data } = useWorkspace();
  const edit = useAction();
  const cases = useLoad(
    () =>
      getJson<{ cases: ResolutionCase[] }>(
        '/api/resolution-cases?companyId=' + encodeURIComponent(companyId),
      ),
    [companyId],
  );
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map());
  const nameOf = (id: string) => picked.get(id) ?? names.get(id) ?? '';
  const onPicked = (id: string, name: string) =>
    setPicked((m) => (m.get(id) === name ? m : new Map(m).set(id, name)));
  const [kind] = useState<ShareEntryKind>(correcting?.kind ?? initialKind);
  const [voids, setVoids] = useState(false);
  const [date, setDate] = useState(correcting?.date ?? '');
  const [classId, setClassId] = useState(correcting?.classId ?? classes[0]?.id ?? '');
  const [shares, setShares] = useState(correcting?.shares ?? '');
  const [from, setFrom] = useState(() => holderForm(correcting?.from));
  const [to, setTo] = useState(() => holderForm(correcting?.to));
  const [amountPayable, setPayable] = useState(correcting?.amountPayable ?? '');
  const [amountPaid, setPaid] = useState(correcting?.amountPaid ?? '');
  const [consideration, setConsideration] = useState<string>(correcting?.consideration ?? 'Cash');
  const [source, setSource] = useState(
    correcting?.sourceCaseId
      ? `case:${correcting.sourceCaseId}`
      : correcting?.sourceDocumentId
        ? `doc:${correcting.sourceDocumentId}`
        : '',
  );
  const [note, setNote] = useState('');
  const adds = kind === 'opening' || kind === 'allotment';
  const moves = kind === 'transfer' || kind === 'buyback';
  const documents = (data?.documents ?? []).filter(
    (d) => d.companyId === companyId && d.classification === 'General',
  );
  // The server already lists this company's cases only; the filter keeps that true if it changes.
  const companyCases = (cases.data?.cases ?? []).filter((c) => c.companyId === companyId);
  const title = correcting
    ? `Correct ${SHARE_ENTRY_LABELS[kind].toLowerCase()}`
    : `Record ${SHARE_ENTRY_LABELS[kind].toLowerCase()}`;
  return (
    <Drawer title={title} onClose={onClose}>
      <form
        className="form-stack grouped-form"
        data-dirty={date || shares || note ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${companyId}/shares`, {
              action: correcting ? 'correct' : 'record',
              ...(correcting ? { id: correcting.id, voids } : {}),
              requestId: newRequestId(),
              kind,
              date,
              classId,
              shares: shares.replace(/[,\s]/g, ''),
              from: moves ? toHolder(from) : null,
              to: kind === 'buyback' ? null : toHolder(to),
              amountPayable: adds ? amountPayable.replace(/[,\s]/g, '') : null,
              amountPaid: adds ? amountPaid.replace(/[,\s]/g, '') : null,
              consideration: adds ? consideration : null,
              sourceDocumentId: source.startsWith('doc:') ? source.slice(4) : null,
              sourceCaseId: source.startsWith('case:') ? source.slice(5) : null,
              note,
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {correcting ? (
          <label className="inline">
            <input type="checkbox" checked={voids} onChange={(e) => setVoids(e.target.checked)} />
            Remove this entry from the register instead
          </label>
        ) : null}
        {voids ? null : (
          <>
            <fieldset className="form-group">
              <legend>Entry</legend>
              <div className="form-stack">
                <label>
                  Date
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label>
                  Share class
                  <select required value={classId} onChange={(e) => setClassId(e.target.value)}>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Number of shares
                  <input
                    required
                    inputMode="numeric"
                    value={shares}
                    onChange={(e) => setShares(e.target.value)}
                  />
                </label>
              </div>
            </fieldset>
            {moves ? (
              <HolderFields
                legend={kind === 'buyback' ? 'Bought back from' : 'From'}
                value={from}
                onChange={setFrom}
                nameOf={nameOf}
                onPicked={onPicked}
                allowTrust
              />
            ) : null}
            {kind !== 'buyback' ? (
              <HolderFields
                legend="To"
                value={to}
                onChange={setTo}
                nameOf={nameOf}
                onPicked={onPicked}
                allowTrust
              />
            ) : null}
            {adds ? (
              <fieldset className="form-group">
                <legend>Payment</legend>
                <div className="form-stack">
                  <label>
                    Amount payable (MYR)
                    <input
                      required
                      inputMode="decimal"
                      value={amountPayable}
                      onChange={(e) => setPayable(e.target.value)}
                    />
                  </label>
                  <label>
                    Amount paid (MYR)
                    <input
                      required
                      inputMode="decimal"
                      value={amountPaid}
                      onChange={(e) => setPaid(e.target.value)}
                    />
                  </label>
                  <label>
                    Consideration
                    <select
                      value={consideration}
                      onChange={(e) => setConsideration(e.target.value)}
                    >
                      {CONSIDERATIONS.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
            ) : null}
            <label>
              Source
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Select…</option>
                {companyCases.length ? (
                  <optgroup label="Resolutions">
                    {companyCases.map((c) => (
                      <option key={c.id} value={`case:${c.id}`}>
                        {c.title}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {documents.length ? (
                  <optgroup label="Documents">
                    {documents.map((d) => (
                      <option key={d.id} value={`doc:${d.id}`}>
                        {d.title}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
          </>
        )}
        <label>
          Note (optional)
          <input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending}>
            Save draft for review
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
