'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/workspace';

export type RowMenuItem = {
  label: string;
  onSelect: () => void;
  /** Ask once more inside the menu before acting. */
  confirm?: { label: string; cancelLabel: string };
};

const MENU_HEIGHT = 180;

/**
 * One "More actions" button per table row. The menu is fixed to the window so a table's own
 * scrolling cannot clip it, and it closes on any scroll rather than drifting from its row.
 */
export function RowMenu({
  name,
  items,
  disabled,
}: {
  name: string;
  items: RowMenuItem[];
  disabled?: boolean;
}) {
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const [confirming, setConfirming] = useState<RowMenuItem | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = Boolean(place);
  const close = useCallback((restoreFocus = true) => {
    setPlace(null);
    setConfirming(null);
    if (restoreFocus) button.current?.focus();
  }, []);
  const entries = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    // Start on the first action; when asking to confirm, start on the safe choice.
    const list = entries();
    (confirming ? list.at(-1) : list[0])?.focus();
  }, [open, confirming]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      close();
    };
    const moved = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="tl-more"
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) return close();
          const rect = button.current!.getBoundingClientRect();
          const right = window.innerWidth - rect.right;
          setPlace(
            rect.bottom + MENU_HEIGHT > window.innerHeight
              ? { bottom: window.innerHeight - rect.top + 4, right }
              : { top: rect.bottom + 4, right },
          );
        }}
      >
        <Icon kind="more" />
      </button>
      {place ? (
        <div
          ref={menu}
          className="tl-menu"
          role="menu"
          aria-label={`Actions for ${name}`}
          style={place}
          onKeyDown={(event) => {
            const list = entries();
            const index = list.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === 'ArrowDown'
                ? (index + 1) % list.length
                : event.key === 'ArrowUp'
                  ? (index - 1 + list.length) % list.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? list.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              list[next]?.focus();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === 'Tab') close(false);
          }}
        >
          {confirming ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="danger-item"
                onClick={() => {
                  const chosen = confirming;
                  close();
                  chosen.onSelect();
                }}
              >
                {confirming.confirm!.label}
              </button>
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => close()}>
                {confirming.confirm!.cancelLabel}
              </button>
            </>
          ) : (
            items.map((item) => (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                key={item.label}
                onClick={() => {
                  if (item.confirm) return setConfirming(item);
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}
