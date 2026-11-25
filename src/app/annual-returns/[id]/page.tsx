'use client';
import { Suspense, use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ReturnSection } from '@/domain/ar1/build';
import { BackLink, Icon, useDocumentTitle, useWorkspace } from '@/components/workspace';
import { getJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { canLeaveEditing } from '@/components/edit-guard';
import { WarningLine } from '@/components/warning-line';
import { issueHeadline } from '@/components/returns/issue-fix';
import { StepIssues, type FixTarget, type ReturnView } from '@/components/returns/step-parts';
import { FixPanel } from '@/components/returns/fix-panel';
import { FilingStep } from '@/components/returns/steps/filing';
import { SectionA } from '@/components/returns/steps/section-a';
import { SectionB } from '@/components/returns/steps/section-b';
import { SectionC } from '@/components/returns/steps/section-c';
import { SectionD } from '@/components/returns/steps/section-d';
import { SectionE } from '@/components/returns/steps/section-e';
import { SectionF } from '@/components/returns/steps/section-f';
import { SectionG } from '@/components/returns/steps/section-g';
import { CheckStep } from '@/components/returns/steps/check';

const STEPS: [ReturnSection | 'Check', string][] = [
  ['Filing', 'Filing information'],
  ['A', 'A Company'],
  ['B', 'B Share capital'],
  ['C', 'C Charges'],
  ['D', 'D Officers'],
  ['E', 'E Members'],
  ['F', 'F Shareholding analysis'],
  ['G', 'G Certificate'],
  ['Check', 'Check and download'],
];
type Step = (typeof STEPS)[number][0];
const ANSWER_STEP: Record<string, Step> = {
  sharesQuoted: 'Filing',
  rectificationDeclaration: 'Filing',
  courtOrderReference: 'Filing',
};

export default function AnnualReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <ReturnWorkspace id={id} />
    </Suspense>
  );
}

function ReturnWorkspace({ id }: { id: string }) {
  const { data: workspace } = useWorkspace();
  const from = useSearchParams().get('from');
  const load = useLoad(() => getJson<ReturnView>(`/api/annual-returns/${id}`), [id]);
  const [step, setStep] = useState<Step>('Filing');
  const [fix, setFix] = useState<FixTarget | null>(null);
  const view = load.data;
  useDocumentTitle(view ? `Annual return ${view.record.calendarYear}, ${view.company.name}` : null);
  if (!workspace) return null;
  // The page context lives in the back link; the header holds the title only.
  const fromCompany = from === 'company' && view;
  const back = fromCompany
    ? {
        href: `/companies/${view.company.id}?tab=returns`,
        label: `${view.company.name} annual returns`,
      }
    : { href: '/annual-returns', label: 'Annual returns' };
  const issues = view?.issues ?? [];
  const headline = issueHeadline(issues);
  const missingIn = (s: Step) => issues.some((i) => i.section === s);
  const index = STEPS.findIndex(([key]) => key === step);
  const go = async (next: Step) => {
    if (next === step || !(await canLeaveEditing())) return;
    setStep(next);
  };
  const openFix = (target: FixTarget) => {
    if (target.kind === 'answer')
      void go(target.field.startsWith('joint:') ? 'E' : (ANSWER_STEP[target.field] ?? 'G'));
    else setFix(target);
  };
  return (
    <div className="return-page">
      <BackLink href={back.href} label={back.label} />
      <LoadState
        loading={load.loading && !load.data}
        error={load.error}
        reload={() => void load.reload()}
        label="annual return"
      />
      {view ? (
        <>
          <div className="page-header">
            <h1 className="company-title">
              {fromCompany
                ? `Annual return ${view.record.calendarYear}`
                : `Annual return ${view.record.calendarYear}, ${view.company.name}`}
            </h1>
          </div>
          {headline ? (
            <WarningLine
              blocking={headline.blocking}
              action={
                <button
                  type="button"
                  className="text-button section-link"
                  onClick={() => void go('Check')}
                >
                  Review
                </button>
              }
            >
              {headline.text}
            </WarningLine>
          ) : null}
          <div className="return-layout">
            <nav className="return-steps" aria-label="Steps">
              <ol>
                {STEPS.map(([key, label]) => (
                  <li key={key}>
                    <button
                      type="button"
                      className={step === key ? 'active' : undefined}
                      aria-current={step === key ? 'step' : undefined}
                      onClick={() => void go(key)}
                    >
                      {label}
                      {key !== 'Check' && missingIn(key) ? (
                        <span role="img" aria-label="Something missing" className="step-warning">
                          <Icon kind="warning" />
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <section className="return-body" aria-label={STEPS[index][1]}>
              <h2>{STEPS[index][1]}</h2>
              <StepIssues
                issues={issues.filter((i) => i.section === step)}
                companyId={view.company.id}
                onFix={openFix}
              />
              {step === 'Filing' ? (
                <FilingStep view={view} onSaved={load.reload} />
              ) : step === 'A' ? (
                <SectionA view={view} onChange={() => setFix({ kind: 'company', keys: [] })} />
              ) : step === 'B' ? (
                <SectionB view={view} onSaved={load.reload} />
              ) : step === 'C' ? (
                <SectionC view={view} onSaved={load.reload} />
              ) : step === 'D' ? (
                <SectionD view={view} onFix={openFix} />
              ) : step === 'E' ? (
                <SectionE view={view} onFix={openFix} onSaved={load.reload} />
              ) : step === 'F' ? (
                <SectionF view={view} />
              ) : step === 'G' ? (
                <SectionG view={view} onSaved={load.reload} />
              ) : (
                <CheckStep view={view} onFix={openFix} onChanged={load.reload} />
              )}
              <div className="return-bar">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => void go(STEPS[index - 1][0])}
                >
                  Back
                </button>
                {index < STEPS.length - 1 ? (
                  <button type="button" onClick={() => void go(STEPS[index + 1][0])}>
                    Continue
                  </button>
                ) : null}
              </div>
            </section>
          </div>
          {fix ? (
            <FixPanel view={view} target={fix} onClose={() => setFix(null)} onSaved={load.reload} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
