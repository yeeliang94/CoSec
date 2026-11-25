'use client';
import type { ReturnRow } from '@/server/ar1/returns';
import { getJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { ReturnTable } from './return-list';

/** A company's annual returns: the next one due, then started and downloaded ones. */
export function CompanyReturns({ companyId }: { companyId: string }) {
  const load = useLoad(
    () => getJson<{ returns: ReturnRow[] }>(`/api/annual-returns?companyId=${companyId}`),
    [companyId],
  );
  const rows = load.data?.returns ?? [];
  const open = rows.filter((r) => r.status !== 'Downloaded');
  const done = rows.filter((r) => r.status === 'Downloaded');
  return (
    <>
      <LoadState
        loading={load.loading && !load.data}
        error={load.error}
        reload={() => void load.reload()}
        label="annual returns"
      />
      {load.data ? (
        <>
          <section className="section">
            <h3>Open</h3>
            {open.length ? (
              <ReturnTable rows={open} tab="Open" showCompany={false} from="company" />
            ) : (
              <p className="muted">No open annual returns</p>
            )}
          </section>
          {done.length ? (
            <section className="section">
              <h3>Downloaded</h3>
              <ReturnTable rows={done} tab="Downloaded" showCompany={false} from="company" />
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}
