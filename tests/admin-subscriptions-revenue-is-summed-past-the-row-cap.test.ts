import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

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

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
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
});
