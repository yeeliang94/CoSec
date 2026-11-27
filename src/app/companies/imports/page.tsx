'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BackLink, Empty, formatDay, Icon, PageHeader, useWorkspace } from '@/components/workspace';
import { WarningLine } from '@/components/warning-line';
import { getJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { NewImport } from '@/components/imports/new-import';
import type { ImportList, ImportListItem } from '@/components/imports/types';

function statusText(item: ImportListItem) {
  if (item.status === 'Uploading') return 'Uploading files';
  if (item.status === 'Finished') return 'Finished';
  if (item.status === 'Paused') return 'Paused';
  if (item.waitingOnYou) return `${item.waitingOnYou} ready for you`;
  return 'Reading';
}

export default function Imports() {
  const { data } = useWorkspace();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => getJson<ImportList>('/api/imports'), []);
  if (!data) return null;
  const canPrepare = data.actor.capabilities.includes('prepare_job');
  const off = list.data?.gatewayProblem ?? null;
  const items = list.data?.imports ?? [];
  return (
    <>
      <BackLink href="/companies" label="Companies" />
      <PageHeader title="Imports">
        <div className="header-actions">
          {canPrepare && list.data && !off ? (
            <button type="button" className="primary" onClick={() => setAdding(true)}>
              <Icon kind="plus" />
              New import
            </button>
          ) : null}
        </div>
      </PageHeader>
      {off ? (
        <WarningLine
          action={
            data.actor.capabilities.includes('manage_catalogue') ? (
              <Link className="section-link" href="/settings#bulk-import">
                Settings
              </Link>
            ) : null
          }
        >
          {off}
        </WarningLine>
      ) : null}
      {adding ? (
        <NewImport
          onClose={() => setAdding(false)}
          onStarted={(id) => router.push(`/companies/imports/${id}`)}
        />
      ) : null}
      <LoadState
        loading={list.loading}
        error={list.error}
        reload={() => void list.reload()}
        label="imports"
      />
      {items.length ? (
        <div className="table-wrap">
          <table className="records-table import-table">
            <caption className="sr-only">Imports</caption>
            <colgroup>
              <col style={{ width: '38%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '12%' }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>Import</th>
                <th>Started</th>
                <th className="num">Companies</th>
                <th className="num">Applied</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td title={item.name}>
                    <Link href={`/companies/imports/${item.id}`}>{item.name}</Link>
                  </td>
                  <td>{formatDay(item.createdAt)}</td>
                  <td className="num">{item.companies}</td>
                  <td className="num">{item.applied}</td>
                  <td>{statusText(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : list.data ? (
        <Empty>
          No imports yet
          {canPrepare && !off ? (
            <button type="button" onClick={() => setAdding(true)}>
              New import
            </button>
          ) : null}
        </Empty>
      ) : null}
    </>
  );
}
