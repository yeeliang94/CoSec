import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a change came from, added to every audit entry written while it is set. Bulk import
 * sets the import and source file around each record writer it calls, so the writers need no
 * import-specific parameters.
 */
export type AuditSource = { importId: string; importCompanyId: string; file: string | null };
const store = new AsyncLocalStorage<AuditSource>();
export const withAuditSource = <T>(source: AuditSource, fn: () => Promise<T>) =>
  store.run(source, fn);
export const currentAuditSource = () => store.getStore();
