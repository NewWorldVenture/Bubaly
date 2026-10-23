import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GrowthChart } from '@/components/admin/growth-chart';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';
import { at } from './helpers/source-order';

// /admin/subscriptions summed MRR and ARR, counted active subscriptions per
// plan, computed the 30-day churn rate and labelled the All tab's count from
// ONE unbounded `subscriptions.select('*')`, ordered newest first. PostgREST
// answers it with at most 1,000 rows and no error, so past a thousand
// subscriptions every revenue figure on the page was computed over the newest
// thousand — and the OLDEST rows are the ones dropped, which is where the
// cancelled accounts that feed churn live. The unbounded `families` read beside
// it labelled any family past the thousandth "Unknown family".
const CAP = 1000;
const ACTIVE = 1300;
const CANCELED = 200;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown, invoices: [] as Record<string, unknown>[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
// The Billing tab lists Stripe's latest invoices; Stripe answers from here.
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ invoices: { list: async () => ({ data: h.invoices }) } }),
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));

let db: InMemorySupabase;

function seedPlatform() {
  const now = Date.UTC(2026, 9, 22, 12);
  // 200 subscriptions cancelled within the last 30 days, created BEFORE every
  // active one, so a newest-first read of a thousand never reaches them.
  const canceled = Array.from({ length: CANCELED }, (_, i) => ({
    id: `sub-c-${pad(i)}`, family_id: `fam-c-${pad(i)}`, plan: 'plus', status: 'canceled', seats: 5,
    created_at: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
    updated_at: new Date(now - 5 * 86_400_000).toISOString(),
    current_period_end: null,
  }));
  const active = Array.from({ length: ACTIVE }, (_, i) => ({
    id: `sub-a-${pad(i)}`, family_id: `fam-a-${pad(i)}`, plan: 'plus', status: 'active', seats: 5,
    created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
    updated_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
    current_period_end: null,
  }));
  db.seed('subscriptions', [...canceled, ...active]);
  // Families in the order they were created: the newest subscriptions belong to
  // the LAST families, which an unordered read of a thousand never reaches.
  db.seed('families', [
    ...canceled.map((s, i) => ({ id: s.family_id, name: `Cancelled family ${i}` })),
    ...active.map((s, i) => ({ id: s.family_id, name: `Family ${i}` })),
  ]);
  db.seed('billing_customers', []);
}

async function render(tab?: string): Promise<string> {
  const { default: AdminSubscriptionsPage } = await import('@/app/(app)/admin/subscriptions/page');
  return renderServerPage(await AdminSubscriptionsPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  h.invoices = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin/subscriptions reduces over every subscription, not the newest thousand', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('subscriptions').select('*').order('created_at', { ascending: false });
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('active subscriptions, MRR and ARR are platform totals', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.activeSubscriptions'])).toBe('1,300');
    expect(statCardValue(html, 'MRR')).toBe(fmtMoney(ACTIVE * PLUS_MONTHLY_CENTS));
    expect(statCardValue(html, 'ARR')).toBe(fmtMoney(ACTIVE * PLUS_MONTHLY_CENTS * 12));
    // The plan card and the donut take the same per-plan count.
    expect(html).toContain('1,300 active');
  });

  it('churn sees the cancelled accounts past the cap', async () => {
    seedPlatform();
    const html = await render();
    // 200 cancelled in the last 30 days over 1,300 active + 200 cancelled.
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.churn30d'])).toBe(`${((CANCELED / (ACTIVE + CANCELED)) * 100).toFixed(1)}%`);
  });

  it('a recent subscription names its family even past a thousand families', async () => {
    seedPlatform();
    const html = await render();
    expect(html).toContain(`Family ${ACTIVE - 1}`);
    expect(html).not.toContain('Unknown family');
  });

  it('the All tab counts and lists every subscription', async () => {
    seedPlatform();
    const html = await render('all');
    expect(html).toContain(`(${ACTIVE + CANCELED})`);
    expect(html).toContain('Cancelled family 0');
    expect(html).not.toContain('Unknown family');
  });

  it('the Billing tab names the family of an invoice whose customer is past the first thousand (R1-SUBS-BILLING-CUSTOMERS)', async () => {
    seedPlatform();
    // One Stripe customer per active family; Stripe's latest invoices belong to the newest, the last rows.
    db.replace('billing_customers', Array.from({ length: ACTIVE }, (_, i) => ({
      id: `bc-${pad(i)}`, family_id: `fam-a-${pad(i)}`, provider: 'stripe', customer_ref: `cus_${pad(i)}`,
    })));
    h.invoices = Array.from({ length: 20 }, (_, k) => {
      const i = ACTIVE - 1 - k;
      return { id: `in_${pad(i)}`, number: `INV-${i}`, amount_paid: PLUS_MONTHLY_CENTS, status: 'paid', created: 1_790_000_000 - k, customer: `cus_${pad(i)}`, hosted_invoice_url: null };
    });
    const html = await render('billing');
    expect(html).toContain(`<span class="font-medium">Family ${ACTIVE - 1}</span>`);
    expect(html).toContain(`<span class="font-medium">Family ${ACTIVE - 20}</span>`);
    expect(html).not.toContain('Unknown family');
  });

  it('a billing customer read that fails is the read-error state, not "Unknown family"', async () => {
    seedPlatform();
    h.invoices = [{ id: 'in_1', number: 'INV-1', amount_paid: PLUS_MONTHLY_CENTS, status: 'paid', created: 1_790_000_000, customer: 'cus_1', hosted_invoice_url: null }];
    h.db = withFaults(db, (table) => (table === 'billing_customers' ? { message: 'billing_customers unavailable' } : null));
    const html = await render('billing');
    expect(html).toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(html).not.toContain('Unknown family');
  });
});

// The family names came from ONE read of the whole families table, paged to
// the 25,000-row ceiling of the counted subscription read, and reaching it
// returned the read-error state: past 25,000 families the page lost every
// subscription row and tile, where it used to render (review
// R5-FAMILIES-LABEL-CEILING-LOCKS-PAGES). It only ever labelled rows, so each
// listed subscription and invoice is now named from its own family.
describe('/admin/subscriptions past 25,000 families', () => {
  const CEILING = 25_000;
  const SUBSCRIBERS = 12;
  const named = (i: number) => `<span class="font-medium">Subscriber family ${i}</span>`;

  // 25,001 families with no subscription sort first by id; the subscribers'
  // families sort after them, past the first 25,000.
  function seedPastTheFamilyCeiling() {
    db.seed('families', [
      ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Free family ${i}` })),
      ...Array.from({ length: SUBSCRIBERS }, (_, i) => ({ id: `fam-zz-${pad(i)}`, name: `Subscriber family ${i}` })),
    ]);
    db.seed('subscriptions', Array.from({ length: SUBSCRIBERS }, (_, i) => {
      const createdAt = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
      return { id: `sub-${pad(i)}`, family_id: `fam-zz-${pad(i)}`, plan: 'plus', status: 'active', seats: 5, created_at: createdAt, updated_at: createdAt, current_period_end: null };
    }));
    db.seed('billing_customers', [
      ...Array.from({ length: SUBSCRIBERS }, (_, i) => ({ id: `bc-${pad(i)}`, family_id: `fam-zz-${pad(i)}`, provider: 'stripe', customer_ref: `cus_${pad(i)}` })),
      // A family past the 25,000th by id that pays an invoice without a subscription row.
      { id: 'bc-free', family_id: `fam-${pad(CEILING)}`, provider: 'stripe', customer_ref: 'cus_free' },
    ]);
  }

  it('the Plans tab renders its tiles and names each recent subscription\'s family', async () => {
    seedPastTheFamilyCeiling();
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.activeSubscriptions'])).toBe(String(SUBSCRIBERS));
    expect(statCardValue(html, 'MRR')).toBe(fmtMoney(SUBSCRIBERS * PLUS_MONTHLY_CENTS));
    // The newest eight, newest first.
    for (let i = SUBSCRIBERS - 8; i < SUBSCRIBERS; i++) expect(html).toContain(named(i));
    expect(html).not.toContain(named(SUBSCRIBERS - 9));
    expect(html).not.toContain('Unknown family');
  });

  it('the All tab lists every subscription under its family', async () => {
    seedPastTheFamilyCeiling();
    const html = await render('all');
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(html).toContain(`(${SUBSCRIBERS})`);
    for (let i = 0; i < SUBSCRIBERS; i++) expect(html).toContain(`<td class="px-3 py-2.5 font-medium">Subscriber family ${i}</td>`);
    expect(html).not.toContain('Unknown family');
  });

  it('the Billing tab names each invoice\'s family, with or without a subscription', async () => {
    seedPastTheFamilyCeiling();
    h.invoices = [
      { id: 'in_sub', number: 'INV-SUB', amount_paid: PLUS_MONTHLY_CENTS, status: 'paid', created: 1_790_000_000, customer: `cus_${pad(SUBSCRIBERS - 1)}`, hosted_invoice_url: null },
      { id: 'in_free', number: 'INV-FREE', amount_paid: PLUS_MONTHLY_CENTS, status: 'paid', created: 1_789_999_000, customer: 'cus_free', hosted_invoice_url: null },
    ];
    const html = await render('billing');
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(html).toContain(named(SUBSCRIBERS - 1));
    expect(html).toContain(`<span class="font-medium">Free family ${CEILING}</span>`);
    expect(html).not.toContain('Unknown family');
  });

  it('a family label read that fails is still the read-error state', async () => {
    seedPastTheFamilyCeiling();
    h.db = withFaults(db, (table) => (table === 'families' ? { message: 'families unavailable' } : null));
    for (const tab of ['plans', 'all']) {
      const html = await render(tab);
      expect(html).toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
      expect(html).not.toContain('Subscriber family');
    }
  });
});

// Every subscription row was read on every tab, paged to the 25,000-row
// ceiling with reaching it an error, so past 25,000 subscriptions the Plans and
// Billing tabs were the read-error state for rows neither lists, where the base
// page rendered (review R5-SIB-SUBSCRIPTION-ROWS-LOCK-PLANS-AND-BILLING). Plans
// now reads its counts, the chart's own window and its eight recent rows;
// Billing reads no subscription; only the All tab, which lists them all, keeps
// the ceiling as its own read-error state.
describe('/admin/subscriptions past 25,000 subscriptions', () => {
  const CEILING = 25_000;
  /** Subscriptions inside the growth chart's thirty days; the rest are from 2025. */
  const RECENT = 40;
  const named = (i: number) => `<span class="font-medium">New family ${i}</span>`;
  const notShownTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() });

  /** 25,001 active Plus subscriptions; the newest RECENT were taken out in October 2026. */
  function seedPastTheSubscriptionCeiling(): string[] {
    const old = Array.from({ length: CEILING + 1 - RECENT }, (_, i) => {
      const createdAt = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
      return { id: `sub-o-${pad(i)}`, family_id: `fam-o-${pad(i)}`, plan: 'plus', status: 'active', seats: 5, created_at: createdAt, updated_at: createdAt, current_period_end: null };
    });
    const recent = Array.from({ length: RECENT }, (_, i) => {
      const createdAt = new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString();
      return { id: `sub-n-${pad(i)}`, family_id: `fam-n-${pad(i)}`, plan: 'plus', status: 'active', seats: 5, created_at: createdAt, updated_at: createdAt, current_period_end: null };
    });
    db.seed('subscriptions', [...old, ...recent]);
    db.seed('families', recent.map((s, i) => ({ id: s.family_id, name: `New family ${i}` })));
    db.seed('billing_customers', [{ id: 'bc-n', family_id: `fam-n-${pad(RECENT - 1)}`, provider: 'stripe', customer_ref: 'cus_newest' }]);
    return db.table('subscriptions').map((s) => String(s.created_at));
  }
  const invoice = { id: 'in_newest', number: 'INV-NEWEST', amount_paid: PLUS_MONTHLY_CENTS, status: 'paid', created: 1_790_000_000, customer: 'cus_newest', hosted_invoice_url: null };

  it('the Plans tab renders every tile, the chart of every subscription and the eight newest rows', async () => {
    const timestamps = seedPastTheSubscriptionCeiling();
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.activeSubscriptions'])).toBe((CEILING + 1).toLocaleString());
    expect(statCardValue(html, 'MRR')).toBe(fmtMoney((CEILING + 1) * PLUS_MONTHLY_CENTS));
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.churn30d'])).toBe('0.0%');
    expect(html).toContain(`${(CEILING + 1).toLocaleString()} active`);
    // The chart every subscription draws: a count before its first day, and the rows inside it.
    expect(html).toContain(renderToStaticMarkup(createElement(GrowthChart, { timestamps })));
    // The eight newest, newest first, each under its own family.
    for (let i = RECENT - 8; i < RECENT; i++) expect(html).toContain(named(i));
    expect(html).not.toContain(named(RECENT - 9));
    expect(at(html, named(RECENT - 1))).toBeLessThan(at(html, named(RECENT - 8)));
    expect(html).not.toContain('Unknown family');
    expect(html).not.toContain(notShownTitle());
  });

  it('the Billing tab lists its invoices and reads no subscription row', async () => {
    seedPastTheSubscriptionCeiling();
    h.invoices = [invoice];
    db.log.length = 0;
    const html = await render('billing');
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(html).toContain('INV-NEWEST');
    expect(html).toContain(named(RECENT - 1));
    expect(db.log.filter((entry) => entry.table === 'subscriptions')).toEqual([]);
  });

  it('the All tab, which lists every subscription, is still its own read-error state past the ceiling', async () => {
    seedPastTheSubscriptionCeiling();
    const html = await render('all');
    expect(html).toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(html).toContain('href="/admin/subscriptions?tab=all"');
  });

  it('past the ceiling inside the chart\'s thirty days the chart alone is not shown, and says so', async () => {
    db.seed('subscriptions', Array.from({ length: CEILING + 1 }, (_, i) => {
      const createdAt = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
      return { id: `sub-${pad(i)}`, family_id: `fam-${pad(i)}`, plan: 'plus', status: 'active', seats: 5, created_at: createdAt, updated_at: createdAt, current_period_end: null };
    }));
    db.seed('families', Array.from({ length: 8 }, (_, k) => ({ id: `fam-${pad(CEILING - k)}`, name: `Newest family ${k}` })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminSubscriptions.activeSubscriptions'])).toBe((CEILING + 1).toLocaleString());
    expect(html).toContain('<span class="font-medium">Newest family 0</span>');
    expect(html).not.toContain('id="growthFill"');
    expect(html).toContain(`<p class="text-sm text-muted">${SOURCE_MESSAGES['strategyMetrics.unavailable']}</p>`);
    const banner = html.slice(at(html, notShownTitle()));
    expect(banner.slice(0, banner.indexOf('</ul>'))).toContain(`<li>${SOURCE_MESSAGES['adminSubscriptions.subscriptionsOverTime']}</li>`);
  });

  it('a subscription read that FAILS is still the read-error state on Plans, and costs Billing nothing', async () => {
    seedPastTheSubscriptionCeiling();
    h.invoices = [invoice];
    h.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: 'subscriptions unavailable' } : null));
    const plans = await render();
    expect(plans).toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(plans).not.toContain('New family');
    const billing = await render('billing');
    expect(billing).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(billing).toContain('INV-NEWEST');
  });

  it('the control: under the ceiling the All tab lists every subscription and Plans says nothing is missing', async () => {
    seedPlatform();
    const all = await render('all');
    expect(all).not.toContain(SOURCE_MESSAGES['subscriptions.couldNotLoadSubscriptionData']);
    expect(all).toContain(`(${ACTIVE + CANCELED})`);
    expect(await render()).not.toContain(notShownTitle());
  });
});
