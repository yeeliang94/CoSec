'use client';
import Link from 'next/link';
import { useState } from 'react';
import { daysBetween, dueGroup } from '@/domain/ar1/returns';
import type { ReturnRow } from '@/server/ar1/returns';
import { currentDate, formatDate, useWorkspace } from '@/components/workspace';
import { StartReturn } from './start-return';

const GROUPS = ['Overdue', 'Due this week', 'Later'] as const;

export function dueText(dueDate: string, today: string) {
  const days = daysBetween(today, dueDate);
  if (days >= 0) return formatDate(dueDate);
  return `${formatDate(dueDate)} (${-days} ${-days === 1 ? 'day' : 'days'} overdue)`;
}

/**
 * Returns as a table. Open returns are grouped by due date; downloaded ones are listed by the date
 * of their latest download. `showCompany` drops the company columns on a company's own record.
 */
export function ReturnTable({
  rows,
  tab,
  showCompany,
  from,
}: {
  rows: ReturnRow[];
  tab: 'Open' | 'Downloaded';
  showCompany: boolean;
  from: 'list' | 'company';
}) {
  const { data } = useWorkspace();
  const [starting, setStarting] = useState<ReturnRow | null>(null);
  const today = currentDate();
  const userName = (id: string | null) => data?.users.find((u) => u.id === id)?.name ?? '';
  const canStart = Boolean(
    data?.actor.capabilities.some((c) => c === 'prepare_job' || c === 'generate_documents'),
  );
  const table = (list: ReturnRow[], caption: string) => (
    <div className="table-wrap">
      <table className="records-table returns-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {showCompany ? <th>Company</th> : null}
            {showCompany ? <th>Registration no.</th> : null}
            <th>Return</th>
            <th>Status</th>
            <th className="col-date">{tab === 'Open' ? 'Due' : 'Downloaded'}</th>
            <th>Prepared by</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const title = `Annual return ${r.calendarYear}`;
            const overdue = tab === 'Open' && r.dueDate < today;
            return (
              <tr key={`${r.companyId}-${r.returnDate}`}>
                {showCompany ? (
                  <td title={r.companyName}>
                    <Link href={`/companies/${r.companyId}?tab=returns`}>{r.companyName}</Link>
                  </td>
                ) : null}
                {showCompany ? <td>{r.registrationNumber}</td> : null}
                <td>
                  {r.returnId ? (
                    <Link href={`/annual-returns/${r.returnId}?from=${from}`}>{title}</Link>
                  ) : canStart ? (
                    <button type="button" className="text-button" onClick={() => setStarting(r)}>
                      {title}
                    </button>
                  ) : (
                    title
                  )}
                </td>
                <td>{r.status}</td>
                <td className={overdue ? 'danger-text' : undefined}>
                  {tab === 'Open'
                    ? dueText(r.dueDate, today)
                    : r.downloadedAt
                      ? formatDate(r.downloadedAt.slice(0, 10))
                      : ''}
                </td>
                <td>{userName(r.preparedBy)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      {tab === 'Open'
        ? GROUPS.map((group) => {
            const list = rows.filter((r) => dueGroup(r.dueDate, today) === group);
            if (!list.length) return null;
            return (
              <section className="resolution-group" key={group} aria-label={group}>
                <h2>{group}</h2>
                {table(list, group)}
              </section>
            );
          })
        : table(rows, 'Downloaded returns')}
      {starting ? (
        <StartReturn
          companyId={starting.companyId}
          calendarYear={starting.calendarYear}
          from={from}
          onClose={() => setStarting(null)}
        />
      ) : null}
    </>
  );
}
