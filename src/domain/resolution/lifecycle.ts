import type { ClauseVersion } from './model';

export type Lifecycle = Pick<ClauseVersion, 'id' | 'status' | 'effectiveDate' | 'version'>;
/**
 * The version of a lineage in force on `asAt`: the highest-numbered Published or Superseded
 * version whose effective date has arrived. Publishing a future-dated successor marks the
 * predecessor Superseded at once, but the predecessor stays in force until the successor's date.
 * Shared by the server and the browser so both offer the same version.
 */
export function inForce<V extends Lifecycle>(lineage: V[], asAt: string): V | null {
  let best: V | null = null;
  for (const v of lineage)
    if (
      (v.status === 'Published' || v.status === 'Superseded') &&
      v.effectiveDate &&
      v.effectiveDate <= asAt &&
      (!best || v.version > best.version)
    )
      best = v;
  return best;
}
