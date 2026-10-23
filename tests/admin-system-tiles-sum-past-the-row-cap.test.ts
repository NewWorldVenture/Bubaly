import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// /admin/system paged `profiles` through readAllAsQuery and, in the same batch,
// read `subscriptions.select('plan, status')` and `documents.select('size_bytes')`
// with no bound at all. PostgREST caps both at 1,000 rows with no error, so the
// Monthly revenue tile summed the first thousand subscriptions and the Storage
// tile the first thousand documents, both rendered as platform totals and with
// no banner — the banner names FAILED reads, and a capped read does not fail.
const CAP = 1000;
const ROWS = 1300;
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
  checkAuth: async () => up('Auth'),
  checkStripe: async () => up('Billing'),
  checkEmail: () => up('Email'),
}));

let db: InMemorySupabase;

function seedPlatform() {
  db.seed('profiles', Array.from({ length: 3 }, (_, i) => ({ id: `usr-${pad(i)}`, created_at: '2026-10-01T00:00:00Z' })));
  db.seed('families', Array.from({ length: 3 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Family ${i}` })));
  db.seed('subscriptions', Array.from({ length: ROWS }, (_, i) => ({
    id: `sub-${pad(i)}`, family_id: `fam-${pad(i % 3)}`, plan: 'plus', status: 'active',
  })));
  db.seed('documents', Array.from({ length: ROWS }, (_, i) => ({
    id: `doc-${pad(i)}`, family_id: `fam-${pad(i % 3)}`, size_bytes: 1_000,
  })));
}

async function render(): Promise<string> {
  const { default: AdminSystemPage } = await import('@/app/(app)/admin/system/page');
  return renderServerPage(await AdminSystemPage());
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

describe('/admin/system sums revenue and storage over every row', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('documents').select('size_bytes');
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('Monthly revenue is every active subscription, not the first thousand', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.monthlyRevenue'])).toBe(fmtMoney(ROWS * PLUS_MONTHLY_CENTS));
  });

  it('Storage used is every document, not the first thousand', async () => {
    seedPlatform();
    const html = await render();
    // 1,300 × 1,000 bytes is 1.2 MB; the first thousand alone is 977 KB.
    expect(html).toContain(`>1.2 MB</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminSystem.documentStorageUsedAcrossEveryFamily']}`);
    expect(html).not.toContain('977 KB');
    // And it is the real number, not a degraded render that happened to add up.
    expect(html).not.toContain('System overview is incomplete');
  });
});
