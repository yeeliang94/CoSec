import type { ShareEntry } from '@/domain/ar1/shares';
import type { RowMenuItem } from '@/components/menu';

/** An entry's status as the register shows it: a draft reads by who must act on it next. */
export function entryStatus(entry: Pick<ShareEntry, 'status' | 'preparedBy'>, actorId: string) {
  if (entry.status !== 'Draft') return entry.status;
  return entry.preparedBy === actorId ? 'Waiting for review' : 'To review';
}

/**
 * The review controls for one register entry. Someone other than the preparer posts a draft;
 * the preparer or a reviewer can withdraw it; a posted entry is corrected by a new entry.
 */
export function reviewItems(
  entry: Pick<ShareEntry, 'status' | 'preparedBy'>,
  options: {
    canEdit: boolean;
    actorId: string;
    onPost: () => void;
    onWithdraw: () => void;
    onCorrect: () => void;
  },
): RowMenuItem[] {
  const items: RowMenuItem[] = [];
  if (!options.canEdit) return items;
  if (entry.status === 'Draft' && entry.preparedBy !== options.actorId)
    items.push({ label: 'Review and post', onSelect: options.onPost });
  if (entry.status === 'Draft')
    items.push({
      label: 'Withdraw draft',
      onSelect: options.onWithdraw,
      confirm: { label: 'Withdraw', cancelLabel: 'Keep draft' },
    });
  if (entry.status === 'Posted') items.push({ label: 'Correct', onSelect: options.onCorrect });
  return items;
}
