'use client';
import { Suspense, use, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useWorkspace,
  currentDate,
  Empty,
  BackLink,
  useDocumentTitle,
  Icon,
} from '@/components/workspace';
import { canLeaveEditing } from '@/components/edit-guard';
import { ActionForm } from '@/components/forms';
import { CompanyRelationships } from '@/components/resolution/relationships';
import { NewResolution } from '@/components/resolution/new-resolution';
import {
  CompanyDocuments,
  CompanyHistory,
  CompanyResolutions,
} from '@/components/company/record-panels';
import { CompanyResolutionSettings } from '@/components/company/resolution-settings';
import { TabPanel, Tabs } from '@/components/tabs';
import { CompanyShares } from '@/components/company/shares';
import { CompanyCharges } from '@/components/company/charges';
import { CompanyReturns } from '@/components/returns/company-returns';
import { nextReturn } from '@/domain/ar1/returns';
import { dueText } from '@/components/returns/return-list';
import {
  BranchesEdit,
  BranchList,
  CompanyDetails,
  CompanyParticularsEdit,
} from '@/components/company/particulars';
import { getJson } from '@/components/resolution/api';
import { useLoad } from '@/components/resolution/use-load';
import { branchesAt } from '@/domain/ar1/company';
import type { CompanyProfile } from '@/domain/resolution/model';

const TABS = [
  ['overview', 'Overview'],
  ['people', 'People'],
  ['shares', 'Shares'],
  ['charges', 'Charges'],
  ['returns', 'Annual returns'],
  ['resolutions', 'Resolutions'],
  ['documents', 'Documents'],
  ['settings', 'Resolution settings'],
  ['history', 'History'],
] as const;
type Tab = (typeof TABS)[number][0];

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <CompanyRecord id={id} />
    </Suspense>
  );
}

function CompanyRecord({ id }: { id: string }) {
  const { data } = useWorkspace();
  const router = useRouter();
  useDocumentTitle(data?.companies.find((c) => c.id === id)?.name);
  // The tab lives in the address so a link, a reload and Back all return to it.
  const tabParam = useSearchParams().get('tab');
  const tab: Tab = TABS.find(([key]) => key === tabParam)?.[0] ?? 'overview';
  const [asAt, setAsAt] = useState(currentDate());
  const [creating, setCreating] = useState(false);
  const [panel, setPanel] = useState<'particulars' | 'branches' | null>(null);
  const profile = useLoad(() => getJson<CompanyProfile>(`/api/companies/${id}/profile`), [id]);
  if (!data) return null;
  const canEditParticulars = data.actor.capabilities.some(
    (c) => c === 'confirm_record' || c === 'manage_people',
  );
  const company = data.companies.find((c) => c.id === id);
  if (!company) return <Empty>Company unavailable</Empty>;
  const choose = async (next: Tab) => {
    if (next === tab || !(await canLeaveEditing())) return;
    router.push(`/companies/${id}?tab=${next}`, { scroll: false });
  };
  return (
    <>
      <BackLink href="/companies" label="Companies" />
      <div className="page-header">
        <div>
          <h1 className="company-title">{company.name}</h1>
          <p className="record-number">{company.registrationNumber}</p>
        </div>
        {data.actor.capabilities.some((c) => c === 'generate_documents' || c === 'prepare_job') ? (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon kind="plus" />
            New resolution
          </button>
        ) : null}
      </div>
      {creating ? <NewResolution companyId={id} onCancel={() => setCreating(false)} /> : null}
      {company.verification === 'Unverified' ? (
        <div className="warning">
          Opening company information is unverified.
          {data.actor.capabilities.includes('confirm_record') ? (
            <details className="disclosure">
              <summary>Review opening record</summary>
              <ActionForm
                url={'/api/companies/' + company.id}
                action="review_opening"
                label="Confirm opening record review"
                primary
                confirmation={
                  'Confirm review of opening company record revision ' +
                  company.revision +
                  '? The source and decision will be retained.'
                }
                extra={{ expectedRevision: company.revision, confirmed: true }}
                fields={[
                  {
                    name: 'sourceEvidenceId',
                    label: 'Opening source evidence',
                    type: 'select',
                    required: true,
                    options: data.documents
                      .filter((d) => d.companyId === company.id && d.classification === 'General')
                      .map((d) => ({ value: d.id, label: d.title })),
                  },
                  { name: 'basis', label: 'Review basis', type: 'textarea', required: true },
                ]}
              />
            </details>
          ) : null}
        </div>
      ) : null}
      <Tabs
        className="section-nav record-tabs"
        activeClassName="active"
        ariaLabel="Company sections"
        idPrefix="company"
        controls="company-panel"
        tabs={TABS.map(([id, label]) => ({ id, label }))}
        selected={tab}
        onChange={(next) => void choose(next)}
      />
      <div className="split record-split company-split">
        <TabPanel
          className="split-main record-panel"
          idPrefix="company"
          tabKey={tab}
          id="company-panel"
        >
          {tab === 'overview' ? (
            <section className="section">
              <div className="person-section-heading">
                <h3>Branches</h3>
                {canEditParticulars && profile.data ? (
                  <button
                    type="button"
                    className="text-button section-link"
                    onClick={() => setPanel('branches')}
                  >
                    Change branches
                  </button>
                ) : null}
              </div>
              <BranchList branches={branchesAt(profile.data?.branches, currentDate())} />
            </section>
          ) : tab === 'returns' ? (
            <CompanyReturns companyId={id} />
          ) : tab === 'charges' ? (
            <CompanyCharges companyId={id} />
          ) : tab === 'shares' ? (
            <CompanyShares companyId={id} />
          ) : tab === 'people' ? (
            <CompanyRelationships companyId={id} asAt={asAt} onAsAtChange={setAsAt} />
          ) : tab === 'resolutions' ? (
            <CompanyResolutions companyId={id} companyName={company.name} />
          ) : tab === 'documents' ? (
            <CompanyDocuments companyId={id} />
          ) : tab === 'settings' ? (
            <CompanyResolutionSettings companyId={id} />
          ) : (
            <CompanyHistory companyId={id} />
          )}
        </TabPanel>
        <CompanyDetails
          company={company}
          profile={profile.data ?? undefined}
          canEdit={canEditParticulars && Boolean(profile.data)}
          onEdit={() => setPanel('particulars')}
          nextReturn={
            company.incorporationDate
              ? dueText(
                  nextReturn(company.incorporationDate, currentDate())!.dueDate,
                  currentDate(),
                )
              : null
          }
        />
      </div>
      {panel === 'particulars' && profile.data ? (
        <CompanyParticularsEdit
          companyId={id}
          profile={profile.data}
          onSaved={profile.reload}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === 'branches' && profile.data ? (
        <BranchesEdit
          companyId={id}
          profile={profile.data}
          onSaved={profile.reload}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </>
  );
}
