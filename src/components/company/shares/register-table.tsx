'use client';
import { SHARE_ENTRY_LABELS, type ShareClass, type ShareEntry } from '@/domain/ar1/shares';
import { formatDate } from '@/components/workspace';
import { RowMenu } from '@/components/menu';
import { holderName } from './names';
import { entryStatus, reviewItems } from './review';

const count = (n: bigint) => n.toLocaleString('en');

/** The share register, one entry per row, with each entry's review controls. */
export function RegisterTable({
  entries,
  classes,
  names,
  canEdit,
  actorId,
  onAct,
  onCorrect,
}: {
  entries: ShareEntry[];
  classes: ShareClass[];
  names: Map<string, string>;
  canEdit: boolean;
  actorId: string;
  onAct: (entry: ShareEntry, act: 'post' | 'withdraw') => void;
  onCorrect: (entry: ShareEntry) => void;
}) {
  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? '';
  return (
    <div className="table-wrap">
      <table className="records-table share-register-table">
        <caption className="sr-only">Share register entries</caption>
        <thead>
          <tr>
            <th className="col-date">Date</th>
            <th>Entry</th>
            <th>Class</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Shares</th>
            <th>Status</th>
            <th className="col-action">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries
            .filter((e) => e.status !== 'Withdrawn')
            .map((e) => {
              const from =
                e.kind === 'transfer' || e.kind === 'buyback' ? holderName(e.from, names) : '';
              const to = e.kind === 'buyback' ? 'Treasury' : holderName(e.to, names);
              const label =
                (e.voids ? 'Removal of ' : e.predecessorId ? 'Correction: ' : '') +
                SHARE_ENTRY_LABELS[e.kind];
              const items = reviewItems(e, {
                canEdit,
                actorId,
                onPost: () => onAct(e, 'post'),
                onWithdraw: () => onAct(e, 'withdraw'),
                onCorrect: () => onCorrect(e),
              });
              return (
                <tr key={e.id}>
                  <td>{formatDate(e.date)}</td>
                  <td title={label}>{label}</td>
                  <td title={className(e.classId)}>{className(e.classId)}</td>
                  <td title={from}>{from}</td>
                  <td title={to}>{to}</td>
                  <td className="num">{count(BigInt(e.shares))}</td>
                  <td>{entryStatus(e, actorId)}</td>
                  <td className="col-action">
                    {items.length ? <RowMenu name={label} items={items} /> : null}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
