import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

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

// Reaching the storage read's ceiling used to return the read-error state,
// and the document list, its filters and its row actions went with it (review
// R4-CEILING-LOCKS-WORK-PAGES). It costs the figures that read sums now.
describe('/admin/content past the storage ceiling', () => {
  const CEILING = 25_000;
  const UNAVAILABLE = SOURCE_MESSAGES['strategyMetrics.unavailable'];
  const title = () => translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() });
  const banner = (html: string) => {
    const at = html.indexOf('<div role="status"');
    return at < 0 ? null : html.slice(at, html.indexOf('</ul></div>', at));
  };

  function seedPastTheCeiling() {
    seedPlatform();
    db.seed('documents', Array.from({ length: CEILING - DOCS + 1 }, (_, i) => ({
      id: `doc-z-${pad(i)}`, family_id: 'fam-000000', title: `Archive ${i}`, category: 'archive', storage_path: `fam/z${i}.pdf`,
      mime_type: 'application/pdf', size_bytes: 1_000, created_by: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    })));
  }

  it('Storage used and Categories say they are not shown; the counts and the list remain', async () => {
    seedPastTheCeiling();
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.storageUsed'])).toBe(UNAVAILABLE);
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.categories'])).toBe(UNAVAILABLE);
    const shown = banner(html);
    expect(shown).not.toBeNull();
    expect(textOf(shown ?? '')).toContain(title());
    expect([...(shown ?? '').matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([
      SOURCE_MESSAGES['adminContent.storageUsed'], SOURCE_MESSAGES['adminContent.categories'], SOURCE_MESSAGES['adminContent.storageByCategory'],
    ]);
    // The exact counts and the newest documents are still the platform's.
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.totalItems'])).toBe((CEILING + 1).toLocaleString());
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.addedThisWeek'])).toBe('200');
    expect(html).toContain(`Doc ${DOCS - 1}`);
  });

  it('the Categories tab says the breakdown is not shown instead of "no documents"', async () => {
    seedPastTheCeiling();
    const html = await render('categories');
    expect(html).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(html).toContain(`<p class="text-sm text-muted">${UNAVAILABLE}</p>`);
    expect(html).not.toContain(SOURCE_MESSAGES['adminContent.noDocumentsUploadedYet']);
    expect(html).not.toMatch(/files · /);
  });

  it('the category filter still offers categories, and keeps the one chosen', async () => {
    seedPastTheCeiling();
    const html = await render();
    // The listed (newest) documents are all filed under 'school'.
    expect(html).toContain('<option value="school">school</option>');
    const { default: AdminContentPage } = await import('@/app/(app)/admin/content/page');
    const filtered = await renderServerPage(await AdminContentPage({ searchParams: Promise.resolve({ category: 'archive' }) }));
    expect(filtered).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(filtered).toContain('<option value="archive" selected="">archive</option>');
    expect(filtered).toContain(`<span class="font-medium">Archive ${CEILING - DOCS}</span>`);
  });

  it('a storage read that FAILS is still the read-error state', async () => {
    seedPlatform();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, category, size_bytes') ? { message: 'documents unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
  });

  it('the control: under the ceiling no banner is shown', async () => {
    seedPlatform();
    expect(banner(await render())).toBeNull();
  });
});
