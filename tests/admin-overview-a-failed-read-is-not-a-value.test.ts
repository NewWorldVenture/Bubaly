import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin renders when a read fails, and names it in a banner — but every
// figure and list below the banner defaulted the failed read with `?? 0` or
// `?? []`, so a failed count read 0, a failed sum $0.00 or 0 B, the failed
// notification feed "You're all caught up" and the failed audit read "No
// activity recorded yet", each looking exactly like the real thing (coverage
// sweep round 9, class A). A read that fails is now Unavailable where it is a
// figure and the read-error state where it is a list; the rest of the page is
// unchanged. The REAL page over the in-memory database with PostgREST's cap.
const CAP = 1000;

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
const up = (name: string) => ({ name, ok: true, latencyMs: 1, detail: 'Operational' });
vi.mock('@/lib/server/health', () => ({
  checkDatabase: async () => up('Database'),
  checkStorage: async () => up('Storage'),
  checkEmail: () => up('Email'),
  checkAI: () => up('AI'),
}));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];

function seed() {
  db.seed('families', [
    { id: 'fam-a', name: 'Avery family', created_at: '2026-10-02T00:00:00Z' },
    { id: 'fam-b', name: 'Blake family', created_at: '2025-03-01T00:00:00Z' },
  ]);
  db.seed('family_members', [
    { id: 'mem-1', family_id: 'fam-a', is_active: true, created_at: '2026-10-03T00:00:00Z' },
    { id: 'mem-2', family_id: 'fam-a', is_active: true, created_at: '2025-03-01T00:00:00Z' },
    { id: 'mem-3', family_id: 'fam-b', is_active: true, created_at: '2025-03-01T00:00:00Z' },
  ]);
  db.seed('subscriptions', [{ id: 'sub-a', family_id: 'fam-a', plan: 'plus', status: 'active', created_at: '2026-10-04T00:00:00Z' }]);
  db.seed('documents', [{ id: 'doc-1', size_bytes: 2048 }]);
  db.seed('audit_logs', [{ id: 'log-1', family_id: 'fam-a', actor_id: 'usr-1', action: 'update', resource: 'chore', created_at: '2026-10-20T10:00:00Z' }]);
  db.seed('profiles', [{ id: 'usr-1', full_name: 'Avery Parent', email: 'avery@example.com' }]);
  db.seed('support_tickets', [{ id: 'tk-1', status: 'open' }, { id: 'tk-2', status: 'resolved' }]);
  db.seed('admin_notifications', [
    { id: 'n-1', kind: 'feedback', title: 'A new idea', body: null, url: null, is_read: false, created_at: '2026-10-21T00:00:00Z' },
    { id: 'n-2', kind: 'feedback', title: 'An older idea', body: null, url: null, is_read: true, created_at: '2026-10-20T00:00:00Z' },
  ]);
}

async function render(): Promise<string> {
  const { default: AdminDashboardPage } = await import('@/app/(app)/admin/page');
  return textOf(await renderServerPage(await AdminDashboardPage()));
}

const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
const selects = (calls: FaultCall[], columns: string) => calls.some((c) => c.method === 'select' && c.args[0] === columns);
const uses = (calls: FaultCall[], method: string) => calls.some((c) => c.method === method);
const tile = (value: string, label: string, sub: string) => `${value} ${m(label)} ${sub}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin: a read that FAILS is Unavailable or the read-error state, not a value', () => {
  // [what fails, its table, the reads of it that fail, what the page shows instead, what it no longer shows]
  const CASES: [string, string, (calls: FaultCall[]) => boolean, string[], string[]][] = [
    ['the family count', 'families', (c) => head(c) && !uses(c, 'gte'),
      [tile(unavailable, 'admin.totalFamilies', m('admin.newThisMonth', { n: 1 }))], ['0 Total families']],
    ['the families new this month', 'families', (c) => head(c) && uses(c, 'gte'),
      [tile('2', 'admin.totalFamilies', unavailable)], [m('admin.newThisMonth', { n: 0 })]],
    ['the active member count', 'family_members', (c) => head(c) && !uses(c, 'gte'),
      [tile(unavailable, 'admin.activeUsers', m('admin.newThisMonth', { n: 1 })), tile('1', 'admin.subscriptions', unavailable)], ['0 active members']],
    ['the members new this month', 'family_members', (c) => head(c) && uses(c, 'gte'),
      [tile('3', 'admin.activeUsers', unavailable)], []],
    ['the active subscription count', 'subscriptions', head,
      [tile(unavailable, 'admin.subscriptions', '3 active members')], []],
    ['the active subscriptions summed for revenue and the donut', 'subscriptions', (c) => selects(c, 'id, family_id, plan'),
      [`${unavailable} ${m('admin.monthlyRevenue')}`, `${m('admin.planDistribution')} ${unavailable}`], [fmtMoney(0)]],
    ['the six months of new subscriptions', 'subscriptions', (c) => selects(c, 'id, plan, created_at'),
      [`${m('admin.revenueOverview')} ${unavailable}`], []],
    ['the documents summed for storage', 'documents', () => true,
      [`${m('admin.storageUsage')} ${unavailable}`], ['0 B']],
    ['the new members drawn on the growth line', 'family_members', (c) => selects(c, 'id, created_at'),
      [`${m('admin.userGrowth')} ${unavailable}`], ['+0']],
    ['the active members tallied for Top families', 'family_members', (c) => selects(c, 'id, family_id'),
      [`${m('admin.topFamilies')} ${m('admin.viewAll')} ${unavailable}`], []],
    ['the families tallied for the plan donut', 'families', (c) => selects(c, 'id, name') && !uses(c, 'in'),
      [`${m('admin.planDistribution')} ${unavailable}`], []],
    ['the recent audit logs', 'audit_logs', () => true,
      [m('admin.couldNotLoadRecentActivity')], [m('admin.noActivityRecordedYet')]],
    ['the open ticket count', 'support_tickets', (c) => c.some((call) => call.method === 'eq' && call.args[1] === 'open'),
      [`Open ${unavailable} Pending 0 Resolved 1`], []],
    ['the notification feed', 'admin_notifications', (c) => !head(c),
      [m('notifications.couldNotLoadAdminNotifications')], [m('admin.youreAllCaughtUp')]],
    ['the unread notification count', 'admin_notifications', head,
      [`${m('admin.notifications')} ${unavailable} ${m('admin.seeAll')}`], []],
    ['the actors\' names', 'profiles', () => true,
      [`${unavailable} · update chore`], ['System · update chore']],
    ['the listed families\' names', 'families', (c) => uses(c, 'in'),
      [`update chore ${unavailable}`], ['Unknown family']],
  ];

  it.each(CASES)('%s', async (_, table, failing, shown, gone) => {
    seed();
    let faulted = 0;
    h.db = withFaults(db, (name, calls) => {
      if (name !== table || !failing(calls)) return null;
      faulted += 1;
      return { message: `${table} unavailable` };
    });
    const page = await render();
    expect(faulted).toBeGreaterThan(0);
    // The banner still names the read; the page is still the page.
    expect(page).toContain(m('admin.someDataCouldNotBeLoaded'));
    expect(page).not.toContain(m('admin.couldNotLoadTheAdmin'));
    for (const text of shown) expect(page).toContain(text);
    for (const text of gone) expect(page).not.toContain(text);
  });

  it('the control: every read answers, and each figure and list is its value', async () => {
    seed();
    const page = await render();
    expect(page).not.toContain(m('admin.someDataCouldNotBeLoaded'));
    expect(page).not.toContain(unavailable);
    expect(page).toContain(tile('2', 'admin.totalFamilies', m('admin.newThisMonth', { n: 1 })));
    expect(page).toContain(tile('3', 'admin.activeUsers', m('admin.newThisMonth', { n: 1 })));
    expect(page).toContain(tile('1', 'admin.subscriptions', '3 active members'));
    expect(page).toContain(`${fmtMoney(PLUS_MONTHLY_CENTS)} ${m('admin.monthlyRevenue')} from 1 active plans`);
    expect(page).toContain('Avery Parent · update chore Avery family');
    expect(page).toContain(`${m('admin.notifications')} 1 ${m('admin.seeAll')}`);
    expect(page).toContain('A new idea');
    expect(page).toContain('Open 1 Pending 0 Resolved 1');
    expect(page).toContain('Avery family 2 members');
  });
});
