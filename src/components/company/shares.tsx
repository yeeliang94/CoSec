'use client';
import { useMemo, useState } from 'react';
import type { Person } from '@/domain/resolution/model';
import {
  replay,
  SHARE_ENTRY_LABELS,
  type ShareClass,
  type ShareEntry,
  type ShareEntryKind,
} from '@/domain/ar1/shares';
import { formatMyr } from '@/domain/ar1/money';
import { currentDate, Empty, useWorkspace } from '@/components/workspace';
import { getJson, newRequestId, postJson } from '@/components/resolution/api';
import { LoadState, useLoad } from '@/components/resolution/use-load';
import { ActionFeedback, useAction } from '@/components/resolution/use-action';
import { holderName, peopleByIdUrls, registerPartyIds } from './shares/names';
import { RegisterTable } from './shares/register-table';
import { ShareEntryEdit } from './shares/entry-form';
import { ShareClassesEdit } from './shares/classes-form';

type SharesData = { classes: ShareClass[]; profileRevision: number; entries: ShareEntry[] };
const count = (n: bigint) => n.toLocaleString('en');

/** Share capital, members and the register for one company, with recording and review. */
export function CompanyShares({ companyId }: { companyId: string }) {
  const { data } = useWorkspace();
  const load = useLoad(
    () => getJson<SharesData>(`/api/companies/${companyId}/shares`),
    [companyId],
  );
  // Only the people the register names, fetched by id so a large directory is never cut short.
  const partyIds = useMemo(() => registerPartyIds(load.data?.entries ?? []), [load.data]);
  const people = useLoad(
    () =>
      Promise.all(peopleByIdUrls(partyIds).map((url) => getJson<{ people: Person[] }>(url))).then(
        (pages) => pages.flatMap((page) => page.people),
      ),
    [partyIds.join(',')],
  );
  const [panel, setPanel] = useState<
    | { kind: 'entry'; entryKind: ShareEntryKind; correcting?: ShareEntry }
    | { kind: 'classes' }
    | null
  >(null);
  const action = useAction();
  const names = useMemo(
    () => new Map((people.data ?? []).map((p) => [p.id, p.fullName])),
    [people.data],
  );
  if (!data) return null;
  const canEdit = data.actor.capabilities.some(
    (c) => c === 'confirm_record' || c === 'manage_people',
  );
  const shares = load.data;
  const today = currentDate();
  const state = shares ? replay(shares.entries, today).state : null;
  const classOf = (id: string) => shares?.classes.find((c) => c.id === id);
  const totalHeld = state ? state.holdings.reduce((n, h) => n + h.shares, 0n) : 0n;
  const act = (entry: ShareEntry, act: 'post' | 'withdraw') =>
    action.run(
      async () => {
        await postJson(`/api/companies/${companyId}/shares`, {
          action: act,
          id: entry.id,
          expectedRevision: entry.revision,
          requestId: newRequestId(),
          ...(act === 'withdraw' ? { reason: 'Withdrawn before posting' } : {}),
        });
        await load.reload();
      },
      act === 'post' ? 'Entry posted' : 'Draft withdrawn',
    );
  return (
    <>
      <LoadState
        loading={load.loading && !load.data}
        error={load.error}
        reload={() => void load.reload()}
        label="share register"
      />
      {shares && state ? (
        <>
          <section className="section">
            <div className="person-section-heading">
              <h3>Share capital</h3>
              {canEdit ? (
                <button
                  type="button"
                  className="text-button section-link"
                  onClick={() => setPanel({ kind: 'classes' })}
                >
                  Share classes
                </button>
              ) : null}
            </div>
            {shares.classes.length ? (
              <div className="table-wrap">
                <table className="records-table">
                  <caption className="sr-only">Share capital today</caption>
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th className="num">Issued</th>
                      <th className="num">Paid (MYR)</th>
                      <th className="num">Unpaid (MYR)</th>
                      <th className="num">Treasury</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.classes.map((c) => {
                      const issued = state.issued.get(c.id);
                      return (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td className="num">
                            {count((issued?.cash ?? 0n) + (issued?.otherwise ?? 0n))}
                          </td>
                          <td className="num">{formatMyr(issued?.paid ?? 0n)}</td>
                          <td className="num">
                            {formatMyr((issued?.payable ?? 0n) - (issued?.paid ?? 0n))}
                          </td>
                          <td className="num">{count(state.treasury.get(c.id) ?? 0n)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                No share classes yet
                {canEdit ? (
                  <button type="button" onClick={() => setPanel({ kind: 'classes' })}>
                    Add share classes
                  </button>
                ) : null}
              </Empty>
            )}
          </section>
          <section className="section">
            <h3>Members</h3>
            {state.holdings.length ? (
              <div className="table-wrap">
                <table className="records-table">
                  <caption className="sr-only">Members today</caption>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Class</th>
                      <th className="num">Shares</th>
                      <th className="num">Holding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.holdings.map((h) => {
                      const name = holderName(h.holder, names);
                      return (
                        <tr key={`${h.key}|${h.classId}`}>
                          <td title={name}>{name}</td>
                          <td>{classOf(h.classId)?.name}</td>
                          <td className="num">{count(h.shares)}</td>
                          <td className="num">
                            {totalHeld
                              ? `${((Number(h.shares) / Number(totalHeld)) * 100).toFixed(2)}%`
                              : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No posted holdings yet</p>
            )}
          </section>
          <section className="section">
            <div className="person-section-heading">
              <h3>Share register</h3>
              {canEdit && shares.classes.length ? (
                <div className="header-actions">
                  {(['opening', 'allotment', 'transfer', 'buyback'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setPanel({ kind: 'entry', entryKind: k })}
                    >
                      Record {SHARE_ENTRY_LABELS[k].toLowerCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <ActionFeedback
              error={action.error}
              status={action.status}
              conflict={action.conflict}
              onReload={() => void load.reload()}
            />
            {shares.entries.length ? (
              <RegisterTable
                entries={shares.entries}
                classes={shares.classes}
                names={names}
                canEdit={canEdit}
                actorId={data.actor.id}
                onAct={(entry, kind) => void act(entry, kind)}
                onCorrect={(entry) =>
                  setPanel({ kind: 'entry', entryKind: entry.kind, correcting: entry })
                }
              />
            ) : (
              <p className="muted">No register entries yet</p>
            )}
          </section>
          {panel?.kind === 'classes' ? (
            <ShareClassesEdit
              companyId={companyId}
              classes={shares.classes}
              revision={shares.profileRevision}
              onSaved={load.reload}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel?.kind === 'entry' ? (
            <ShareEntryEdit
              companyId={companyId}
              kind={panel.entryKind}
              correcting={panel.correcting}
              classes={shares.classes}
              names={names}
              onSaved={load.reload}
              onClose={() => setPanel(null)}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
