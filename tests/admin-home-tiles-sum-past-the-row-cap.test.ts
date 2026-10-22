import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { BASIC_MONTHLY_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

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

/** The markup of the Card whose heading is `heading`, up to the next card. */
function card(html: string, heading: string): string {
  const at = html.indexOf(heading);
  if (at < 0) throw new Error(`no "${heading}" card on the page`);
  const end = html.indexOf('<div class="glass-card', at);
  return html.slice(at, end < 0 ? undefined : end);
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

  it('a read that reaches its ceiling is named in the banner, not rendered as a smaller platform', async () => {
    seedPlatform();
    db.seed('documents', Array.from({ length: 25_001 - DOCS }, (_, i) => ({
      id: `doc-x-${pad(i)}`, family_id: 'fam-000000', size_bytes: 1_000,
    })));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(textOf(html)).toMatch(/documents: readAllById reached the caller’s max of 25000 rows/);
  });
});
