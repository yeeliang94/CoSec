'use client';
import { useState } from 'react';
import { BO_EXEMPT } from '@/domain/ar1/returns';
import { BO_EXEMPT_CATEGORIES, BO_STATUSES, NOMINEE_STATUSES } from '@/domain/ar1/mtool-lists';
import { ActionFeedback } from '@/components/resolution/use-action';
import { useSave, type ReturnView } from '../step-parts';

export function SectionG({ view, onSaved }: { view: ReturnView; onSaved: () => Promise<void> }) {
  const { action, save } = useSave(view, onSaved);
  const [cert, setCert] = useState(view.record.answers.certificate);
  const dirty = JSON.stringify(cert) !== JSON.stringify(view.record.answers.certificate);
  const isPublic = view.data.filingInfo.status === 'Public company';
  const since = view.record.firstReturn ? 'since incorporation' : 'since the last return';
  const yesNo = (
    key: 'unclaimedMoneys' | 'noPublicInvitation' | 'overFifty' | 'overFiveHundred',
    label: string,
  ) => (
    <label key={key}>
      {label}
      <select
        value={cert[key] ?? ''}
        onChange={(e) =>
          setCert((c) => ({ ...c, [key]: (e.target.value || null) as 'Yes' | 'No' | null }))
        }
      >
        <option value="">Select…</option>
        <option>Yes</option>
        <option>No</option>
      </select>
    </label>
  );
  const choose = (
    key: 'boStatus' | 'boExemptCategory' | 'nomineeStatus',
    label: string,
    options: readonly string[],
    placeholder = 'Select…',
  ) => (
    <label key={key}>
      {label}
      <select
        value={cert[key] ?? ''}
        onChange={(e) => setCert((c) => ({ ...c, [key]: e.target.value || null }))}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="form-stack return-form"
      data-dirty={dirty ? 'true' : 'false'}
      onSubmit={(event) => {
        event.preventDefault();
        void save({ answers: { ...view.record.answers, certificate: cert } });
      }}
    >
      {yesNo(
        'unclaimedMoneys',
        '(a) The provisions of the Unclaimed Moneys Act 1965 have been complied with',
      )}
      <div className="fixed-answer">
        <span>(b) Transfers registered {since}</span>
        <span>{view.data.g.transfersRegistered}</span>
      </div>
      {yesNo(
        'noPublicInvitation',
        `(c) No invitation to the public to subscribe for shares or debentures ${since}`,
      )}
      {!isPublic
        ? yesNo('overFifty', '(d) Members above fifty are employees or former employees only')
        : null}
      {isPublic
        ? yesNo(
            'overFiveHundred',
            '(e) Inspection facilities for a public company with more than 500 members',
          )
        : null}
      {choose('boStatus', '(f) Status relating to beneficial owners', BO_STATUSES)}
      {cert.boStatus === BO_EXEMPT
        ? choose(
            'boExemptCategory',
            '(g) Category exempted from beneficial owner reporting',
            BO_EXEMPT_CATEGORIES,
          )
        : null}
      {choose(
        'nomineeStatus',
        '(h) Status relating to directors',
        NOMINEE_STATUSES,
        view.data.g.nomineeStatus
          ? `From the directors' records: ${view.data.g.nomineeStatus}`
          : 'Select…',
      )}
      <ActionFeedback error={action.error} status={action.status} conflict={action.conflict} />
      <div className="actions">
        <button disabled={action.pending || !dirty}>Save</button>
      </div>
    </form>
  );
}
