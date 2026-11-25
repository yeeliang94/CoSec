'use client';
import { useState } from 'react';
import type { CompanyRelationship } from '@/domain/resolution/model';
import { DIRECTOR_DESIGNATIONS } from '@/domain/resolution/model';
import { newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';
import type { ReturnView } from './step-parts';

/** Side panel that records a director's designation, alternate and nominee status. */
export function AppointmentEdit({
  view,
  relationship,
  onSaved,
  onClose,
}: {
  view: ReturnView;
  relationship: CompanyRelationship;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [designation, setDesignation] = useState<string>(
    relationship.appointment?.designation ?? 'Director',
  );
  const [alternateTo, setAlternateTo] = useState(relationship.appointment?.alternateTo ?? '');
  const [nominee, setNominee] = useState(relationship.appointment?.nominee ?? false);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reason, setReason] = useState('');
  // A recorded value stays in force for earlier returns, so a change needs the date it applies from.
  const recorded = Boolean(relationship.appointment);
  const person = view.people.find((p) => p.id === relationship.personId);
  const principals = view.relationships.filter(
    (r) => r.role === 'director' && r.personId !== relationship.personId,
  );
  return (
    <Drawer title={person?.fullName ?? 'Director'} onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={reason ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${view.company.id}/relationships`, {
              action: 'set_appointment',
              id: relationship.id,
              expectedRevision: relationship.revision,
              requestId: newRequestId(),
              designation,
              alternateTo: designation === 'Alternate director' ? alternateTo || null : null,
              nominee,
              effectiveDate: recorded ? effectiveDate || null : null,
              reason: reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        <label>
          Designation
          <select value={designation} onChange={(e) => setDesignation(e.target.value)}>
            {DIRECTOR_DESIGNATIONS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        {designation === 'Alternate director' ? (
          <label>
            Alternate director to
            <select required value={alternateTo} onChange={(e) => setAlternateTo(e.target.value)}>
              <option value="">Select…</option>
              {principals.map((r) => (
                <option key={r.id} value={r.personId}>
                  {view.people.find((p) => p.id === r.personId)?.fullName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="inline">
          <input type="checkbox" checked={nominee} onChange={(e) => setNominee(e.target.checked)} />
          Nominee director
        </label>
        {recorded ? (
          <label>
            Applies from
            <input
              type="date"
              required
              min={relationship.startDate ?? undefined}
              max={relationship.endDate ?? undefined}
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </label>
        ) : null}
        <label>
          Reason
          <input required value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending}>
            Save to company record
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
