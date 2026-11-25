'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CaseKind, OutputType, ResolutionCase } from '@/domain/resolution/model';
import { currentDate, useWorkspace } from '@/components/workspace';
import { canLeaveEditing } from '@/components/edit-guard';
import { inForce } from '@/domain/resolution/lifecycle';
import { Drawer } from './drawer';
import { LoadState, useLoad } from './use-load';
import { useAction } from './use-action';
import { CASE_KINDS, getJson, newRequestId, postJson, type AssemblyWithVersions } from './api';

/** One short form, then straight to writing; `companyId` preselects a company (from its page). */
export function NewResolution({
  onCancel,
  companyId: initialCompanyId = '',
}: {
  onCancel: () => void;
  companyId?: string;
}) {
  const { data } = useWorkspace();
  const router = useRouter();
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [kind, setKind] = useState<CaseKind>('board');
  const [outputTypeId, setOutputTypeId] = useState('');
  const [assemblyVersionId, setAssemblyVersionId] = useState('');
  const [title, setTitle] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const action = useAction();
  /** Set once the resolution exists; the drawer only waits for the page to open. */
  const [opening, setOpening] = useState(false);
  // Without these the resolution can still be created; the layout is then chosen under Wording.
  const choices = useLoad(
    () =>
      Promise.all([
        getJson<{ outputTypes: OutputType[] }>('/api/output-types'),
        getJson<{ assemblies: AssemblyWithVersions[] }>('/api/resolution-assemblies'),
      ]).then(([types, assemblies]) => ({
        outputTypes: types.outputTypes.filter((t) => t.active).sort((a, b) => a.order - b.order),
        library: assemblies.assemblies,
      })),
    [],
  );
  const outputTypes = choices.data?.outputTypes ?? [];
  const library = choices.data?.library ?? [];
  const eligible = useMemo(() => {
    // Malaysia time, as the server decides which version is in force.
    const today = currentDate();
    return library
      .filter((a) => !a.archived && a.usageContexts.includes(kind))
      .flatMap((a) => {
        // The same rule the server applies: an earlier version stays offered until its successor's date.
        const version = inForce(a.versions, today);
        return version ? [{ name: a.name, outputTypeId: a.outputTypeId, version }] : [];
      });
  }, [library, kind]);
  const types = outputTypes.filter((t) => eligible.some((a) => a.outputTypeId === t.id));
  const chosenType = types.some((t) => t.id === outputTypeId) ? outputTypeId : types[0]?.id || '';
  const layouts = eligible.filter((a) => a.outputTypeId === chosenType);
  const chosenLayout = layouts.some((a) => a.version.id === assemblyVersionId)
    ? assemblyVersionId
    : layouts[0]?.version.id || '';
  if (!data) return null;
  const close = async () => {
    if (await canLeaveEditing()) onCancel();
  };
  return (
    <Drawer title="New resolution" onClose={onCancel}>
      <form
        className="side-form"
        data-dirty={companyId !== initialCompanyId || title ? 'true' : 'false'}
        onChange={() => setRequestId(newRequestId())}
        onSubmit={async (event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          // Creating and choosing the layout are one step: the button stays off until both finish
          // and the page moves on, so a second click cannot create a second resolution.
          const created = await action.run(async () => {
            const made = await postJson<ResolutionCase>('/api/resolution-cases', {
              requestId,
              companyId,
              kind,
              title: title.trim(),
              instructionDate: null,
              resolutionDate: null,
              effectiveDate: null,
            });
            setOpening(true);
            formElement.setAttribute('data-dirty', 'false');
            // An empty first selection starts from the layout's starter wording (server rule).
            // If this fails the resolution still exists and opens at Wording to choose again.
            if (chosenType && chosenLayout)
              await postJson(`/api/resolution-cases/${made.id}/clauses`, {
                action: 'set_selection',
                expectedRevision: made.revision,
                requestId: newRequestId(),
                outputTypeId: chosenType,
                assemblyVersionId: chosenLayout,
                clauses: [],
              }).catch(() => {});
            return made;
          });
          if (created) router.push('/resolutions/' + created.id);
        }}
      >
        <div className="side-form-body form-stack">
          <LoadState
            loading={choices.loading && !choices.data}
            error={choices.error}
            reload={() => void choices.reload()}
            label="document types and layouts"
          />
          <label>
            Company
            <select
              required
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
            >
              <option value="">Select a company</option>
              {data.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value as CaseKind)}>
              {CASE_KINDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Document type
            <select
              value={chosenType}
              disabled={!types.length}
              onChange={(event) => setOutputTypeId(event.target.value)}
            >
              {types.length ? null : <option value="">No document type available</option>}
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Layout
            <select
              value={chosenLayout}
              disabled={!layouts.length}
              onChange={(event) => setAssemblyVersionId(event.target.value)}
            >
              {layouts.length ? null : <option value="">No layout available</option>}
              {layouts.map((layout) => (
                <option key={layout.version.id} value={layout.version.id}>
                  {layout.name} v{layout.version.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input
              required
              maxLength={300}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {action.error ? (
            <div className="feedback error" role="alert">
              {action.error}
            </div>
          ) : null}
        </div>
        <div className="side-form-bar">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={action.pending || opening || !companyId || !title.trim()}
          >
            {action.pending || opening ? 'Creating…' : 'Create and start writing'}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
