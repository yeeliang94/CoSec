import { describe, expect, it } from 'vitest';
import { inForce, type Lifecycle } from '../src/domain/resolution/lifecycle';

const v = (version: number, status: string, effectiveDate: string | null): Lifecycle =>
  ({ id: `v${version}`, version, status, effectiveDate }) as Lifecycle;

describe('version in force', () => {
  it('keeps offering the earlier version until a future successor takes effect', () => {
    const lineage = [v(1, 'Superseded', '2026-01-01'), v(2, 'Published', '2026-12-01')];
    expect(inForce(lineage, '2026-11-15')?.id).toBe('v1');
    expect(inForce(lineage, '2026-12-01')?.id).toBe('v2');
  });
  it('offers nothing before any version takes effect or for drafts', () => {
    expect(inForce([v(1, 'Published', '2027-01-01')], '2026-11-15')).toBeNull();
    expect(inForce([v(1, 'Draft', '2026-01-01')], '2026-11-15')).toBeNull();
  });
});
