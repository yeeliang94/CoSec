import { useEffect, useRef } from 'react';
import type { CaseApi } from './case-workspace';

export const AUTOSAVE_DELAY = 800;

/** What the header shows for a form: nothing pending, a save coming, or a change that cannot be saved yet. */
export type UnsavedState =
  { state: 'clean' } | { state: 'pending' } | { state: 'blocked'; reason: string };

/**
 * Saves a case form shortly after typing stops. The timer restarts on every change in `deps`
 * and after Reload latest (`api.retry`). The save runs through `api.track`, so the header shows
 * "Saving…" and a refused save; a failed save waits for the next edit rather than looping.
 * `blocked` names why a change cannot be saved yet (for example a blank title): the header then
 * shows "Not saved" and Finish refuses with that reason instead of waiting for a save that never comes.
 */
export function useCaseAutosave({
  api,
  form,
  pending,
  blocked = '',
  save,
  deps,
}: {
  api: Pick<CaseApi, 'canEdit' | 'track' | 'reportUnsaved' | 'retry'>;
  form: string;
  pending: boolean;
  blocked?: string;
  save: () => Promise<unknown>;
  deps: unknown[];
}) {
  const latest = useRef({ api, save });
  latest.current = { api, save };
  useEffect(() => {
    if (!api.canEdit || !pending || blocked) return;
    const timer = window.setTimeout(() => {
      const { api: current, save: send } = latest.current;
      void current.track(form, send);
    }, AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, form, pending, blocked, api.canEdit, api.retry]);
  const { reportUnsaved } = api;
  const state: UnsavedState['state'] =
    !api.canEdit || !pending ? 'clean' : blocked ? 'blocked' : 'pending';
  useEffect(() => {
    reportUnsaved(form, state === 'blocked' ? { state, reason: blocked } : { state });
    return () => reportUnsaved(form, { state: 'clean' });
  }, [form, state, blocked, reportUnsaved]);
}
