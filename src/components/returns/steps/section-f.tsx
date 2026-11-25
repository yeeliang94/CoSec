'use client';
import { ALL_ANALYSES } from '@/domain/ar1/build';
import type { ReturnView } from '../step-parts';

export function SectionF({ view }: { view: ReturnView }) {
  const f = view.data.f;
  const total = Number(f.total) || 0;
  const pct = (n: string) => (total ? `${((Number(n) / total) * 100).toFixed(2)}%` : '');
  const blocker = view.issues.find((i) => i.section === 'F');
  return (
    <>
      <p className="muted">mTool works these out from section E; they are shown here to check.</p>
      <div className="table-wrap">
        <table className="records-table">
          <caption className="sr-only">Analysis of shareholdings</caption>
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Shares</th>
              <th className="num">Holding</th>
            </tr>
          </thead>
          <tbody>
            {ALL_ANALYSES.map((k) => (
              <tr key={k}>
                <td title={k}>{k}</td>
                <td className="num">{Number(f.byAnalysis[k] ?? 0).toLocaleString('en')}</td>
                <td className="num">{pct(f.byAnalysis[k] ?? '0')}</td>
              </tr>
            ))}
            {Number(f.unclassified) ? (
              <tr>
                <td className="danger-text">Not classified</td>
                <td className="num">{Number(f.unclassified).toLocaleString('en')}</td>
                <td className="num">{pct(f.unclassified)}</td>
              </tr>
            ) : null}
            <tr className="total-row">
              <td>Total</td>
              <td className="num">{total.toLocaleString('en')}</td>
              <td className="num">{total ? '100.00%' : ''}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {blocker ? null : (
        <p className="ok-line">
          Members and treasury shares agree with the shares issued in section B.
        </p>
      )}
    </>
  );
}
