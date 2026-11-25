'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { ResolutionCase } from '@/domain/resolution/model';
import { caseStatus } from '@/domain/resolution/cases';
import { useWorkspace, PageHeader, Icon, Empty } from '@/components/workspace';
import { NewCompany } from '@/components/new-company';
import { getJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';

export default function Companies() {
  const { data, refresh } = useWorkspace();
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState('');
  const [adding, setAdding] = useState(false);
  // One call for every visible case, newest first; rows read their own from the groups below.
  const cases = useLoad(() => getJson<{ cases: ResolutionCase[] }>('/api/resolution-cases'), []);
  if (!data) return null;
  const openByCompany = new Map<string, ResolutionCase[]>();
  for (const item of cases.data?.cases ?? []) {
    if (item.state !== 'Open') continue;
    openByCompany.set(item.companyId, [...(openByCompany.get(item.companyId) ?? []), item]);
  }
  const userName = (id: string) => data.users.find((u) => u.id === id)?.name || id;
  const term = query.trim().toLowerCase();
  const companies = data.companies.filter(
    (c) =>
      (!opening || c.verification === opening) &&
      [c.name, c.registrationNumber].join(' ').toLowerCase().includes(term),
  );
  return (
    <>
      <PageHeader title="Companies">
        <div className="header-actions">
          <Link className="section-link" href="/companies/imports">
            Import records
          </Link>
          {data.actor.capabilities.includes('prepare_job') ? (
            <button type="button" className="primary" onClick={() => setAdding(true)}>
              <Icon kind="plus" />
              New company
            </button>
          ) : null}
        </div>
      </PageHeader>
      {adding ? (
        <NewCompany
          onClose={() => setAdding(false)}
          onSaved={async () => {
            await refresh();
            setAdding(false);
          }}
        />
      ) : null}
      <div className="toolbar">
        <label className="search">
          <span className="sr-only">Search companies</span>
          <Icon kind="search" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or registration number"
          />
        </label>
        <label>
          <span className="sr-only">Opening record</span>
          <select value={opening} onChange={(e) => setOpening(e.target.value)}>
            <option value="">All opening records</option>
            <option value="Unverified">Unverified</option>
            <option value="Reviewed">Reviewed</option>
          </select>
        </label>
      </div>
      <LoadState
        loading={false}
        error={cases.error}
        reload={() => void cases.reload()}
        label="open resolutions"
      />
      {companies.length ? (
        <div className="table-wrap">
          <table className="records-table companies-table">
            <caption className="sr-only">Accessible companies</caption>
            <thead>
              <tr>
                <th>Company</th>
                <th>Registration no.</th>
                <th>Engagement</th>
                <th>Opening record</th>
                <th>Open resolutions</th>
                <th>Latest resolution status</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => {
                const open = openByCompany.get(company.id) ?? [];
                const latest = open[0] ? caseStatus(open[0], userName) : '';
                return (
                  <tr key={company.id}>
                    <td title={company.name}>
                      <Link href={'/companies/' + company.id}>{company.name}</Link>
                    </td>
                    <td className="tabular">{company.registrationNumber}</td>
                    <td>{company.engagementStatus}</td>
                    <td>{company.verification}</td>
                    <td className="tabular">{cases.data ? open.length : ''}</td>
                    <td title={latest}>{latest}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : term || opening ? (
        <Empty>
          No matching companies
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpening('');
            }}
          >
            Clear filters
          </button>
        </Empty>
      ) : (
        <Empty>No companies yet</Empty>
      )}
    </>
  );
}
