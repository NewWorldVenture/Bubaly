// What the site SELLS and what the site SERVES are two different files, and
// nothing made them agree.
//
// `lib/constants/plans.ts` is the published offer — it is what the pricing page
// renders and what a family reads before paying. `lib/constants/feature-catalog.ts`
// is what actually opens a page, and `AI_MONTHLY_ALLOWANCE` is what actually
// meters a request. All three describe the same product and none of them read
// the others.
//
// They had drifted apart in the most visible place in the app. The Free plan
// lists "10 AI requests/month". The sidebar pins an "AI Assistant" pill at the
// top for every plan, on purpose — `nav-shared.tsx` says "so the AI layer is
// always one tap away regardless of plan". The page behind it says "Free tier
// includes a metered AI assistant (10 requests/month); the monthly quota is
// enforced at the request layer."
//
// And the catalog gated that page at `basic`, so every free family tapped the
// pinned pill and got the billing upsell — while `AI_MONTHLY_ALLOWANCE` was
// `{0: null}` and `/api/ai` checked no plan at all, so the quota the page
// promised existed nowhere and the mobile app could file unlimited turns on a
// free plan. Four statements of one offer, no two of them the same.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS } from '../lib/constants/plans';
import { FEATURE_CATALOG_BY_KEY, FEATURE_CATALOG } from '../lib/constants/feature-catalog';
import { tierToLevel } from '../lib/features/tiers';
import { AI_MONTHLY_ALLOWANCE, AI_ASSISTANT_FEATURE_KEY } from '../lib/server/ai-access';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const planFeatures = (id: string): string[] => {
  const plan = PLANS.find((p) => p.id === id);
  expect(plan, `no ${id} plan`).toBeTruthy();
  return plan!.features;
};

describe('the AI allowance is the one the plans advertise', () => {
  // The number is READ OUT OF THE COPY, not written down twice. Change the
  // pricing page to "25 AI requests/month" and this fails until the meter
  // agrees — which is the only way a number in prose and a number in a gate
  // stay the same number.
  it('meters Free at exactly the number Free is sold', () => {
    const line = planFeatures('free').find((f) => /AI requests?\/month/i.test(f));
    expect(line, 'the Free plan no longer advertises a monthly AI request count').toBeTruthy();
    const advertised = Number(/(\d+)/.exec(line!)?.[1]);
    expect(Number.isFinite(advertised)).toBe(true);
    expect(AI_MONTHLY_ALLOWANCE[0]).toBe(advertised);
  });

  it('gives Basic and Plus the unlimited AI they are sold', () => {
    expect(planFeatures('basic').some((f) => /unlimited ai/i.test(f))).toBe(true);
    expect(AI_MONTHLY_ALLOWANCE[1]).toBeNull();
    expect(AI_MONTHLY_ALLOWANCE[2]).toBeNull();
  });

  // A request you may spend is a request you must be able to reach. Selling
  // Free ten of them while gating the only page that spends them at `basic` is
  // selling something and then refusing to hand it over.
  it('lets the plan that was sold AI requests open the assistant', () => {
    const allowance = AI_MONTHLY_ALLOWANCE[0];
    if (allowance === null || allowance > 0) {
      const feature = FEATURE_CATALOG_BY_KEY[AI_ASSISTANT_FEATURE_KEY];
      expect(feature, 'the ai-assistant catalog entry is gone').toBeTruthy();
      expect(
        tierToLevel(feature.defaultTier),
        `Free is sold ${allowance} AI requests but /dashboard/assistant is gated at "${feature.defaultTier}"`,
      ).toBe(0);
    }
  });

  // The concierge is a different product at a different price. Basic's copy is
  // the only one that names it, so opening the assistant must not open this.
  it('keeps the concierge at the tier that sells it', () => {
    expect(planFeatures('free').some((f) => /concierge/i.test(f))).toBe(false);
    expect(planFeatures('basic').some((f) => /concierge/i.test(f))).toBe(true);
    expect(tierToLevel(FEATURE_CATALOG_BY_KEY['ai-concierge'].defaultTier)).toBeGreaterThan(0);
    expect(tierToLevel(FEATURE_CATALOG_BY_KEY['ai-requests'].defaultTier)).toBeGreaterThan(0);
  });
});

describe('a button that is always shown always works', () => {
  // Fixed sidebar chrome is rendered for every family on every plan — it is not
  // filtered by entitlement the way the customizable list is. A fixed route
  // gated above `free` is therefore a permanent button that a free family can
  // only ever be bounced off.
  it('every pinned sidebar route is reachable on the lowest plan', () => {
    const nav = read('lib/constants/navigation.ts');
    const block = /FIXED_SIDEBAR_ROUTES = new Set<string>\(\[([^\]]*)\]\)/.exec(nav);
    expect(block, 'FIXED_SIDEBAR_ROUTES moved or changed shape').toBeTruthy();
    const pinned = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);

    const gated = pinned
      .map((href) => ({ href, feature: FEATURE_CATALOG.find((f) => f.href === href) }))
      .filter(({ feature }) => feature && tierToLevel(feature.defaultTier) > 0)
      .map(({ href, feature }) => `${href} is pinned for every plan but gated at "${feature!.defaultTier}"`);
    expect(gated).toEqual([]);
  });
});

describe('the quota is enforced where the money is spent', () => {
  // The page gate cannot be the only gate. `/api/ai` is what calls the model,
  // and the Expo app calls it directly with a bearer token and never loads the
  // page at all — so a check that lives only in `requireFeature` is a check the
  // mobile app walks straight past.
  //
  // Checked with the imports STRIPPED, because the first version of this case
  // was not. Deleting the `return accessDeniedResponse(access)` line left the
  // import untouched, so `toContain('accessDeniedResponse')` still matched and
  // the case passed over a route that had stopped enforcing anything. The
  // revert that proved the other three cases load-bearing is what exposed it.
  it('/api/ai asks the entitlement gate before running a turn, and answers a denial', () => {
    const body = read('app/api/ai/route.ts').replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '');
    expect(body, 'the route no longer calls the entitlement gate').toMatch(/assertAIAccess\s*\(/);
    expect(body, 'the gate is asked about some other feature than the assistant').toContain('AI_ASSISTANT_FEATURE_KEY');
    expect(body, 'a denial is computed and then discarded').toMatch(/return\s+accessDeniedResponse\s*\(/);
  });

  // The count has to count the rows the assistant actually writes. It filtered
  // `kind = 'concierge'`, and the assistant records its turns under the default
  // kind 'feature' (lib/ai/observability.ts), so the meter read zero no matter
  // how much a family used Bubaly — a limit that could never be reached.
  it('counts every AI request, not one kind of it', () => {
    const access = read('lib/server/ai-access.ts');
    const countQuery = /from\('ai_requests'\)[\s\S]*?;/.exec(access);
    expect(countQuery, 'the monthly usage query is gone').toBeTruthy();
    expect(
      /\.eq\(\s*'kind'/.test(countQuery![0]),
      'the monthly usage count filters on kind again — the assistant files "feature" rows and would not be counted',
    ).toBe(false);
    expect(countQuery![0]).toContain("eq('family_id'");
    expect(countQuery![0]).toContain('monthStartIso');
  });
});
