'use client';
import { useState } from 'react';
import { FILING_LABELS, FILING_ROWS, type FilingField } from '@/domain/ar1/build';
import { needsCourtOrder, needsDeclaration } from '@/domain/ar1/returns';
import { APPLICATIONS } from '@/domain/ar1/mtool-lists';
import { ActionFeedback } from '@/components/resolution/use-action';
import { useSave, type ReturnView } from '../step-parts';

export function FilingStep({ view, onSaved }: { view: ReturnView; onSaved: () => Promise<void> }) {
  const { action, save } = useSave(view, onSaved);
  const [application, setApplication] = useState<string>(view.record.application);
  const [declaration, setDeclaration] = useState(view.record.rectificationDeclaration);
  const [court, setCourt] = useState(view.record.courtOrderReference);
  const [quoted, setQuoted] = useState(view.record.answers.sharesQuoted ?? '');
  const isPublic = view.data.filingInfo.status === 'Public company';
  const dirty =
    application !== view.record.application ||
    declaration !== view.record.rectificationDeclaration ||
    court !== view.record.courtOrderReference ||
    quoted !== (view.record.answers.sharesQuoted ?? '');
  return (
    <>
      <p className="muted">
        Enter these in mTool when you make the blank workbook. mTool sets them in its own filing
        information dialog; the app checks them when you upload the blank.
      </p>
      <div className="table-wrap">
        <table className="records-table filing-table">
          <caption className="sr-only">Filing information</caption>
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(FILING_ROWS) as FilingField[]).map((field) => (
              <tr key={field}>
                <td>{FILING_LABELS[field]}</td>
                <td title={view.data.filingInfo[field]}>{view.data.filingInfo[field]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="form-stack return-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            application,
            rectificationDeclaration: declaration,
            courtOrderReference: court,
            answers: { ...view.record.answers, sharesQuoted: quoted || null },
          });
        }}
      >
        <label>
          Application of submission
          <select value={application} onChange={(e) => setApplication(e.target.value)}>
            {APPLICATIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        {needsDeclaration(application) ? (
          <label>
            Statutory declaration for rectification
            <textarea
              maxLength={2000}
              value={declaration}
              onChange={(e) => setDeclaration(e.target.value)}
            />
          </label>
        ) : null}
        {needsCourtOrder(application) ? (
          <label>
            Court order reference
            <input maxLength={200} value={court} onChange={(e) => setCourt(e.target.value)} />
          </label>
        ) : null}
        {isPublic ? (
          <label>
            Shares quoted on a stock exchange
            <select value={quoted} onChange={(e) => setQuoted(e.target.value)}>
              <option value="">Select…</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </label>
        ) : null}
        <ActionFeedback error={action.error} status={action.status} conflict={action.conflict} />
        <div className="actions">
          <button disabled={action.pending || !dirty}>Save</button>
        </div>
      </form>
    </>
  );
}
