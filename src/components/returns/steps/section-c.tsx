'use client';
import { useState } from 'react';
import Link from 'next/link';
import { formatMyr } from '@/domain/ar1/money';
import { formatDate } from '@/components/workspace';
import { ActionFeedback } from '@/components/resolution/use-action';
import { useSave, type ReturnView } from '../step-parts';

export function SectionC({ view, onSaved }: { view: ReturnView; onSaved: () => Promise<void> }) {
  const { action, save } = useSave(view, onSaved);
  const [notes, setNotes] = useState(view.record.answers.notesOnIndebtedness);
  const charges = view.data.c.charges;
  return (
    <>
      <div className="person-section-heading">
        <h3>Charges outstanding at {formatDate(view.record.returnDate)}</h3>
        <Link className="section-link" href={`/companies/${view.company.id}?tab=charges`}>
          Open charges
        </Link>
      </div>
      {charges.length ? (
        <div className="table-wrap">
          <table className="records-table">
            <caption className="sr-only">Charges</caption>
            <thead>
              <tr>
                <th>Registered no.</th>
                <th className="col-date">Registered</th>
                <th>Nature</th>
                <th>Chargee</th>
                <th className="num">Amount (MYR)</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.registeredNumber}>
                  <td>{c.registeredNumber}</td>
                  <td>{formatDate(c.registeredIso)}</td>
                  <td title={c.nature}>{c.nature}</td>
                  <td title={c.chargee}>{c.chargee}</td>
                  <td className="num">{formatMyr(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No charges outstanding on the return date</p>
      )}
      <form
        className="form-stack return-form"
        data-dirty={notes !== view.record.answers.notesOnIndebtedness ? 'true' : 'false'}
        onSubmit={(event) => {
          event.preventDefault();
          void save({ answers: { ...view.record.answers, notesOnIndebtedness: notes } });
        }}
      >
        <label>
          Explanatory notes on indebtedness (optional)
          <textarea maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <ActionFeedback error={action.error} status={action.status} conflict={action.conflict} />
        <div className="actions">
          <button disabled={action.pending || notes === view.record.answers.notesOnIndebtedness}>
            Save
          </button>
        </div>
      </form>
    </>
  );
}
