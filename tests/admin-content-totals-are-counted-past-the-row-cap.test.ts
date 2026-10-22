import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// /admin/content read `documents.select('*')` with no bound and computed the
// storage total, the Total items tile, the category list with its per-category
// counts and bytes, and "Added this week" from whatever came back. PostgREST
// caps that at 1,000 rows with no error, so past a thousand documents Total
// items pinned at 1,000, storage understated, and a category whose documents
// were all older than the newest thousand did not exist on the page at all.
// admin/reports and admin/backup fixed exactly this for the same table.
const CAP = 1000;
const DOCS = 1300;
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
// The row control reaches for the app router, which a static render has not.
vi.mock('@/components/admin/document-row-actions', () => ({ DocumentRowActions: () => null }));

let db: InMemorySupabase;

function seedPlatform() {
  // The 200 OLDEST documents are the only ones filed under 'medical', so a
  // newest-first read of a thousand never sees that category; the 200 NEWEST
  // were added this week.
  const createdAt = (i: number) => (i >= 1100
    ? new Date(Date.UTC(2026, 9, 20) + i * 1_000).toISOString()
    : new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString());
  db.seed('families', Array.from({ length: 3 }, (_, f) => ({ id: `fam-${pad(f)}`, name: `Family ${f}` })));
  db.seed('documents', Array.from({ length: DOCS }, (_, i) => ({
    id: `doc-${pad(i)}`, family_id: `fam-${pad(i % 3)}`, title: `Doc ${i}`,
    category: i < 200 ? 'medical' : 'school', storage_path: `fam/${i}.pdf`, mime_type: 'application/pdf',
    size_bytes: 1_000, created_by: `usr-${pad(i)}`, created_at: createdAt(i), updated_at: createdAt(i),
  })));
  // Profiles in creation order: the uploaders of the newest documents are the
  // LAST profiles, past an unordered read of a thousand.
  db.seed('profiles', Array.from({ length: DOCS }, (_, i) => ({
    id: `usr-${pad(i)}`, full_name: `Uploader ${i}`, email: `u${i}@example.com`,
  })));
}

async function render(tab?: string): Promise<string> {
  const { default: AdminContentPage } = await import('@/app/(app)/admin/content/page');
  return renderServerPage(await AdminContentPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
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

describe('/admin/content counts and sums every document, not the newest thousand', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('documents').select('*').order('created_at', { ascending: false });
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('the tiles are platform totals', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.totalItems'])).toBe('1,300');
    // 1,300 × 1,000 bytes is 1.2 MB; the first thousand alone is 977 KB.
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.storageUsed'])).toBe('1.2 MB');
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.categories'])).toBe('2');
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.addedThisWeek'])).toBe('200');
  });

  it('a category whose documents are all older than the newest thousand is still a category', async () => {
    seedPlatform();
    const html = await render('categories');
    expect(html).toMatch(/medical<\/span><span class="text-muted">200 files · 195 KB/);
    expect(html).toMatch(/school<\/span><span class="text-muted">1100 files · 1\.0 MB/);
  });

  it('the uploader of a listed document is named even past a thousand profiles', async () => {
    seedPlatform();
    const html = await render();
    expect(html).toContain(`Uploader ${DOCS - 1}`);
  });
});
