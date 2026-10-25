import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// /admin/system renders degraded when a read fails and names it in a banner,
// but every figure defaulted the failed read: Total users and Active families
// read 0, Monthly revenue $0.00, storage 0 B, the 30-day new users 0 and the
// growth chart a flat line from 0 (coverage sweep round 9, class A). Each now
// reads Unavailable when its own read failed. The REAL page, in-memory
// database with PostgREST's 1,000-row cap.
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
  checkAuth: async () => up('Auth'),
  checkStripe: async () => up('Billing'),
  checkEmail: () => up('Email'),
}));

let db: InMemorySupabase;
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];

function seed() {
  db.seed('profiles', [
    { id: 'usr-1', created_at: '2026-10-10T00:00:00Z' },
    { id: 'usr-2', created_at: '2025-01-01T00:00:00Z' },
  ]);
  db.seed('families', [{ id: 'fam-1', name: 'Family 1' }]);
  db.seed('subscriptions', [{ id: 'sub-1', family_id: 'fam-1', plan: 'plus', status: 'active' }]);
  db.seed('documents', [{ id: 'doc-1', family_id: 'fam-1', size_bytes: 2048 }]);
}

async function render(): Promise<string> {
  const { default: AdminSystemPage } = await import('@/app/(app)/admin/system/page');
  return renderServerPage(await AdminSystemPage());
}

/** The figure above a Usage overview line. */
const usage = (html: string, label: string) =>
  new RegExp(`<p class="text-xl font-bold leading-none">([^<]*)</p><p class="text-xs text-muted">${label}</p>`).exec(html)?.[1];
const chart = (html: string) => textOf(html.slice(html.indexOf(SOURCE_MESSAGES['adminSystem.last30DaysCumulative'])));
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
const uses = (calls: FaultCall[], method: string) => calls.some((c) => c.method === method);

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

describe('/admin/system: a read that FAILS is Unavailable, not 0', () => {
  const CASES: [string, string, (calls: FaultCall[]) => boolean, (html: string) => void][] = [
    ['the user count', 'profiles', (c) => head(c) && !uses(c, 'gte') && !uses(c, 'lt'),
      (html) => expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.totalUsers'])).toBe(unavailable)],
    ['the family count', 'families', head,
      (html) => expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.activeFamilies'])).toBe(unavailable)],
    ['the subscriptions summed for revenue', 'subscriptions', () => true,
      (html) => expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.monthlyRevenue'])).toBe(unavailable)],
    ['the documents summed for storage', 'documents', () => true,
      (html) => expect(usage(html, SOURCE_MESSAGES['adminSystem.documentStorageUsedAcrossEveryFamily'])).toBe(unavailable)],
    ['the new users count', 'profiles', (c) => head(c) && uses(c, 'gte'),
      (html) => expect(usage(html, SOURCE_MESSAGES['adminSystem.newUsersInTheLast30'])).toBe(unavailable)],
    ['the chart\'s rows', 'profiles', (c) => !head(c),
      (html) => expect(chart(html).startsWith(`${SOURCE_MESSAGES['adminSystem.last30DaysCumulative']} ${unavailable}`)).toBe(true)],
    ['the chart\'s base count', 'profiles', (c) => head(c) && uses(c, 'lt'),
      (html) => expect(chart(html).startsWith(`${SOURCE_MESSAGES['adminSystem.last30DaysCumulative']} ${unavailable}`)).toBe(true)],
  ];

  it.each(CASES)('%s', async (_, table, failing, expectUnavailable) => {
    seed();
    let faulted = 0;
    h.db = withFaults(db, (name, calls) => {
      if (name !== table || !failing(calls)) return null;
      faulted += 1;
      return { message: `${table} unavailable` };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(textOf(html)).toContain('System overview is incomplete');
    expectUnavailable(html);
    // One figure, not the page: the others are their values.
    expect(html.split(unavailable).length - 1).toBe(1);
  });

  it('the control: every read answers, and each figure is its value', async () => {
    seed();
    const html = await render();
    expect(textOf(html)).not.toContain('System overview is incomplete');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.totalUsers'])).toBe('2');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.activeFamilies'])).toBe('1');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.monthlyRevenue'])).toBe(fmtMoney(PLUS_MONTHLY_CENTS));
    expect(usage(html, SOURCE_MESSAGES['adminSystem.documentStorageUsedAcrossEveryFamily'])).toBe('2 KB');
    expect(usage(html, SOURCE_MESSAGES['adminSystem.newUsersInTheLast30'])).toBe('1');
    expect(html).not.toContain(unavailable);
  });
});
