'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { APPLICATIONS } from '@/domain/ar1/mtool-lists';
import {
  needsCourtOrder,
  needsDeclaration,
  returnFor,
  type AnnualReturn,
} from '@/domain/ar1/returns';
import { formatDate, useWorkspace } from '@/components/workspace';
import { newRequestId, postJson } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { canLeaveEditing } from '@/components/edit-guard';

/** Starts the return for one calendar year; the dates follow from the incorporation date. */
export function StartReturn({
  companyId,
  calendarYear,
  from,
  onClose,
}: {
  companyId: string;
  calendarYear: number;
  /** Where the return's back link leads: the list or the company record. */
  from: 'list' | 'company';
  onClose: () => void;
}) {
  const { data } = useWorkspace();
  const router = useRouter();
  const action = useAction();
  const [application, setApplication] = useState<string>(APPLICATIONS[0]);
  const [declaration, setDeclaration] = useState('');
  const [courtOrder, setCourtOrder] = useState('');
  const [requestId] = useState(newRequestId);
  const company = data?.companies.find((c) => c.id === companyId);
  const period = company ? returnFor(company.incorporationDate, calendarYear) : null;
  const rectifying = needsDeclaration(application);
  const court = needsCourtOrder(application);
  return (
    <Drawer title="Start annual return" onClose={onClose}>
      <form
        className="form-stack"
        data-dirty={application !== APPLICATIONS[0] || declaration || courtOrder ? 'true' : 'false'}
        onSubmit={async (event) => {
          event.preventDefault();
          const record = await action.run(() =>
            postJson<AnnualReturn>('/api/annual-returns', {
              requestId,
              companyId,
              calendarYear,
              application,
              rectificationDeclaration: rectifying ? declaration : '',
              courtOrderReference: court ? courtOrder : '',
            }),
          );
          if (record) router.push(`/annual-returns/${record.id}?from=${from}`);
        }}
      >
        <dl className="facts stacked">
          <div>
            <dt>Company</dt>
            <dd>{company?.name}</dd>
          </div>
          <div>
            <dt>Calendar year</dt>
            <dd>{calendarYear}</dd>
          </div>
          <div>
            <dt>Date of annual return</dt>
            <dd>{period ? formatDate(period.returnDate) : ''}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{period ? formatDate(period.dueDate) : ''}</dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>AR1, company with 500 or fewer members</dd>
          </div>
        </dl>
        <label>
          Application of submission
          <select value={application} onChange={(e) => setApplication(e.target.value)}>
            {APPLICATIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        {rectifying ? (
          <label>
            Statutory declaration for rectification
            <textarea
              maxLength={2000}
              value={declaration}
              onChange={(e) => setDeclaration(e.target.value)}
            />
          </label>
        ) : null}
        {court ? (
          <label>
            Court order reference
            <input
              maxLength={200}
              value={courtOrder}
              onChange={(e) => setCourtOrder(e.target.value)}
            />
          </label>
        ) : null}
        <ActionFeedback error={action.error} status={action.status} />
        <div className="actions">
          <button className="primary" disabled={action.pending || !period}>
            Start annual return
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
