'use client';
import { useState } from 'react';
import { SHARE_KINDS, type ShareClass } from '@/domain/ar1/shares';
import { newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';

/** Side panel that keeps the company's share classes and the section B column each falls in. */
export function ShareClassesEdit({
  companyId,
  classes,
  revision,
  onSaved,
  onClose,
}: {
  companyId: string;
  classes: ShareClass[];
  revision: number;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const edit = useAction();
  const [list, setList] = useState<ShareClass[]>(() =>
    classes.length
      ? structuredClone(classes)
      : [{ id: '', name: 'Ordinary shares', kind: 'Ordinary' }],
  );
  const [reason, setReason] = useState('');
  const dirty = JSON.stringify(list) !== JSON.stringify(classes) || Boolean(reason);
  return (
    <Drawer title="Share classes" onClose={onClose}>
      <form
        className="form-stack grouped-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await edit.run(() =>
            postJson(`/api/companies/${companyId}/profile`, {
              action: 'set_share_classes',
              expectedRevision: revision,
              requestId: newRequestId(),
              classes: list.map(({ id, ...c }) => ({ ...(id ? { id } : {}), ...c })),
              reason: reason.trim(),
            }),
          );
          if (ok) {
            await onSaved();
            onClose();
          }
        }}
      >
        {list.map((c, i) => (
          <fieldset className="form-group" key={c.id || i}>
            <legend>Class {i + 1}</legend>
            <div className="form-stack">
              <label>
                Name
                <input
                  required
                  maxLength={100}
                  value={c.name}
                  onChange={(e) =>
                    setList((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                />
              </label>
              <label>
                Kind (section B column)
                <select
                  value={c.kind}
                  onChange={(e) =>
                    setList((l) =>
                      l.map((x, j) =>
                        j === i ? { ...x, kind: e.target.value as ShareClass['kind'] } : x,
                      ),
                    )
                  }
                >
                  {SHARE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k === 'Other' ? 'Other kinds of shares' : `${k} shares`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setList((l) => l.filter((_, j) => j !== i))}
              >
                Remove class {i + 1}
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="text-button section-link"
          onClick={() => setList((l) => [...l, { id: '', name: '', kind: 'Ordinary' }])}
        >
          Add class
        </button>
        <label>
          Reason
          <input required value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <ActionFeedback error={edit.error} status={edit.status} conflict={edit.conflict} />
        <div className="actions">
          <button className="primary" disabled={edit.pending || !dirty}>
            Save share classes
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
