'use client';
import Link from 'next/link';
import { ALL_ANALYSES } from '@/domain/ar1/build';
import { formatDate } from '@/components/workspace';
import { ActionFeedback } from '@/components/resolution/use-action';
import { ParticularsCell, useSave, type OnFix, type ReturnView } from '../step-parts';

export function SectionE({
  view,
  onFix,
  onSaved,
}: {
  view: ReturnView;
  onFix: OnFix;
  onSaved: () => Promise<void>;
}) {
  const e = view.data.e;
  const { action, save } = useSave(view, onSaved);
  const chooseJoint = (key: string, value: string) =>
    save({
      answers: {
        ...view.record.answers,
        jointAnalyses: { ...(view.record.answers.jointAnalyses ?? {}), [key]: value },
      },
    });
  return (
    <>
      <section className="section">
        <div className="person-section-heading">
          <h3>Members at {formatDate(view.record.returnDate)}</h3>
          <Link className="section-link" href={`/companies/${view.company.id}?tab=shares`}>
            Open share register
          </Link>
        </div>
        {e.members.length ? (
          <div className="table-wrap">
            <table className="records-table">
              <caption className="sr-only">Members</caption>
              <thead>
                <tr>
                  <th>Ref.</th>
                  <th>Name</th>
                  <th>Type of member</th>
                  <th className="num">Shares</th>
                  <th>Analysis</th>
                  <th>Particulars</th>
                </tr>
              </thead>
              <tbody>
                {e.members.map((m) => (
                  <tr key={m.reference}>
                    <td>{m.reference}</td>
                    <td title={m.name}>{m.name}</td>
                    <td title={m.memberType}>{m.memberType}</td>
                    <td className="num">{Number(m.shares).toLocaleString('en')}</td>
                    <td title={m.analysis}>
                      {m.holderKey ? (
                        <select
                          aria-label={`Analysis for joint holding ${m.reference}`}
                          value={view.record.answers.jointAnalyses?.[m.holderKey] ?? m.analysis}
                          disabled={action.pending}
                          onChange={(event) => void chooseJoint(m.holderKey!, event.target.value)}
                        >
                          <option value="">Choose…</option>
                          {ALL_ANALYSES.map((a) => (
                            <option key={a}>{a}</option>
                          ))}
                        </select>
                      ) : (
                        m.analysis
                      )}
                    </td>
                    <ParticularsCell view={view} personIds={m.partyIds} onFix={onFix} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No members on the return date</p>
        )}
        <ActionFeedback error={action.error} status={action.status} conflict={action.conflict} />
      </section>
      {e.subclassification.length ? (
        <section className="section">
          <h3>Joint holders and members held in trust</h3>
          <div className="table-wrap">
            <table className="records-table">
              <caption className="sr-only">Sub-classification</caption>
              <thead>
                <tr>
                  <th>Ref.</th>
                  <th>Type</th>
                  <th>Name</th>
                  <th>ID number</th>
                  <th>Nationality</th>
                </tr>
              </thead>
              <tbody>
                {e.subclassification.map((s, i) => (
                  <tr key={i}>
                    <td>{s.reference}</td>
                    <td>{s.type}</td>
                    <td title={s.name}>{s.name}</td>
                    <td>{s.idNumber}</td>
                    <td>{s.nationality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
