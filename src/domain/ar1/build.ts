import { buildContext } from './build-context';
import {
  buildFiling,
  buildSectionA,
  buildSectionB,
  buildSectionC,
  buildSectionD,
  buildSectionE,
  buildSectionF,
  buildSectionG,
} from './build-sections';
import type { Ar1Data, BuildInput, ReturnIssue } from './data';

export * from './data';
export {
  ALL_ANALYSES,
  analysisFor,
  buildContext,
  choosesAnalysis,
  splitRegistrationNumber,
  type BuildContext,
} from './build-context';
export {
  buildFiling,
  buildSectionA,
  buildSectionB,
  buildSectionC,
  buildSectionD,
  buildSectionE,
  buildSectionF,
  buildSectionG,
  SUBCLASS_FOR_TRUSTEE,
} from './build-sections';
export { maskAr1Data } from './mask';

/**
 * Builds the AR1 values for a return from records as at its return date, with everything mTool
 * would reject listed as an issue. It never invents a value: anything not recorded is left empty
 * and reported. Issues are listed by section: Filing, then A to G.
 */
export function buildReturn(input: BuildInput): { data: Ar1Data; issues: ReturnIssue[] } {
  const ctx = buildContext(input);
  const filing = buildFiling(ctx);
  const a = buildSectionA(ctx);
  const b = buildSectionB(ctx);
  const c = buildSectionC(ctx);
  const d = buildSectionD(ctx);
  const e = buildSectionE(ctx);
  const f = buildSectionF(ctx, e.data.members);
  const g = buildSectionG(ctx);
  return {
    data: {
      filingInfo: filing.data,
      a: a.data,
      b: b.data,
      c: c.data,
      d: d.data,
      e: e.data,
      f: f.data,
      g: g.data,
    },
    issues: [filing, a, b, c, d, e, f, g].flatMap((s) => s.issues),
  };
}
