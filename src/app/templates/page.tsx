'use client';
import { useEffect, useState } from 'react';
import { type OutputType } from '@/domain/resolution/model';
import { Icon, PageHeader, useWorkspace } from '@/components/workspace';
import {
  getJson,
  type AssemblyWithVersions,
  type ClauseWithVersions,
} from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { canLeaveEditing } from '@/components/edit-guard';
import { OutputTypes } from '@/components/template-library/output-types';
import { AssemblyLibrary } from '@/components/template-library/assemblies';
import { ClauseLibrary } from '@/components/template-library/clauses';
import { TabPanel, Tabs } from '@/components/tabs';

type Tab = 'clauses' | 'assemblies' | 'outputs';
const tabLabels: Record<Tab, string> = {
  clauses: 'Wording',
  assemblies: 'Layouts',
  outputs: 'Document types',
};
const newLabels: Record<Tab, string> = {
  clauses: 'New wording',
  assemblies: 'New layout',
  outputs: 'New document type',
};
const tabParams: Record<Tab, string> = {
  clauses: 'wording',
  assemblies: 'layouts',
  outputs: 'document-types',
};
function tabFromLocation(): Tab | null {
  const param = new URLSearchParams(window.location.search).get('tab');
  const fromParam = (Object.keys(tabParams) as Tab[]).find((key) => tabParams[key] === param);
  if (fromParam) return fromParam;
  // Older links used a hash.
  const hash = window.location.hash.slice(1);
  return hash === 'assemblies' || hash === 'outputs' ? hash : null;
}

export default function TemplatesPage() {
  const { data } = useWorkspace();
  const [tab, setTab] = useState<Tab>('clauses');
  const [creating, setCreating] = useState(false);
  const load = useLoad(async () => {
    const [clauses, assemblies, types] = await Promise.all([
      getJson<{ clauses: ClauseWithVersions[] }>('/api/clause-templates?includeHidden=true'),
      getJson<{ assemblies: AssemblyWithVersions[] }>(
        '/api/resolution-assemblies?includeHidden=true',
      ),
      getJson<{ outputTypes: OutputType[] }>('/api/output-types'),
    ]);
    return {
      clauses: clauses.clauses,
      assemblies: assemblies.assemblies,
      outputTypes: types.outputTypes,
    };
  }, []);
  useEffect(() => {
    const initial = tabFromLocation();
    if (initial) setTab(initial);
  }, []);
  if (!data) return null;
  const canManage = data.actor.capabilities.includes('manage_templates');
  const choose = async (next: Tab) => {
    if (next === tab || !(await canLeaveEditing())) return;
    setTab(next);
    setCreating(false);
    const url = new URL(window.location.href);
    url.hash = '';
    if (next === 'clauses') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tabParams[next]);
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  };
  const tabs: Tab[] = canManage ? ['clauses', 'assemblies', 'outputs'] : ['clauses', 'assemblies'];
  return (
    <>
      <PageHeader title="Templates">
        {canManage ? (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon kind="plus" />
            {newLabels[tab]}
          </button>
        ) : null}
      </PageHeader>
      <Tabs
        className="filters"
        tabClassName="filter"
        activeClassName="active"
        ariaLabel="Template sections"
        idPrefix="templates"
        controls="templates-panel"
        tabs={tabs.map((id) => ({ id, label: tabLabels[id] }))}
        selected={tab}
        onChange={(next) => void choose(next)}
      />
      <TabPanel idPrefix="templates" tabKey={tab} id="templates-panel">
        <LoadState
          loading={load.loading && !load.data}
          error={load.error}
          reload={() => void load.reload()}
          label="templates"
        />
        {load.data ? (
          tab === 'clauses' ? (
            <ClauseLibrary
              clauses={load.data.clauses}
              canManage={canManage}
              creating={creating}
              onCreating={setCreating}
              reload={load.reload}
            />
          ) : tab === 'assemblies' ? (
            <AssemblyLibrary
              assemblies={load.data.assemblies}
              outputTypes={load.data.outputTypes}
              canManage={canManage}
              creating={creating}
              onCreating={setCreating}
              reload={load.reload}
            />
          ) : (
            <OutputTypes
              types={load.data.outputTypes}
              reload={load.reload}
              creating={creating}
              onCreating={setCreating}
            />
          )
        ) : null}
      </TabPanel>
    </>
  );
}
