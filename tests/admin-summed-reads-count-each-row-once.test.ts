import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// The admin console's totals are read whole, a page at a time — and families
// upload documents, check out, join and get invited WHILE a page reads. Paged
// on offsets (readAllAsQuery), a row written ahead of the next offset pushes
// the last row of one page onto the next, so it is summed or counted twice:
// one document's bytes, one plan's price, one campaign's budget. Paged on the
// id (readAllByIdAsQuery), no write between pages brings a row back.
// tests/a-ledger-read-counts-each-row-once.test.ts shows the mechanism on the
// helpers; this drives each admin page that sums such a read, with one write
// landing between its first and second page.
const CAP = 1000;
const ROWS = 1300;
const GIB = 1024 ** 3;
const pad = (i: number) => String(i).padStart(6, '0');
/** Sorts between the first and second row of a `${prefix}-${pad(i)}` table: below every cursor. */
const early = (prefix: string) => `${prefix}-000000a`;

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
  checkAI: () => up('AI'),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
// Controls that reach for the app router, the toast provider or a server
// action; none carries a number read here.
vi.mock('@/app/(app)/admin/marketing/actions', () => ({ createAdCampaign: async () => {} }));
vi.mock('@/components/admin/document-row-actions', () => ({ DocumentRowActions: () => null }));
vi.mock('@/components/admin/users-toolbar', () => ({ UsersToolbar: () => null }));
vi.mock('@/components/admin/member-row-actions', () => ({ MemberRowActions: () => null }));
vi.mock('@/components/admin/invite-row-actions', () => ({ InviteRowActions: () => null }));
vi.mock('@/components/admin/set-plan-control', () => ({ SetPlanControl: () => null }));
vi.mock('@/components/admin/super-admin-toggle', () => ({ SuperAdminToggle: () => null }));
vi.mock('@/components/admin/role-donut', () => ({ RoleDonut: () => null }));

let db: InMemorySupabase;

type Write = { table: string; read: (columns: string) => boolean; row: Row };

/**
 * Serve the pages a client that writes `row` into `table` just before the
 * SECOND page of the read whose select list `read` recognises — the moment an
 * upload or a checkout lands mid-read. A second page is the one that asks past
 * the first: `gt('id', …)` on the key, `range(1000, …)` on offsets.
 */
function writeBetweenPages(...writes: Write[]): () => string[] {
  const done: string[] = [];
  h.db = withFaults(db, (table, calls) => {
    const write = writes.find((w) => w.table === table && !done.includes(table));
    if (!write) return null;
    const columns = calls.find((c) => c.method === 'select')?.args[0];
    if (typeof columns !== 'string' || !write.read(columns)) return null;
    const nextPage = calls.some((c) => (c.method === 'gt' && c.args[0] === 'id') || (c.method === 'range' && Number(c.args[0]) > 0));
    if (!nextPage) return null;
    db.seed(table, [write.row]);
    done.push(table);
    return null;
  });
  return () => done;
}

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

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

/** 1,300 documents of 1,000 bytes, except the thousandth — the row an offset read repeats — which is 1 GiB. */
function seedDocuments() {
  db.seed('families', Array.from({ length: 3 }, (_, f) => ({ id: `fam-${pad(f)}`, name: `Family ${f}` })));
  db.seed('documents', Array.from({ length: ROWS }, (_, i) => ({
    id: `doc-${pad(i)}`, family_id: `fam-${pad(i % 3)}`, title: `Doc ${i}`, category: 'school',
    storage_path: `fam/${i}.pdf`, mime_type: 'application/pdf', size_bytes: i === CAP - 1 ? GIB : 1_000,
    created_by: null, created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
  })));
}
/** An upload that has not finished: no bytes yet, filed at a uuid that sorts low. */
const uploadInFlight: Write = {
  table: 'documents',
  read: (columns) => columns.includes('size_bytes'),
  row: { id: early('doc'), family_id: 'fam-000000', title: 'Uploading', category: 'school', storage_path: 'fam/new.pdf', mime_type: 'application/pdf', size_bytes: 0, created_by: null },
};

/** On /admin/content, the summed read is the narrow one; the browsable list selects `*`. */
const contentAggregateRead: Write = { ...uploadInFlight, read: (columns) => columns !== '*' && columns.includes('size_bytes') };

describe('a write between two pages is not summed twice', () => {
  it('/admin/system: Monthly revenue and Storage used', async () => {
    seedDocuments();
    db.seed('profiles', [{ id: 'usr-000000', created_at: '2026-10-01T00:00:00Z' }]);
    db.seed('subscriptions', Array.from({ length: ROWS }, (_, i) => ({
      id: `sub-${pad(i)}`, family_id: `fam-${pad(i % 3)}`, plan: 'plus', status: 'active',
    })));
    const wrote = writeBetweenPages(uploadInFlight, {
      // A checkout abandoned before payment: a row, and no revenue.
      table: 'subscriptions', read: () => true,
      row: { id: early('sub'), family_id: 'fam-000001', plan: 'plus', status: 'incomplete' },
    });
    const { default: AdminSystemPage } = await import('@/app/(app)/admin/system/page');
    const html = await renderServerPage(await AdminSystemPage());

    expect(wrote()).toEqual(expect.arrayContaining(['documents', 'subscriptions']));
    expect(statCardValue(html, SOURCE_MESSAGES['adminSystem.monthlyRevenue'])).toBe(fmtMoney(ROWS * PLUS_MONTHLY_CENTS));
    // 1 GiB and 1,299 KB-sized files is 1.00 GB; counting the large one twice is 2.00 GB.
    expect(html).toContain(`>1.00 GB</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminSystem.documentStorageUsedAcrossEveryFamily']}`);
    expect(html).not.toContain('System overview is incomplete');
  });

  it('/admin/content: Storage used', async () => {
    seedDocuments();
    const wrote = writeBetweenPages(contentAggregateRead);
    const { default: AdminContentPage } = await import('@/app/(app)/admin/content/page');
    const html = await renderServerPage(await AdminContentPage({ searchParams: Promise.resolve({}) }));

    expect(wrote()).toEqual(['documents']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.storageUsed'])).toBe('1.00 GB');
  });

  it('/admin/content: the files and bytes per category', async () => {
    seedDocuments();
    const wrote = writeBetweenPages(contentAggregateRead);
    const { default: AdminContentPage } = await import('@/app/(app)/admin/content/page');
    const html = await renderServerPage(await AdminContentPage({ searchParams: Promise.resolve({ tab: 'categories' }) }));

    expect(wrote()).toEqual(['documents']);
    expect(html).toMatch(/school<\/span><span class="text-muted">1300 files · 1\.00 GB/);
  });

  it('/admin/marketing/analytics: channel budgets and email engagement', async () => {
    for (const table of ['families', 'subscriptions', 'family_members', 'profiles']) db.seed(table, []);
    db.seed('marketing_campaigns', Array.from({ length: ROWS }, (_, i) => ({
      id: `camp-${pad(i)}`, name: `Campaign ${i}`, channel: 'email', status: 'active', budget_cents: 100, deleted_at: null,
    })));
    db.seed('marketing_email_campaigns', Array.from({ length: ROWS }, (_, i) => ({
      id: `mail-${pad(i)}`, subject: `Mail ${i}`, status: 'sent', recipients: 10, opens: 2, clicks: 1, deleted_at: null,
    })));
    const wrote = writeBetweenPages(
      { table: 'marketing_campaigns', read: () => true, row: { id: early('camp'), name: 'New', channel: 'social', status: 'draft', budget_cents: 0, deleted_at: null } },
      { table: 'marketing_email_campaigns', read: () => true, row: { id: early('mail'), subject: 'Draft', status: 'draft', recipients: 0, opens: 0, clicks: 0, deleted_at: null } },
    );
    const { default: AnalyticsPage } = await import('@/app/(app)/admin/marketing/analytics/page');
    const html = await renderServerPage(await AnalyticsPage());

    expect(wrote()).toEqual(expect.arrayContaining(['marketing_campaigns', 'marketing_email_campaigns']));
    expect(html).toContain(`${ROWS} campaigns · ${fmtMoney(ROWS * 100)}`);
    expect(html).toContain(`<p class="text-2xl font-bold">${ROWS * 10}</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminMarketingAnalytics.recipients']}`);
  });

  it('/admin/marketing/ads: the budget and spend totals, and the list', async () => {
    db.seed('marketing_ad_campaigns', Array.from({ length: ROWS }, (_, i) => ({
      id: `ad-${pad(i)}`, name: `Ad ${i}`, platform: 'meta', objective: null, status: 'planned',
      budget_cents: 100, spend_cents: 50, deleted_at: null, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    })));
    // A campaign created mid-read is the NEWEST, so newest first it lands at offset 0.
    const wrote = writeBetweenPages({
      table: 'marketing_ad_campaigns', read: () => true,
      row: { id: early('ad'), name: 'Just created', platform: 'meta', objective: null, status: 'planned', budget_cents: 0, spend_cents: 0, deleted_at: null, created_at: '2026-10-22T11:59:00Z' },
    });
    const { default: AdsPage } = await import('@/app/(app)/admin/marketing/ads/page');
    const html = await renderServerPage(await AdsPage());

    expect(wrote()).toEqual(['marketing_ad_campaigns']);
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAds.totalBudget']}</p><p class="text-2xl font-bold">${fmtMoney(ROWS * 100)}</p>`);
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAds.totalSpend']}</p><p class="text-2xl font-bold">${fmtMoney(ROWS * 50)}</p>`);
    // No campaign is listed twice, and the list is still newest first.
    for (const i of [0, 300, CAP - 1, ROWS - 1]) expect(occurrences(html, `>Ad ${i}</p>`)).toBe(1);
    expect(html.indexOf(`>Ad ${ROWS - 1}</p>`)).toBeLessThan(html.indexOf('>Ad 0</p>'));
  });

  it('/admin/subscriptions: no subscription is listed or counted twice', async () => {
    db.seed('families', Array.from({ length: ROWS }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Family ${i}` })));
    db.seed('subscriptions', Array.from({ length: ROWS }, (_, i) => ({
      id: `sub-${pad(i)}`, family_id: `fam-${pad(i)}`, plan: 'plus', status: 'active', seats: 5, current_period_end: null,
      created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
    })));
    db.seed('billing_customers', []);
    const wrote = writeBetweenPages({
      table: 'subscriptions', read: (columns) => columns === '*',
      row: { id: early('sub'), family_id: 'fam-000000', plan: 'plus', status: 'incomplete', seats: 5, current_period_end: null, created_at: '2026-10-22T11:59:00Z' },
    });
    const { default: AdminSubscriptionsPage } = await import('@/app/(app)/admin/subscriptions/page');
    const html = await renderServerPage(await AdminSubscriptionsPage({ searchParams: Promise.resolve({ tab: 'all' }) }));

    expect(wrote()).toEqual(['subscriptions']);
    for (const i of [1, CAP - 1, ROWS - 1]) expect(occurrences(html, `>Family ${i}</td>`)).toBe(1);
  });

  it('/admin/users: a family\'s member count', async () => {
    db.seed('families', Array.from({ length: 5 }, (_, f) => ({ id: `fam-${pad(f)}`, name: `Family ${f}`, timezone: 'UTC', created_at: '2025-01-01T00:00:00Z' })));
    db.seed('subscriptions', []);
    db.seed('family_members', Array.from({ length: ROWS }, (_, i) => ({
      id: `mem-${pad(i)}`, family_id: `fam-${pad(i % 5)}`, user_id: null, role: 'parent',
      display_name: `Member ${i}`, is_active: true, created_at: '2025-06-01T00:00:00Z',
    })));
    for (const table of ['profiles', 'invites', 'roles', 'permissions', 'super_admins']) db.seed(table, []);
    // Someone joins Family 0 mid-read; the member an offset read repeats is in Family 4.
    const wrote = writeBetweenPages({
      table: 'family_members', read: (columns) => columns === '*',
      row: { id: early('mem'), family_id: 'fam-000000', user_id: null, role: 'child', display_name: 'New', is_active: true, created_at: '2026-10-22T11:59:00Z' },
    });
    const { default: AdminUsersPage } = await import('@/app/(app)/admin/users/page');
    const html = await renderServerPage(await AdminUsersPage({ searchParams: Promise.resolve({ tab: 'families' }) }));

    expect(wrote()).toEqual(['family_members']);
    expect(html).toContain(`>Family 4</td><td class="px-3 py-2.5 text-muted">${ROWS / 5}</td>`);
  });

  it('/admin: the storage gauge', async () => {
    seedDocuments();
    const wrote = writeBetweenPages(uploadInFlight);
    const { default: AdminDashboardPage } = await import('@/app/(app)/admin/page');
    const html = await renderServerPage(await AdminDashboardPage());

    expect(wrote()).toEqual(['documents']);
    expect(html).toContain('>1.0 GB</text>');
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
  });
});
