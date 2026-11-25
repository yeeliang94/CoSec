'use client';
import { useMemo, useRef, useState } from 'react';
import { Drawer } from '@/components/resolution/drawer';
import { WarningLine } from '@/components/warning-line';
import { formatDay, useWorkspace } from '@/components/workspace';
import { errorText, getJson, postJson } from '@/components/resolution/api';
import { fileKind, groupFolderFiles, matchFolder } from '@/domain/imports';
import type { ImportView } from './types';

type Picked = { file: File; relativePath: string };
const MAX_BYTES = 50 * 1024 * 1024;
const PARALLEL = 4;

/** Files under a dropped folder, with paths like those the folder picker gives. */
async function readEntry(entry: FileSystemEntry, prefix: string, out: Picked[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, relativePath: `${prefix}${entry.name}` });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** Upload response shape for one file. */
type Uploaded = { id: string };

export function NewImport({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const { data } = useWorkspace();
  const [name, setName] = useState(`Client files, ${formatDay(new Date().toISOString())}`);
  const [picked, setPicked] = useState<Picked[] | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const batchId = useRef<string | null>(null);
  const sent = useRef(new Set<string>());
  const requestId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  const companies = useMemo(() => data?.companies ?? [], [data]);
  const grouped = useMemo(() => (picked ? groupFolderFiles(picked) : null), [picked]);

  function choose(files: Picked[]) {
    const next = groupFolderFiles(files);
    setPicked(files);
    setError('');
    setTargets(
      Object.fromEntries(
        next.folders.map((f) => [f.name, matchFolder(f.name, companies) ?? 'new']),
      ),
    );
  }
  const targetOf = (folder: string) => targets[folder] ?? 'new';
  const used = Object.values(targets).filter((t) => t !== 'new' && t !== 'leave_out');
  const clash = used.length !== new Set(used).size;

  async function start() {
    if (!grouped) return;
    setError('');
    const folders = grouped.folders.map((f) => {
      const t = targetOf(f.name);
      return {
        folder: f.name,
        target:
          t === 'new'
            ? { mode: 'new' }
            : t === 'leave_out'
              ? { mode: 'leave_out' }
              : { mode: 'existing', companyId: t },
      };
    });
    const files = grouped.folders
      .filter((f) => targetOf(f.name) !== 'leave_out')
      .flatMap((f) => f.files.map((file) => ({ folder: f.name, ...file })));
    setProgress({ done: sent.current.size, total: files.length });
    try {
      if (!batchId.current) {
        const batch = await postJson<{ id: string }>('/api/imports', {
          requestId: requestId.current,
          name,
          looseFiles: grouped.loose,
          folders,
        });
        batchId.current = batch.id;
      }
      const id = batchId.current;
      const view = await getJson<ImportView>(`/api/imports/${id}`);
      const rows = new Map(view.companies.map((c) => [c.folder, c.id]));
      const queue = files.filter((f) => !sent.current.has(f.relativePath));
      let failure: unknown = null;
      async function worker() {
        while (queue.length && !failure) {
          const item = queue.shift()!;
          const form = new FormData();
          form.set('rowId', rows.get(item.folder) ?? '');
          form.set('path', item.relativePath.split('/').slice(2).join('/'));
          form.set('size', String(item.file.size));
          // Files the app will not read are listed without sending their contents.
          if (item.file.size <= MAX_BYTES && fileKind(item.file.name) !== 'other')
            form.set('file', item.file);
          try {
            const response = await fetch(`/api/imports/${id}/files`, {
              method: 'POST',
              body: form,
            });
            const body = (await response.json()) as Uploaded & { error?: string };
            if (!response.ok) throw new Error(body.error || 'A file could not be uploaded.');
            sent.current.add(item.relativePath);
            setProgress({ done: sent.current.size, total: files.length });
          } catch (e) {
            failure = e;
          }
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (failure) throw failure;
      await postJson(`/api/imports/${id}`, { action: 'start' });
      onStarted(id);
    } catch (e) {
      setError(`${errorText(e)} Choose Try again to send the remaining files.`);
    }
  }

  const uploading = progress !== null && !error;
  return (
    <Drawer title="New import" onClose={onClose}>
      <div className="form-stack" data-dirty={picked ? 'true' : 'false'}>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            disabled={uploading}
          />
        </label>
        <div
          className={`folder-drop${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setOver(false);
            if (batchId.current) return;
            const entry = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).find(Boolean);
            if (!entry?.isDirectory) {
              setError('Drop one folder, with one folder per company inside.');
              return;
            }
            const out: Picked[] = [];
            await readEntry(entry, '', out);
            choose(out);
          }}
        >
          <span>Drop the client folder here, with one folder per company inside</span>
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={Boolean(batchId.current)}
          >
            Choose folder
          </button>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].map((file) => ({
                file,
                relativePath: file.webkitRelativePath || file.name,
              }));
              if (files.length) choose(files);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {grouped ? (
        <section>
          <div className="import-section-head">
            <h3>Company folders</h3>
            <span>
              {grouped.folders.length} {grouped.folders.length === 1 ? 'folder' : 'folders'},{' '}
              {grouped.folders.reduce((n, f) => n + f.files.length, 0)} files
            </span>
          </div>
          {grouped.folders.length ? (
            <table className="records-table import-table">
              <caption className="sr-only">Company folders and the company each matches</caption>
              <colgroup>
                <col style={{ width: '38%' }} />
                <col style={{ width: '12%' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>Folder</th>
                  <th className="num">Files</th>
                  <th>Company</th>
                </tr>
              </thead>
              <tbody>
                {grouped.folders.map((f) => (
                  <tr key={f.name}>
                    <td title={f.name}>{f.name}</td>
                    <td className="num">{f.files.length}</td>
                    <td>
                      <select
                        aria-label={`Company for ${f.name}`}
                        value={targetOf(f.name)}
                        disabled={uploading || Boolean(batchId.current)}
                        onChange={(e) => setTargets({ ...targets, [f.name]: e.target.value })}
                      >
                        <option value="new">New company</option>
                        <option value="leave_out">Leave out</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <WarningLine>
              This folder has no company folders inside. Put each company&rsquo;s files in its own
              folder.
            </WarningLine>
          )}
          {grouped.loose ? (
            <WarningLine>
              {grouped.loose} {grouped.loose === 1 ? 'file sits' : 'files sit'} outside the company
              folders and will be left out.
            </WarningLine>
          ) : null}
          {clash ? (
            <WarningLine blocking>
              Two folders point to the same company. Choose one, or leave one out.
            </WarningLine>
          ) : null}
        </section>
      ) : null}
      <div className="import-drawer-actions">
        {error ? (
          <p className="feedback error" role="alert">
            {error}
          </p>
        ) : uploading ? (
          <p className="feedback" role="status">
            Uploading {progress.done} of {progress.total} files
          </p>
        ) : null}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!grouped?.folders.length || clash || uploading || !name.trim()}
          onClick={() => void start()}
        >
          {error && batchId.current ? 'Try again' : uploading ? 'Uploading…' : 'Start import'}
        </button>
      </div>
    </Drawer>
  );
}
