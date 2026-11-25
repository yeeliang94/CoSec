'use client';
import { useState } from 'react';
import type { RelationshipRole } from '@/domain/resolution/model';
import { useWorkspace } from '@/components/workspace';
import { canLeaveEditing } from '@/components/edit-guard';
import { newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { roleName, ROLE_ORDER } from '@/components/resolution/relationships';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';

/** Links a person to a company the actor can see, through the company page's relationship API. */
export function AddToCompany({
  personId,
  onAdded,
  onClose,
}: {
  personId: string;
  onAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const { data } = useWorkspace();
  const action = useAction();
  const [form, setForm] = useState({
    companyId: '',
    role: 'director' as RelationshipRole,
    startDate: '',
  });
  const dirty = Boolean(form.companyId || form.role !== 'director' || form.startDate);
  return (
    <Drawer title="Add to a company" onClose={onClose}>
      <form
        className="form-stack"
        inert={action.pending}
        aria-busy={action.pending}
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await action.run(() =>
            postJson(`/api/companies/${form.companyId}/relationships`, {
              action: 'add',
              requestId: newRequestId(),
              personId,
              role: form.role,
              capacity: '',
              startDate: form.startDate || null,
              evidenceIds: [],
            }),
          );
          if (ok) {
            // Clear the form first so its data-dirty mark cannot outlive the save.
            setForm({ companyId: '', role: 'director', startDate: '' });
            await onAdded();
            onClose();
          }
        }}
      >
        <label>
          Company
          <select
            required
            value={form.companyId}
            onChange={(event) => setForm({ ...form, companyId: event.target.value })}
          >
            <option value="">Select a company</option>
            {data?.companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field-pair">
          <label>
            Role
            <select
              value={form.role}
              onChange={(event) =>
                setForm({ ...form, role: event.target.value as RelationshipRole })
              }
            >
              {ROLE_ORDER.map((role) => (
                <option key={role} value={role}>
                  {roleName(role)}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={form.startDate}
              onChange={(event) => setForm({ ...form, startDate: event.target.value })}
            />
          </label>
        </div>
        <ActionFeedback error={action.error} status={action.status} />
        <div className="actions">
          <button className="primary" disabled={action.pending}>
            Add to company
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
