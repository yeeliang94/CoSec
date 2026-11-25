'use client';
import { useState } from 'react';
import { type ReturnAnswers } from '@/domain/ar1/returns';
import { SHARE_KINDS } from '@/domain/ar1/shares';
import { formatMyr } from '@/domain/ar1/money';
import { formatDate } from '@/components/workspace';
import { ActionFeedback } from '@/components/resolution/use-action';
import { useSave, type ReturnView } from '../step-parts';

type KindAnswer = keyof Pick<
  ReturnAnswers['sectionB'],
  | 'forfeitedShares'
  | 'calledUp'
  | 'callsReceived'
  | 'consideredPaidFullyPaid'
  | 'consideredPaidPartlyPaid'
  | 'callsUnpaid'
  | 'paidOnForfeited'
>;
const B_ANSWERS: [KindAnswer, string][] = [
  ['forfeitedShares', 'Shares forfeited'],
  ['calledUp', 'Amount called up (MYR)'],
  ['callsReceived', 'Calls received, including on application and allotment (MYR)'],
  [
    'consideredPaidFullyPaid',
    'Considered as paid on fully paid shares issued otherwise than cash (MYR)',
  ],
  [
    'consideredPaidPartlyPaid',
    'Considered as paid on partly paid shares issued otherwise than cash (MYR)',
  ],
  ['callsUnpaid', 'Calls unpaid (MYR)'],
  ['paidOnForfeited', 'Amount paid on shares forfeited (MYR)'],
];
const KIND_LABEL = {
  Ordinary: 'Ordinary',
  Preference: 'Preference',
  Other: 'Other kinds',
} as const;

export function SectionB({ view, onSaved }: { view: ReturnView; onSaved: () => Promise<void> }) {
  const b = view.data.b;
  const { action, save } = useSave(view, onSaved);
  const [answers, setAnswers] = useState(view.record.answers.sectionB);
  const dirty = JSON.stringify(answers) !== JSON.stringify(view.record.answers.sectionB);
  const row = (label: string, values: Record<string, string>, money = false) => (
    <tr key={label}>
      <td>{label}</td>
      {SHARE_KINDS.map((k) => (
        <td className="num" key={k}>
          {values[k] ? (money ? formatMyr(values[k]) : Number(values[k]).toLocaleString('en')) : ''}
        </td>
      ))}
    </tr>
  );
  return (
    <>
      <h3>From the share register at {formatDate(view.record.returnDate)}</h3>
      <div className="table-wrap">
        <table className="records-table">
          <caption className="sr-only">Share capital from the register</caption>
          <thead>
            <tr>
              <th>Item</th>
              {SHARE_KINDS.map((k) => (
                <th className="num" key={k}>
                  {KIND_LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('Shares issued for cash', b.cash)}
            {row('Shares issued otherwise than cash', b.otherwise)}
            {row('Treasury shares', b.treasury)}
            {row('Amount fully paid (MYR)', b.fullyPaid, true)}
            {row('Amount paid on partly paid shares (MYR)', b.partlyPaid, true)}
          </tbody>
        </table>
      </div>
      <form
        className="form-stack grouped-form return-form"
        data-dirty={dirty ? 'true' : 'false'}
        onSubmit={(event) => {
          event.preventDefault();
          void save({ answers: { ...view.record.answers, sectionB: answers } });
        }}
      >
        <fieldset className="form-group">
          <legend>For this return only</legend>
          <div className="table-wrap">
            <table className="records-table answers-table">
              <caption className="sr-only">Section B answers</caption>
              <thead>
                <tr>
                  <th>Item</th>
                  {SHARE_KINDS.map((k) => (
                    <th key={k}>{KIND_LABEL[k]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {B_ANSWERS.map(([key, label]) => (
                  <tr key={key}>
                    <td>{label}</td>
                    {SHARE_KINDS.map((k) => (
                      <td key={k}>
                        <input
                          aria-label={`${label}, ${KIND_LABEL[k]}`}
                          inputMode="decimal"
                          value={answers[key][k] ?? ''}
                          onChange={(e) =>
                            setAnswers((a) => ({ ...a, [key]: { ...a[key], [k]: e.target.value } }))
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-stack">
            <label>
              Commission paid on shares or debentures since the last return (MYR)
              <input
                inputMode="decimal"
                value={answers.commission}
                onChange={(e) => setAnswers((a) => ({ ...a, commission: e.target.value }))}
              />
            </label>
            <label>
              Discount allowed on debentures since the last return (MYR)
              <input
                inputMode="decimal"
                value={answers.discount}
                onChange={(e) => setAnswers((a) => ({ ...a, discount: e.target.value }))}
              />
            </label>
            <label>
              Explanatory notes on shares (optional)
              <textarea
                maxLength={4000}
                value={answers.notesOnShares}
                onChange={(e) => setAnswers((a) => ({ ...a, notesOnShares: e.target.value }))}
              />
            </label>
            <label>
              Explanatory notes on debentures (optional)
              <textarea
                maxLength={4000}
                value={answers.notesOnDebentures}
                onChange={(e) => setAnswers((a) => ({ ...a, notesOnDebentures: e.target.value }))}
              />
            </label>
          </div>
        </fieldset>
        <ActionFeedback error={action.error} status={action.status} conflict={action.conflict} />
        <div className="actions">
          <button disabled={action.pending || !dirty}>Save</button>
        </div>
      </form>
    </>
  );
}
