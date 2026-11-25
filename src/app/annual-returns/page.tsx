'use client';
import { useState } from 'react';
import type { ReturnRow } from '@/server/ar1/returns';
import { Empty, Icon, PageHeader, useWorkspace } from '@/components/workspace';
import { getJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { TabPanel, Tabs } from '@/components/tabs';
import { ReturnTable } from '@/components/returns/return-list';

const TABS = ['Open', 'Downloaded'] as const;

export default function AnnualReturnsPage() {
  const { data } = useWorkspace();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Open');
  const [query, setQuery] = useState('');
  const load = useLoad(() => getJson<{ returns: ReturnRow[] }>('/api/annual-returns'), []);
  if (!data) return null;
  const q = query.trim().toUpperCase();
  const rows = (load.data?.returns ?? [])
    .filter((r) => (tab === 'Open' ? r.status !== 'Downloaded' : r.status === 'Downloaded'))
    .filter(
      (r) =>
        !q ||
        r.companyName.toUpperCase().includes(q) ||
        r.registrationNumber.toUpperCase().includes(q),
    );
  return (
    <>
      <PageHeader title="Annual returns" />
      <Tabs
        className="section-nav"
        activeClassName="active"
        ariaLabel="Annual returns"
        idPrefix="returns"
        controls="returns-panel"
        tabs={TABS.map((id) => ({ id, label: id }))}
        selected={tab}
        onChange={setTab}
      />
      <div className="toolbar">
        <label className="search">
          <span className="sr-only">Search annual returns</span>
          <Icon kind="search" />
          <input
            type="search"
            value={query}
            placeholder="Company or registration no."
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {load.data ? (
          <p className="results-line">
            {rows.length} {rows.length === 1 ? 'return' : 'returns'}
          </p>
        ) : null}
      </div>
      <TabPanel idPrefix="returns" tabKey={tab} id="returns-panel">
        <LoadState
          loading={load.loading && !load.data}
          error={load.error}
          reload={() => void load.reload()}
          label="annual returns"
        />
        {load.data ? (
          rows.length ? (
            <ReturnTable rows={rows} tab={tab} showCompany from="list" />
          ) : (
            <Empty>
              {q
                ? 'No matching returns'
                : tab === 'Open'
                  ? 'No open annual returns'
                  : 'No downloaded annual returns'}
              {q ? (
                <button type="button" onClick={() => setQuery('')}>
                  Clear filters
                </button>
              ) : null}
            </Empty>
          )
        ) : null}
      </TabPanel>
    </>
  );
}
