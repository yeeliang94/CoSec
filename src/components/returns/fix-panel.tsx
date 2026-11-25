'use client';
import type { CompanyProfile } from '@/domain/resolution/model';
import { getJson } from '@/components/resolution/api';
import { useLoad } from '@/components/resolution/use-load';
import { useWorkspace } from '@/components/workspace';
import { ParticularsEdit } from '@/components/people/particulars';
import { CompanyParticularsEdit } from '@/components/company/particulars';
import { AppointmentEdit } from './appointment-edit';
import type { FixTarget, ReturnView } from './step-parts';

/**
 * The side panel a missing value opens. It edits the source record as at the return date, so the
 * return sees what is saved; a change dated later is kept but not read by this return.
 */
export function FixPanel({
  view,
  target,
  onClose,
  onSaved,
}: {
  view: ReturnView;
  target: FixTarget;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { data: workspace } = useWorkspace();
  const profile = useLoad(
    () =>
      target.kind === 'company'
        ? getJson<CompanyProfile>(`/api/companies/${view.company.id}/profile`)
        : Promise.resolve(null),
    [target.kind, view.company.id],
  );
  if (target.kind === 'person') {
    const person = view.people.find((p) => p.id === target.id);
    if (!person) return null;
    const roles = view.relationships.filter((r) => r.personId === person.id).map((r) => r.role);
    return (
      <ParticularsEdit
        person={person}
        roles={[...new Set([...roles, ...target.roles])]}
        canViewIdentity={Boolean(workspace?.actor.capabilities.includes('view_identity'))}
        missing={target.keys}
        title={person.fullName}
        saveLabel="Save to people record"
        asAt={view.record.returnDate}
        onSaved={onSaved}
        onClose={onClose}
      />
    );
  }
  if (target.kind === 'company')
    return profile.data ? (
      <CompanyParticularsEdit
        companyId={view.company.id}
        profile={profile.data}
        missing={target.keys}
        saveLabel="Save to company record"
        asAt={view.record.returnDate}
        onSaved={onSaved}
        onClose={onClose}
      />
    ) : null;
  if (target.kind === 'appointment') {
    const relationship = view.relationships.find((r) => r.id === target.relationshipId);
    return relationship ? (
      <AppointmentEdit
        view={view}
        relationship={relationship}
        onSaved={onSaved}
        onClose={onClose}
      />
    ) : null;
  }
  return null;
}
