'use client';
import { addressText } from '../issue-fix';
import { ParticularsCell, type OnFix, type ReturnView } from '../step-parts';

export function SectionD({ view, onFix }: { view: ReturnView; onFix: OnFix }) {
  const d = view.data.d;
  const table = (
    title: string,
    director: boolean,
    rows: {
      personId: string;
      name: string;
      idNumber: string;
      nationality: string;
      designation?: string;
    }[],
  ) => (
    <section className="section" key={title}>
      <h3>{title}</h3>
      {rows.length ? (
        <div className="table-wrap">
          <table className="records-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th>Name</th>
                {director ? <th>Designation</th> : null}
                <th>ID number</th>
                <th>Nationality</th>
                <th>Particulars</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.personId}>
                  <td title={r.name}>{r.name}</td>
                  {director ? <td>{r.designation}</td> : null}
                  <td>{r.idNumber}</td>
                  <td>{r.nationality}</td>
                  <ParticularsCell view={view} personIds={[r.personId]} onFix={onFix} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">None in office on the return date</p>
      )}
    </section>
  );
  return (
    <>
      {table('Directors', true, d.directors)}
      {table('Managers', false, d.managers)}
      {table('Secretaries', false, d.secretaries)}
      <section className="section">
        <h3>Auditors</h3>
        {d.auditors.length ? (
          <div className="table-wrap">
            <table className="records-table">
              <caption className="sr-only">Auditors</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Audit firm no.</th>
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {d.auditors.map((a) => (
                  <tr key={a.personId}>
                    <td title={a.name}>{a.name}</td>
                    <td>{a.firmNumber}</td>
                    <td title={addressText(a.address)}>{addressText(a.address)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No auditor recorded</p>
        )}
      </section>
    </>
  );
}
