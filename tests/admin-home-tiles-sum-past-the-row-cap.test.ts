import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { BASIC_MONTHLY_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';
import { at } from './helpers/source-order';

// The /admin dashboard home reduced its tiles from plain selects with no bound:
// every family, every active member, every subscription, every document's
// size, the 30-day new members and every support ticket's status. PostgREST
// answers each with at most 1,000 rows and no error, so past a thousand rows
// Monthly revenue read "from 1000 active plans", the storage gauge summed the
// first thousand documents, the plan donut and Top families saw the first
// thousand families and members, the trend the first thousand subscriptions and
// Support the first thousand tickets — each as the platform's total, with no
// banner, because a capped read does not fail.
const CAP = 1000;
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
// Live connectivity checks have their own coverage; here every system is up.
const up = (name: string) => ({ name, ok: true, latencyMs: 1, detail: 'Operational' });
vi.mock('@/lib/server/health', () => ({
  checkDatabase: async () => up('Database'),
  checkStorage: async () => up('Storage'),
  checkEmail: () => up('Email'),
  checkAI: () => up('AI'),
}));

let db: InMemorySupabase;

const FAMILIES = 1500;
const ACTIVE_PLUS = 1300;
const CANCELED_BASIC = 200;
const MEMBERS = 1300;
const DOCS = 1300;

function seedPlatform() {
  // 1,500 families: the first 200 cancelled their Basic plan in September, the
  // other 1,300 are on an active Family+ plan they took out in October.
  db.seed('families', Array.from({ length: FAMILIES }, (_, i) => ({
    id: `fam-${pad(i)}`, name: `Family ${i}`, created_at: '2025-03-01T00:00:00Z',
  })));
  db.seed('subscriptions', [
    ...Array.from({ length: CANCELED_BASIC }, (_, i) => ({
      id: `sub-c-${pad(i)}`, family_id: `fam-${pad(i)}`, plan: 'basic', status: 'canceled', created_at: '2026-09-10T00:00:00Z',
    })),
    ...Array.from({ length: ACTIVE_PLUS }, (_, i) => ({
      id: `sub-p-${pad(i)}`, family_id: `fam-${pad(CANCELED_BASIC + i)}`, plan: 'plus', status: 'active', created_at: '2026-10-05T00:00:00Z',
    })),
  ]);
  // 1,300 members who joined on 10 October: the first thousand, one in each of
  // the first thousand families; the last 300 all in the LAST family, which is
  // therefore the biggest and the one a thousand-row read never sees.
  db.seed('family_members', Array.from({ length: MEMBERS }, (_, i) => ({
    id: `mem-${pad(i)}`, family_id: i < CAP ? `fam-${pad(i)}` : `fam-${pad(FAMILIES - 1)}`,
    is_active: true, display_name: `Member ${i}`, created_at: '2026-10-10T00:00:00Z',
  })));
  db.seed('documents', Array.from({ length: DOCS }, (_, i) => ({
    id: `doc-${pad(i)}`, family_id: `fam-${pad(i % FAMILIES)}`, size_bytes: 1_000,
  })));
  db.seed('support_tickets', [
    ...Array.from({ length: 1300 }, (_, i) => ({ id: `tkt-o-${pad(i)}`, status: 'open' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `tkt-p-${pad(i)}`, status: 'pending' })),
    ...Array.from({ length: 1100 }, (_, i) => ({ id: `tkt-r-${pad(i)}`, status: 'resolved' })),
    ...Array.from({ length: 100 }, (_, i) => ({ id: `tkt-x-${pad(i)}`, status: 'closed' })),
  ]);
}

async function render(): Promise<string> {
  const { default: AdminDashboardPage } = await import('@/app/(app)/admin/page');
  return renderServerPage(await AdminDashboardPage());
}

/** The value and the line beneath an admin-home StatCard labelled `label`. */
function statCard(html: string, label: string): { value: string; sub: string } {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`leading-none">([^<]*)</p><p class="mt-1 text-xs font-medium text-muted">${escaped}</p><p class="mt-0.5 text-\\[11px\\] text-muted">([^<]*)</p>`).exec(html);
  if (!match) throw new Error(`the "${label}" tile is not on the page`);
  return { value: match[1], sub: match[2] };
}

/** The items the ceiling banner names, or null when it is not shown. */
function ceilingBanner(html: string): string[] | null {
  const title = translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: (25_000).toLocaleString() });
  const start = html.indexOf(`<p class="text-sm font-semibold text-danger">${title}</p>`);
  if (start < 0) return null;
  return [...html.slice(start, html.indexOf('</ul>', start)).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

/** The markup of the Card whose heading is `heading`, up to the next card. */
function card(html: string, heading: string): string {
  // The heading itself, not the ceiling banner's item of the same words.
  let start = html.indexOf(heading);
  while (start >= 0 && html.slice(start - 4, start) === '<li>') start = html.indexOf(heading, start + 1);
  if (start < 0) throw new Error(`no "${heading}" card on the page`);
  const end = html.indexOf('<div class="glass-card', start);
  return html.slice(start, end < 0 ? undefined : end);
}

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

describe('/admin adds up its tiles over every row, not the first thousand', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('subscriptions').select('family_id, plan, status, created_at');
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('Monthly revenue is every active plan', async () => {
    seedPlatform();
    const html = await render();
    expect(statCard(html, SOURCE_MESSAGES['admin.monthlyRevenue'])).toEqual({
      value: fmtMoney(ACTIVE_PLUS * PLUS_MONTHLY_CENTS),
      sub: `from ${ACTIVE_PLUS} active plans`,
    });
    // And it is the real number, not a degraded render that happened to add up.
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
  });

  it('new this month counts every member who joined this month', async () => {
    seedPlatform();
    const html = await render();
    expect(statCard(html, SOURCE_MESSAGES['admin.activeUsers']).sub)
      .toBe(translate(SOURCE_MESSAGES, 'admin.newThisMonth', { n: MEMBERS }));
    // The growth sparkline's headline is the same 30 days, read whole.
    expect(textOf(card(html, SOURCE_MESSAGES['admin.userGrowth']))).toContain(`+${MEMBERS}`);
  });

  it('the storage gauge sums every document', async () => {
    seedPlatform();
    const html = await render();
    // 1,300 × 1,000 bytes is 1.2 MB; the first thousand alone is 977 KB.
    expect(card(html, SOURCE_MESSAGES['admin.storageUsage'])).toContain('>1.2 MB</text>');
    expect(html).not.toContain('977 KB');
  });

  it('the plan donut places every family', async () => {
    seedPlatform();
    const html = await render();
    const donut = card(html, SOURCE_MESSAGES['admin.planDistribution']);
    expect(donut).toContain(`font-weight="bold">${FAMILIES}</text>`);
    expect(textOf(donut)).toContain(`Family+ ${ACTIVE_PLUS}`);
    expect(textOf(donut)).toContain(`Bubaly Free ${FAMILIES - ACTIVE_PLUS}`);
  });

  it('Top families tallies every active member and names a family past the thousandth', async () => {
    seedPlatform();
    const html = await render();
    const top = card(html, SOURCE_MESSAGES['admin.topFamilies']);
    const first = top.slice(top.indexOf('<li'), top.indexOf('</li>'));
    expect(textOf(first)).toContain(`Family ${FAMILIES - 1} ${MEMBERS - CAP} members`);
    expect(textOf(top)).not.toContain('Unknown');
  });

  it('the revenue trend adds up every new subscription in each month', async () => {
    seedPlatform();
    const html = await render();
    const trend = card(html, SOURCE_MESSAGES['admin.revenueOverview']);
    expect(trend).toContain(`title="${fmtMoney(ACTIVE_PLUS * PLUS_MONTHLY_CENTS)}"`);
    expect(trend).toContain(`title="${fmtMoney(CANCELED_BASIC * BASIC_MONTHLY_CENTS)}"`);
  });

  it('Support counts every ticket in each status', async () => {
    seedPlatform();
    const html = await render();
    const support = textOf(card(html, SOURCE_MESSAGES['admin.supportOverview']));
    expect(support).toContain('Open 1300');
    expect(support).toContain('Pending 20');
    // Resolved has always included closed tickets.
    expect(support).toContain('Resolved 1200');
  });

  // Reaching the ceiling costs that figure, not a zero beside a banner: the
  // gauge says it is not shown and the ceiling banner names it (review
  // R5-SIB-HOME-FAMILY-NAMES brings every summed read here into that class).
  it('a read that reaches its ceiling is named in the ceiling banner and its figure is not shown, not rendered as a smaller platform', async () => {
    seedPlatform();
    db.seed('documents', Array.from({ length: 25_001 - DOCS }, (_, i) => ({
      id: `doc-x-${pad(i)}`, family_id: 'fam-000000', size_bytes: 1_000,
    })));
    const html = await render();
    const storage = card(html, SOURCE_MESSAGES['admin.storageUsage']);
    expect(storage).toContain(`<p class="text-sm text-muted">${SOURCE_MESSAGES['strategyMetrics.unavailable']}</p>`);
    expect(storage).not.toContain('</text>');
    expect(ceilingBanner(html)).toEqual([SOURCE_MESSAGES['admin.storageUsage']]);
    // Nothing failed: the rest of the dashboard is whole.
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(statCard(html, SOURCE_MESSAGES['admin.monthlyRevenue']).value).toBe(fmtMoney(ACTIVE_PLUS * PLUS_MONTHLY_CENTS));
  });

  it('a documents read that FAILS is still named in the read banner', async () => {
    seedPlatform();
    h.db = withFaults(db, (table) => (table === 'documents' ? { message: 'documents unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(textOf(html)).toContain('documents: documents unavailable');
    expect(ceilingBanner(html)).toBeNull();
  });
});

// Top families and Recent activities were named from the plan donut's read of
// every family, so past its 25,000-row ceiling the thirteen listed rows read
// "Unknown" (review R5-SIB-HOME-FAMILY-NAMES). Each listed row is now named
// from its own family; the ceiling costs the donut, which says so.
describe('/admin past 25,000 families', () => {
  const CEILING = 25_000;
  const OWNERS = 3;

  /** 25,001 empty families sorting first by id; three owner families after them with members and audit rows. */
  function seedPastTheFamilyCeiling() {
    db.seed('families', [
      ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Empty family ${i}`, created_at: '2025-03-01T00:00:00Z' })),
      ...Array.from({ length: OWNERS }, (_, f) => ({ id: `fam-zz-${pad(f)}`, name: `Owner family ${f}`, created_at: '2025-03-01T00:00:00Z' })),
    ]);
    // Owner family f has 10 + f members, so they rank 2, 1, 0.
    db.seed('family_members', Array.from({ length: OWNERS }, (_, f) => Array.from({ length: 10 + f }, (_, i) => ({
      id: `mem-${f}-${pad(i)}`, family_id: `fam-zz-${pad(f)}`, is_active: true, display_name: `Member ${f}.${i}`, created_at: '2026-10-10T00:00:00Z',
    }))).flat());
    db.seed('audit_logs', Array.from({ length: 8 }, (_, i) => ({
      id: `log-${pad(i)}`, family_id: `fam-zz-${pad(i % OWNERS)}`, actor_id: null, action: 'update', resource: 'chores',
      created_at: new Date(Date.UTC(2026, 9, 21) + i * 60_000).toISOString(),
    })));
    for (const table of ['subscriptions', 'documents', 'support_tickets', 'admin_notifications']) db.seed(table, []);
  }

  it('Top families and Recent activities name each listed row\'s family; the donut alone is not shown', async () => {
    seedPastTheFamilyCeiling();
    const html = await render();
    const top = card(html, SOURCE_MESSAGES['admin.topFamilies']);
    const row = (f: number) => `<span class="min-w-0 flex-1 truncate text-sm font-medium">Owner family ${f}</span><span class="shrink-0 text-xs text-muted">${10 + f} members</span>`;
    expect(at(top, row(2))).toBeLessThan(at(top, row(1)));
    expect(at(top, row(1))).toBeLessThan(at(top, row(0)));
    expect(textOf(top)).not.toContain('Unknown');
    const activity = card(html, SOURCE_MESSAGES['admin.recentActivities']);
    for (let f = 0; f < OWNERS; f++) expect(activity).toContain(`<p class="truncate text-xs text-muted">Owner family ${f}</p>`);
    expect(activity).not.toContain('Unknown family');
    expect(card(html, SOURCE_MESSAGES['admin.planDistribution'])).toContain(SOURCE_MESSAGES['strategyMetrics.unavailable']);
    expect(ceilingBanner(html)).toEqual([SOURCE_MESSAGES['admin.planDistribution']]);
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
  });

  it('a family name read that FAILS is still named in the read banner', async () => {
    seedPastTheFamilyCeiling();
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'in') ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(textOf(html)).toContain('family names: families unavailable');
  });

  it('each other summed figure past its ceiling is not shown, and is named', async () => {
    seedPlatform();
    const many = CEILING + 1;
    db.seed('subscriptions', Array.from({ length: many }, (_, i) => ({ id: `sub-x-${pad(i)}`, family_id: `fam-x-${pad(i)}`, plan: 'plus', status: 'active', created_at: '2026-10-06T00:00:00Z' })));
    db.seed('family_members', Array.from({ length: many }, (_, i) => ({ id: `mem-x-${pad(i)}`, family_id: `fam-x-${pad(i)}`, is_active: true, display_name: `X ${i}`, created_at: '2026-10-11T00:00:00Z' })));
    const html = await render();
    expect(statCard(html, SOURCE_MESSAGES['admin.monthlyRevenue'])).toEqual({ value: SOURCE_MESSAGES['strategyMetrics.unavailable'], sub: '' });
    for (const heading of ['admin.userGrowth', 'admin.topFamilies', 'admin.planDistribution', 'admin.revenueOverview']) {
      expect(card(html, SOURCE_MESSAGES[heading])).toContain(`<p class="text-sm text-muted">${SOURCE_MESSAGES['strategyMetrics.unavailable']}</p>`);
    }
    expect(ceilingBanner(html)).toEqual(['admin.monthlyRevenue', 'admin.userGrowth', 'admin.topFamilies', 'admin.planDistribution', 'admin.revenueOverview'].map((k) => SOURCE_MESSAGES[k]));
    // The counted tiles are exact and stay.
    expect(statCard(html, SOURCE_MESSAGES['admin.subscriptions']).value).toBe((ACTIVE_PLUS + many).toLocaleString());
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
  });

  it('the control: under every ceiling no figure is withheld', async () => {
    seedPlatform();
    expect(ceilingBanner(await render())).toBeNull();
  });
});
