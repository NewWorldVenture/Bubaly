import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Page audit B7. As a teen and as a child, 25 routes sent the session to
// /dashboard/billing?upgrade=1&need=2 (Missions, Rewards, the Home hub, Sports,
// the weekly briefing, …), and every one of them landed on the Finances
// dashboard: balances, "Add Transaction", "Link Account", and no word about
// why the person was there. The plan gate has always sent `upgrade`/`need`,
// and BillingModule has always read them (it highlights the plan that unlocks
// the feature, and tells anyone but a parent who to ask). But the page only
// rendered BillingModule under ?view=manage, which the gate never sent. It is
// the same for a parent on the Free or Basic plan: the upsell Pass L describes
// was never on screen.

const page = readFileSync('app/(app)/dashboard/billing/page.tsx', 'utf8');
const auth = readFileSync('lib/supabase/auth.ts', 'utf8');
const billing = readFileSync('components/modules/billing-module.tsx', 'utf8').replace(/\r\n/g, '\n');

/** Evaluate the page's own routing condition for a query. */
function showsPlanView(query: Record<string, string>): boolean {
  const expr = /const wantsPlanView = ([^;]+);/.exec(page)?.[1];
  expect(expr, 'the page names its plan-view condition').toBeTruthy();
  const { view, upgrade, checkout } = query;
  return new Function('view', 'upgrade', 'checkout', `return ${expr};`)(view, upgrade, checkout) as boolean;
}

describe('the plan gate lands on the plan', () => {
  it('the gate still sends ?upgrade=1&need=…', () => {
    expect(auth).toContain('redirect(`/dashboard/billing?upgrade=1&need=${minLevel}`)');
    expect(auth).toContain('redirect(`/dashboard/billing?upgrade=1&need=${entitlement.needLevel}`)');
  });

  it('routes the gate, the demo checkout and "Manage" to the plan view', () => {
    expect(showsPlanView({ upgrade: '1', need: '2' })).toBe(true);
    expect(showsPlanView({ checkout: 'plus' })).toBe(true);
    expect(showsPlanView({ view: 'manage' })).toBe(true);
  });

  it('keeps the Finances dashboard as the default', () => {
    expect(showsPlanView({})).toBe(false);
    expect(showsPlanView({ upgrade: '0' })).toBe(false);
    expect(page).toMatch(/if \(!wantsPlanView\) \{[\s\S]*?<FinancesModule \/>/);
  });

  it('puts the plan card first when a plan is asked for, and below the tabs otherwise', () => {
    // Scrolling to the card was tried first and lost to the tab content that
    // loads above it after the scroll; the order has to be the render order.
    const header = billing.indexOf('<PageHeader\n          title={tr(\'billing.finances\')}');
    const first = billing.indexOf('{needLevel !== undefined && planCard}');
    const tabs = billing.indexOf('{renderTabContent()}');
    const last = billing.indexOf('{needLevel === undefined && planCard}');
    expect([header, first, tabs, last].every((i) => i > -1)).toBe(true);
    expect(header).toBeLessThan(first);
    expect(first).toBeLessThan(tabs);
    expect(tabs).toBeLessThan(last);
    expect(billing).toContain('highlight={needLevel}');
  });
});

describe('the plan card claims only what the plan includes', () => {
  it('lists the current tier\'s own features, and none on Free', () => {
    // One fixed list used to render for every plan, so a Free family whose
    // card said "up to 5 members" saw "Unlimited family members" ticked.
    expect(billing).not.toContain("'billingModule.includes.unlimitedMembers', 'billingModule.includes.aiAssistant', 'billingModule.includes.allModules'");
    expect(billing).toContain('const currentTier = TIER_DEFS.find((d) => d.level === planLevel(subscription?.plan ?? null));');
    expect(billing).toMatch(/\{currentTier && \(\s*<div[^>]*>\s*\{currentTier\.features\.map/);
  });
});
