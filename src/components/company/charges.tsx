'use client';
import { useState } from 'react';
import type { Charge } from '@/domain/ar1/charges';
import { formatMyr } from '@/domain/ar1/money';
import { formatDate, useWorkspace } from '@/components/workspace';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';
import { RowMenu } from '@/components/menu';

/** Registered charges, outstanding or discharged, for AR1 section C. */
export function CompanyCharges({ companyId }: { companyId: string }) {
  const { data } = useWorkspace();
  const load = useLoad(
    () => getJson<{ charges: Charge[] }>(`/api/companies/${companyId}/charges`),
    [companyId],
  );
  const [editing, setEditing] = useState<{ charge: Charge | null; discharge?: boolean } | null>(
    null,
  );
  if (!data) return null;
  const canEdit = data.actor.capabilities.some(
    (c) => c === 'confirm_record' || c === 'manage_people',
  );
  const charges = load.data?.charges;
  return (
    <section className="section">
      <div className="person-section-heading">
        <h3>Charges</h3>
        {canEdit ? (
          <button type="button" onClick={() => setEditing({ charge: null })}>
            Record charge
          </button>
        ) : null}
      </div>
      <LoadState
        loading={load.loading && !load.data}
        error={load.error}
        reload={() => void load.reload()}
        label="charges"
      />
      {charges ? (
        charges.length ? (
          <div className="table-wrap">
            <table className="records-table">
              <caption className="sr-only">Registered charges</caption>
              <thead>
                <tr>
                  <th>Registered no.</th>
                  <th className="col-date">Registered</th>
                  <th>Nature</th>
                  <th>Chargee</th>
                  <th className="num">Amount (MYR)</th>
                  <th>Status</th>
                  <th className="col-action">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id}>
                    <td>{c.registeredNumber}</td>
                    <td>{formatDate(c.registeredOn)}</td>
                    <td title={c.nature}>{c.nature}</td>
                    <td title={c.chargee}>{c.chargee}</td>
                    <td className="num">{formatMyr(c.amount)}</td>
                    <td>
                      {c.dischargedOn ? `Discharged ${formatDate(c.dischargedOn)}` : 'Outstanding'}
                    </td>
                    <td className="col-action">
                      {canEdit ? (
                        <RowMenu
                          name={c.registeredNumber}
                          items={[
                            { label: 'Correct', onSelect: () => setEditing({ charge: c }) },
                            ...(c.dischargedOn
                              ? []
                              : [
                                  {
                                    label: 'Record discharge',
                                    onSelect: () => setEditing({ charge: c, discharge: true }),
                                  },
                                ]),
                          ]}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No charges recorded</p>
        )
      ) : null}
      {editing ? (
        <ChargeEdit
          companyId={companyId}
          charge={editing.charge}
          discharge={editing.discharge}
          onSaved={load.reload}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ChargeEdit({
  companyId,
  charge,
  discharge,
  onSaved,
  onClose,
}: {
  companyId: string;
  charge: Charge | null;
  discharge?: boolean;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [initial] = useState(() => ({
    registeredNumber: charge?.registeredNumber ?? '',
    registeredOn: charge?.registeredOn ?? '',
    nature: charge?.nature ?? '',
    chargee: charge?.chargee ?? '',
    amount: charge?.amount ?? '',
    dischargedOn: charge?.dischargedOn ?? '',
    // The server replaces the note on every save, so it is edited here rather than dropped.
    note: charge?.note ?? '',
  }));
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState('');
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || Boolean(reason);
  return (
    <Drawer
      title={charge ? (discharge ? 'Record discharge' : 'Correct charge') : 'Record charge'}
      onClose={onClose}
    >
      <form
        className="form-stack"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${companyId}/charges`, {
              action: charge ? 'update' : 'record',
              ...(charge ? { id: charge.id, expectedRevision: charge.revision, reason } : {}),
              requestId: newRequestId(),
              ...form,
              dischargedOn: form.dischargedOn || null,
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {discharge ? null : (
          <>
            <label>
              Registered number
              <input
                required
                maxLength={100}
                value={form.registeredNumber}
                onChange={set('registeredNumber')}
              />
            </label>
            <label>
              Date of registration
              <input
                type="date"
                required
                value={form.registeredOn}
                onChange={set('registeredOn')}
              />
            </label>
            <label>
              Nature of charge
              <input required maxLength={500} value={form.nature} onChange={set('nature')} />
            </label>
            <label>
              Chargee
              <input required maxLength={255} value={form.chargee} onChange={set('chargee')} />
            </label>
            <label>
              Amount secured (MYR)
              <input required inputMode="decimal" value={form.amount} onChange={set('amount')} />
            </label>
          </>
        )}
        <label>
          {discharge ? 'Date discharged' : 'Date discharged (optional)'}
          <input
            type="date"
            required={discharge}
            value={form.dischargedOn}
            onChange={set('dischargedOn')}
          />
        </label>
        {discharge ? null : (
          <label>
            Note (optional)
            <input maxLength={2000} value={form.note} onChange={set('note')} />
          </label>
        )}
        {charge ? (
          <label>
            Reason
            <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending || !dirty}>
            {discharge ? 'Record discharge' : 'Save charge'}
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
