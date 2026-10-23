import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { BASIC_MONTHLY_CENTS, PLUS_ANNUAL_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';
import { at, bodyOf } from './helpers/source-order';

// /admin/billing reduced every figure — Est. MRR, Active and the trials beside
// it, Past Due, the plan donut, the six-month trend and the recent table — from
// ONE read of every subscription, paged on the id to a 50,000-row ceiling with
// reaching it an error. So past 50,000 subscriptions the whole page was the
// read-error state, Billing Customers (a count that needs no subscription row)
// with it (review R6-BILLING-CEILING-STILL-WHOLE-PAGE). The tiles and the donut
// are head:true counts now, the trend reads only its own six months, and the
// recent table its newest ten rows; only the trend's own rows past the ceiling
// cost the trend, and any read that FAILS is still the read-error state.
const CAP = 1000;
const CEILING = 50_000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

let db: InMemorySupabase;

async function render(): Promise<string> {
  const { default: AdminBillingPage } = await import('@/app/(app)/admin/billing/page');
  return renderServerPage(await AdminBillingPage());
}

const readError = () => SOURCE_MESSAGES['billing.couldNotLoadBillingData'];
const notShownTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() });
/** The trend card, from its heading to the note under its bars. */
const trendCard = (html: string) => bodyOf(html, `font-semibold">${SOURCE_MESSAGES['adminBilling.newMrrAdded']}</h2>`, SOURCE_MESSAGES['adminBilling.monthlyEquivalentRevenueFromSubscriptionsStarted']);
/** The donut's legend line for one plan: its name, then its count. */
const legend = (label: string, n: number) => `<span class="text-muted">${label}</span><span class="ml-auto font-semibold">${n}</span>`;
const sub = (id: string, plan: string, status: string, createdAt: string): Row => ({
  id, family_id: `fam-${id}`, plan, status, created_at: createdAt, updated_at: createdAt, current_period_end: null,
});

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin/billing past 50,000 subscriptions', () => {
  // 50,001 subscriptions. All but the newest twelve were taken out in 2025,
  // before the trend's six months; the twelve are October 2026's.
  const TRIALING = 7;
  const PAST_DUE = 5;
  const UNPAID = 4;
  const PLUS_ANNUAL = 3;
  /** Paying, on a plan the page has no name or price for. */
  const UNNAMED = 2;
  const CANCELED = 6;
  const NEW_BASIC = 12;
  const OLD_PLUS = CEILING + 1 - (TRIALING + PAST_DUE + UNPAID + PLUS_ANNUAL + UNNAMED + CANCELED + NEW_BASIC);
  const PAYING = OLD_PLUS + PLUS_ANNUAL + UNNAMED + NEW_BASIC;
  const named = (k: number) => `<td class="px-4 py-3 font-medium">New family ${k}</td>`;

  function seedPastTheCeiling() {
    const old = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
    let i = 0;
    const take = (n: number, plan: string, status: string) =>
      Array.from({ length: n }, () => { const k = i++; return sub(`o-${pad(k)}`, plan, status, old(k)); });
    const rows = [
      ...take(OLD_PLUS, 'plus', 'active'),
      ...take(TRIALING, 'plus', 'trialing'),
      ...take(PAST_DUE, 'basic', 'past_due'),
      ...take(UNPAID, 'basic', 'unpaid'),
      ...take(PLUS_ANNUAL, 'plus_annual', 'active'),
      ...take(UNNAMED, 'family_plus', 'active'),
      ...take(CANCELED, 'plus', 'canceled'),
      ...Array.from({ length: NEW_BASIC }, (_, k) => ({
        ...sub(`n-${pad(k)}`, 'basic', 'active', new Date(Date.UTC(2026, 9, 1) + k * 3_600_000).toISOString()),
        family_id: `fam-new-${k}`,
      })),
    ];
    expect(rows).toHaveLength(CEILING + 1);
    db.seed('subscriptions', rows);
    db.seed('families', Array.from({ length: NEW_BASIC }, (_, k) => ({ id: `fam-new-${k}`, name: `New family ${k}` })));
    db.seed('billing_customers', Array.from({ length: 3 }, (_, k) => ({ id: `bc-${k}`, family_id: `fam-new-${k}`, provider: 'stripe', customer_ref: `cus_${k}` })));
  }

  it('every tile, the donut, the trend and the newest ten rows render, over every subscription', async () => {
    seedPastTheCeiling();
    const html = await render();
    expect(html).not.toContain(readError());

    expect(statCardValue(html, 'Est. MRR')).toBe(fmtMoney(
      OLD_PLUS * PLUS_MONTHLY_CENTS + PLUS_ANNUAL * Math.round(PLUS_ANNUAL_CENTS / 12) + NEW_BASIC * BASIC_MONTHLY_CENTS,
    ));
    expect(statCardValue(html, 'Active Subscriptions')).toBe(PAYING.toLocaleString());
    expect(html).toContain(`+ ${TRIALING} trialing`);
    expect(statCardValue(html, 'Past Due / Unpaid')).toBe(String(PAST_DUE + UNPAID));
    expect(statCardValue(html, 'Billing Customers')).toBe('3');

    // The donut counts every paying subscription, the unnamed plan too.
    expect(html).toContain(legend('Family+', OLD_PLUS));
    expect(html).toContain(legend('Family+ (Annual)', PLUS_ANNUAL));
    expect(html).toContain(legend('Family Basic', NEW_BASIC));
    expect(html).toContain(legend(SOURCE_MESSAGES['adminBilling.otherPlans'], UNNAMED));
    expect(html).toContain(`font-weight="bold">${PAYING}</text>`);

    // October's bar is the twelve started in it; the five months before it drew nothing.
    const trend = trendCard(html);
    expect(trend).toContain(`title="${fmtMoney(NEW_BASIC * BASIC_MONTHLY_CENTS)}"`);
    expect(trend.split(`title="${fmtMoney(0)}"`)).toHaveLength(6);

    // The ten newest, newest first, each under its own family.
    for (let k = NEW_BASIC - 10; k < NEW_BASIC; k++) expect(html).toContain(named(k));
    expect(html).not.toContain(named(NEW_BASIC - 11));
    expect(at(html, named(NEW_BASIC - 1))).toBeLessThan(at(html, named(NEW_BASIC - 10)));
    expect(html).not.toContain(notShownTitle());
  });

  it('past the ceiling inside the trend\'s six months the trend alone is not shown, and says so', async () => {
    db.seed('subscriptions', Array.from({ length: CEILING + 1 }, (_, k) =>
      sub(`s-${pad(k)}`, 'plus', 'active', new Date(Date.UTC(2026, 8, 1) + k * 60_000).toISOString())));
    db.seed('families', [{ id: `fam-s-${pad(CEILING)}`, name: 'Newest family' }]);
    db.seed('billing_customers', []);
    const html = await render();
    expect(html).not.toContain(readError());
    expect(statCardValue(html, 'Est. MRR')).toBe(fmtMoney((CEILING + 1) * PLUS_MONTHLY_CENTS));
    expect(statCardValue(html, 'Active Subscriptions')).toBe((CEILING + 1).toLocaleString());
    expect(html).toContain(legend('Family+', CEILING + 1));
    expect(html).toContain('<td class="px-4 py-3 font-medium">Newest family</td>');

    const trend = trendCard(html);
    expect(trend).not.toContain('title="$');
    expect(trend).toContain(`<p class="text-sm text-muted">${SOURCE_MESSAGES['strategyMetrics.unavailable']}</p>`);
    const banner = html.slice(at(html, notShownTitle()));
    expect(banner.slice(0, banner.indexOf('</ul>'))).toContain(`<li>${SOURCE_MESSAGES['adminBilling.newMrrAdded']}</li>`);
  });

  // Each of the page's subscription reads, told apart by the calls it makes.
  const READS: [string, (calls: FaultCall[]) => boolean][] = [
    ['every subscription read', () => true],
    ['a tile\'s count', (calls) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true)],
    ['the trend\'s rows', (calls) => calls.some((c) => c.method === 'gte')],
    ['the recent rows', (calls) => calls.some((c) => c.method === 'range')],
  ];

  it.each(READS)('a subscription read that FAILS (%s) is still the read-error state', async (_, failing) => {
    seedPastTheCeiling();
    h.db = withFaults(db, (table, calls) => (table === 'subscriptions' && failing(calls) ? { message: 'subscriptions unavailable' } : null));
    const html = await render();
    expect(html).toContain(readError());
    expect(html).not.toContain('Est. MRR');
    expect(html).not.toContain('New family');
  });

  // One count of each family, told apart by its own filter. The case above
  // that faults every head:true read reaches the read-error state through the
  // other-plans count alone, so it held with the plan and status counts' error
  // check deleted, and a single failing count then read as `count ?? 0`: the
  // 'plus' count timing out left every Family+ subscription out of Est. MRR,
  // Active and the donut, and said nothing (review
  // R7B-BILLING-COUNT-FAILS-CONTROL-NOT-ISOLATED). Each case faults exactly one.
  const ONE_COUNT: [string, (calls: FaultCall[]) => boolean][] = [
    ['one plan\'s count, Family+', (calls) => calls.some((c) => c.method === 'eq' && c.args[0] === 'plan' && c.args[1] === 'plus')],
    ['one status\'s count, trialing', (calls) => calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'trialing')],
    ['the other plans\' count', (calls) => calls.some((c) => c.method === 'not')],
  ];

  it.each(ONE_COUNT)('one count that FAILS (%s) is the read-error state, not a zero', async (_, failing) => {
    seedPastTheCeiling();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'subscriptions' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'subscriptions unavailable' };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(html).toContain(readError());
    expect(html).not.toContain('Est. MRR');
    expect(html).not.toContain('New family');
  });

  it('the control: under the ceiling the trend draws and nothing is said to be missing', async () => {
    db.seed('subscriptions', Array.from({ length: CAP + 300 }, (_, k) =>
      sub(`s-${pad(k)}`, 'plus', 'active', new Date(Date.UTC(2026, 9, 1) + k * 60_000).toISOString())));
    db.seed('billing_customers', []);
    const html = await render();
    expect(html).not.toContain(readError());
    expect(trendCard(html)).toContain(`title="${fmtMoney((CAP + 300) * PLUS_MONTHLY_CENTS)}"`);
    expect(html).not.toContain(notShownTitle());
  });
});
