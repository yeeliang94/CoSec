'use client';
import type { ReactNode } from 'react';

/**
 * Where roving focus moves when a tab receives `key`, or null when the key is
 * not a tablist key. Arrows wrap at both ends; Home and End go to the edges.
 */
export function rovingIndex(key: string, index: number, length: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % length;
    case 'ArrowLeft':
      return (index - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}

/** The element id of one tab button. */
export const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
/** The element id of the panel one tab opens. */
export const tabPanelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

export type TabItem<T extends string> = { id: T; label: string };

/**
 * A row of tabs (role=tablist) with roving keyboard focus: only the selected
 * tab is in the tab order, and Arrow, Home and End move between tabs.
 *
 * Screens style it through `className` (the strip), `tabClassName` (every tab)
 * and `activeClassName` (the selected tab); nothing is added by default, so
 * the markup stays what each screen's stylesheet expects. With `controls`, every
 * tab points at that one panel; otherwise each tab controls `tabPanelId(idPrefix, id)`.
 */
export function Tabs<T extends string>({
  tabs,
  selected,
  onChange,
  ariaLabel,
  idPrefix,
  className,
  tabClassName,
  activeClassName,
  controls,
}: {
  tabs: TabItem<T>[];
  selected: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  idPrefix: string;
  className?: string;
  tabClassName?: string;
  activeClassName?: string;
  controls?: string;
}) {
  return (
    <div className={className} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        const classes = [tabClassName, active ? activeClassName : ''].filter(Boolean).join(' ');
        return (
          <button
            type="button"
            role="tab"
            key={tab.id}
            id={tabId(idPrefix, tab.id)}
            className={classes || undefined}
            aria-selected={active}
            aria-controls={controls ?? tabPanelId(idPrefix, tab.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next = rovingIndex(event.key, index, tabs.length);
              if (next === null) return;
              event.preventDefault();
              onChange(tabs[next].id);
              document.getElementById(tabId(idPrefix, tabs[next].id))?.focus();
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The panel a tab opens. Pass `hidden` to keep an inactive panel mounted but
 * out of view; pass `id` when one panel serves every tab and `tabKey` names
 * the tab currently shown in it.
 */
export function TabPanel({
  idPrefix,
  tabKey,
  id,
  hidden,
  className,
  children,
}: {
  idPrefix: string;
  tabKey: string;
  id?: string;
  hidden?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      role="tabpanel"
      id={id ?? tabPanelId(idPrefix, tabKey)}
      aria-labelledby={tabId(idPrefix, tabKey)}
      hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}
