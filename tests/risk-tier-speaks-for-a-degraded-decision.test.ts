import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { riskTierStance, riskToDecision, type Decision } from '@/lib/trust/engine';

/**
 * A decision reached WITHOUT the family's rules must still meet the risk tier.
 *
 * The degraded downgrade (a failed policy/grant read becomes `require_approval`
 * rather than the role default's `allow`) introduced a new `basis`. Three call
 * sites decided whether the risk tier speaks by naming the bases they knew:
 *
 *   const fromGenericRule = decision.basis === 'role_default'
 *                        || decision.basis === 'fallback';
 *
 * — in lib/ai/tools/execute.ts, lib/ai/planner/validate.ts and
 * lib/trust/ai-gate.ts. `degraded` was in none of them, so the tier was skipped
 * entirely and an action it DENIES outright (a child in a high-stakes domain,
 * or any write under a "recommend only" autonomy dial) became merely
 * parent-approvable the moment a read failed. The fail-safe loosened the one
 * path it most needed to hold.
 *
 * The rule now lives once, in the engine, and the sites consult it.
 */

const base = (basis: Decision['basis'], effect: Decision['effect'] = 'allow'): Decision =>
  ({ effect, reason: 'test', basis });

describe('riskTierStance', () => {
  it('lets the tier speak outright for the generic role matrix', () => {
    expect(riskTierStance(base('role_default'))).toBe('speaks');
    expect(riskTierStance(base('fallback'))).toBe('speaks');
  });

  // The finding: not 'silent'. Silent is what skipped the tier.
  it('lets the tier tighten a degraded decision', () => {
    expect(riskTierStance(base('degraded', 'require_approval'))).toBe('tighten_only');
  });

  it('lets the tier tighten a blanket allow, as before', () => {
    expect(riskTierStance({ ...base('policy'), policyScope: 'broad' })).toBe('tighten_only');
  });

  it('stays out when a rule about THIS action decided it', () => {
    expect(riskTierStance({ ...base('policy'), policyScope: 'specific' })).toBe('silent');
    expect(riskTierStance(base('deny_grant', 'deny'))).toBe('silent');
    expect(riskTierStance(base('emergency'))).toBe('silent');
    expect(riskTierStance(base('delegation'))).toBe('silent');
  });
});

describe('what tighten_only buys on a degraded decision', () => {
  // The consequence the stance exists for: the tier's answer for a child in a
  // high-stakes domain is a hard deny, and 'tighten_only' is what lets that
  // deny replace the degraded require_approval.
  it('the tier denies a child the READ of a sensitive domain', () => {
    // Not a high-risk write: that tier answers `require_approval`, which is
    // what the degraded downgrade already says. The tier's outright DENIES are
    // the two below, and those are what skipping it gave away.
    const risked = riskToDecision({
      risk: 'high',
      actor: { kind: 'member', id: 'kid-1', role: 'child' },
      domain: 'finances',
      capability: 'view',
      explicitAllow: false,
    });
    expect(risked?.effect).toBe('deny');
  });

  it('the tier denies any write in a household set to recommend only', () => {
    const risked = riskToDecision({
      risk: 'low',
      actor: { kind: 'ai_agent', id: 'concierge', role: 'parent' },
      domain: 'calendar',
      capability: 'create',
      explicitAllow: false,
      behavior: 'recommend',
    });
    expect(risked?.effect).toBe('deny');
  });

  // …and the other direction: an `allow` from the tier must NOT undo the
  // downgrade, which is why degraded is 'tighten_only' and not 'speaks'.
  it('an allow from the tier cannot loosen a degraded decision', () => {
    const stance = riskTierStance(base('degraded', 'require_approval'));
    const risked: Decision = base('risk_tier', 'allow');
    const applies = stance === 'speaks' || risked.effect !== 'allow';
    expect(applies).toBe(false);
  });
});

describe('the rule is defined once', () => {
  // The defect was three copies that had to be remembered together. A site that
  // re-derives the basis comparison inline has drifted out of the definition
  // again, which is how `degraded` slipped through the first time.
  const SITES = [
    'lib/ai/tools/execute.ts',
    'lib/ai/planner/validate.ts',
    'lib/trust/ai-gate.ts',
  ];

  for (const site of SITES) {
    it(`${site} consults riskTierStance instead of naming bases`, () => {
      const src = readFileSync(site, 'utf8');
      expect(src).toContain('riskTierStance');
      expect(src).not.toMatch(/basis === 'role_default'/);
      expect(src).not.toMatch(/basis === 'fallback'/);
    });
  }
});

describe('the planner does not plan on rules it could not read', () => {
  // The planner guards `loadTrustInputs` with a try/catch whose message is
  // "Bubaly could not check what it is allowed to do, so it did not plan
  // anything." That catch is DEAD for a failed read: loadTrustInputs goes
  // through settleAll, which turns a rejected transport into a resolved
  // `{ data: null, error }`. So an unreadable trust_policies table arrived as
  // an EMPTY policy list and the plan was built as though the family had
  // denied nothing — the executor's gate would then catch it, but the plan the
  // family is shown was already wrong.
  //
  // This asserts the two facts that compose the behaviour: the load reports
  // `degraded` rather than throwing (proved against the real function in
  // trust-rules-that-did-not-load), and both planner call sites act on it.
  const src = readFileSync('lib/ai/planner/index.ts', 'utf8');

  it('checks degraded at both trust-load sites', () => {
    expect(src.match(/if \(trust\.degraded\)/g)?.length).toBe(2);
  });

  it('takes the same refusal path the dead catch already chose', () => {
    expect(src).toContain('Bubaly could not check what it is allowed to do, so it did not plan anything.');
    expect(src.match(/trust inputs were degraded/g)?.length).toBe(2);
  });
});
