'use client';
import { formatDate } from '@/components/workspace';
import { addressText } from '../issue-fix';
import { Facts, type ReturnView } from '../step-parts';

export function SectionA({ view, onChange }: { view: ReturnView; onChange: () => void }) {
  const a = view.data.a;
  return (
    <>
      <div className="person-section-heading">
        <h3>Particulars as at {formatDate(view.record.returnDate)}</h3>
        <button type="button" className="text-button section-link" onClick={onChange}>
          Change in company record
        </button>
      </div>
      <Facts
        rows={[
          { label: 'Registered office', value: addressText(a.registered) },
          { label: 'Register of members kept at', value: addressText(a.membersRegister) },
          { label: 'Financial records kept at', value: addressText(a.financialRecords) },
          { label: 'Principal place of business', value: addressText(a.principal) },
          { label: 'Phone', value: a.phone, optional: true },
          { label: 'Email', value: a.email, optional: true },
          { label: 'Nature of business', value: a.natureOfBusiness, optional: true },
        ]}
      />
      <h3>MSIC codes</h3>
      {a.msic.length ? (
        <div className="table-wrap">
          <table className="records-table">
            <caption className="sr-only">MSIC codes</caption>
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {a.msic.map((m) => (
                <tr key={m.code}>
                  <td>{m.code}</td>
                  <td title={m.description}>{m.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No MSIC codes recorded</p>
      )}
      <h3>Branches</h3>
      {a.branches.length ? (
        <ul className="list-plain">
          {a.branches.map((b, i) => (
            <li key={i}>{addressText(b.address)}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No branches open on the return date</p>
      )}
    </>
  );
}
