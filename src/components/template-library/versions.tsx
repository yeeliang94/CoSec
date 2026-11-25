import { Empty, formatDay } from '@/components/workspace';
import { statusOf } from '@/components/resolution/api';

/** One version value for a list cell: "v2 draft (v1 published)". */
export function versionText<T extends { id: string; version: number; status: string }>(
  versions: T[],
) {
  const { last, published } = statusOf(versions);
  if (!last) return '';
  const current = `v${last.version} ${last.status.toLowerCase()}`;
  return published && published.id !== last.id
    ? `${current} (v${published.version} published)`
    : current;
}

/** The day the latest version last changed. */
export function updatedText<T extends { version: number; status: string; updatedAt: string }>(
  versions: T[],
) {
  const { last } = statusOf(versions);
  return last ? formatDay(last.updatedAt) : '';
}

/** The filtered-empty state: centred muted text with the way out underneath. */
export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <Empty>
      <p>Nothing matches</p>
      <button type="button" onClick={onClear}>
        Clear filters
      </button>
    </Empty>
  );
}
