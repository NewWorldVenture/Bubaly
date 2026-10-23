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
// The row control reaches for the app router, which a static render has not;
// it stands in as a marker naming the document it acts on.
vi.mock('@/components/admin/document-row-actions', async () => {
  const { createElement } = await import('react');
  return { DocumentRowActions: ({ documentId }: { documentId: string }) => createElement('span', { 'data-row-actions': documentId }) };
});

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

// The family filter's options and every listed document's family name came
// from ONE read of the whole families table, paged to the same 25,000-row
// ceiling as the summed figures, and reaching it returned the read-error
// state: the list, its filters and its row actions went with it, where the
// page used to render (review R5-FAMILIES-LABEL-CEILING-LOCKS-PAGES). A listed
// document is now named from its own family, and the ceiling costs only the
// filter options past it, which the page says.
describe('/admin/content past 25,000 families', () => {
  const CEILING = 25_000;
  const DOCUMENTS = 30;
  const offeredTitle = () => translate(SOURCE_MESSAGES, 'adminCeiling.offeredInPart', { n: CEILING.toLocaleString() });
  const bannerTitled = (html: string, title: string) => {
    const at = html.indexOf(`<p class="text-sm font-semibold text-danger">${title}</p>`);
    return at < 0 ? null : html.slice(at, html.indexOf('</ul></div>', at));
  };
  const row = (i: number) => `<span class="font-medium">Doc ${i}</span>`;

  async function renderWith(params: { tab?: string; q?: string; category?: string; family?: string }): Promise<string> {
    const { default: AdminContentPage } = await import('@/app/(app)/admin/content/page');
    return renderServerPage(await AdminContentPage({ searchParams: Promise.resolve(params) }));
  }

  // 25,001 families with no documents sort first by id; the three that own
  // every document sort after them, past the first 25,000.
  function seedPastTheFamilyCeiling() {
    db.seed('families', [
      ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Empty family ${i}` })),
      ...Array.from({ length: 3 }, (_, f) => ({ id: `fam-zz-${pad(f)}`, name: `Owner family ${f}` })),
    ]);
    db.seed('documents', Array.from({ length: DOCUMENTS }, (_, i) => {
      const createdAt = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
      return {
        id: `doc-${pad(i)}`, family_id: `fam-zz-${pad(i % 3)}`, title: `Doc ${i}`, category: 'school', storage_path: `fam/${i}.pdf`,
        mime_type: 'application/pdf', size_bytes: 1_000, created_by: `usr-${pad(i)}`, created_at: createdAt, updated_at: createdAt,
      };
    }));
    db.seed('profiles', Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `usr-${pad(i)}`, full_name: `Uploader ${i}`, email: `u${i}@example.com` })));
  }

  it('the page, its list and row actions render, and every listed document names its own family', async () => {
    seedPastTheFamilyCeiling();
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.totalItems'])).toBe(String(DOCUMENTS));
    expect(statCardValue(html, SOURCE_MESSAGES['adminContent.storageUsed'])).toBe('29 KB');
    for (const i of [0, DOCUMENTS - 1]) {
      expect(html).toContain(row(i));
      expect(html).toContain(`data-row-actions="doc-${pad(i)}"`);
    }
    // Each owner family names its ten documents' rows, and the recent rail.
    for (const f of [0, 1, 2]) {
      expect(html.split(`<td class="px-3 py-2.5 text-muted">Owner family ${f}</td>`)).toHaveLength(DOCUMENTS / 3 + 1);
      expect(html).toContain(`<p class="text-xs text-muted">Owner family ${f} · `);
    }
    expect(html).not.toContain('Unknown family');
    expect(html).toContain(`Uploader ${DOCUMENTS - 1}`);
  });

  it('the family filter offers the first 25,000 families and says it is cut short', async () => {
    seedPastTheFamilyCeiling();
    const html = await render();
    const shown = bannerTitled(html, offeredTitle());
    expect(shown).not.toBeNull();
    expect([...(shown ?? '').matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([SOURCE_MESSAGES['adminContent.familyFilter']]);
    expect(html).toContain('<option value="fam-000000">Empty family 0</option>');
    expect(html).toContain(`<option value="fam-${pad(CEILING - 1)}">Empty family ${CEILING - 1}</option>`);
    expect(html).not.toContain(`<option value="fam-${pad(CEILING)}">`);
    // The summed figures are under their own ceiling: their banner is not shown.
    expect(html).not.toContain(translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() }));
  });

  it('a family chosen past the 25,000th stays selected, and the filter and the search still reach its documents', async () => {
    seedPastTheFamilyCeiling();
    const filtered = await renderWith({ family: 'fam-zz-000001' });
    expect(filtered).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(filtered).toContain('<option value="fam-zz-000001" selected="">Owner family 1</option>');
    expect(filtered).toContain(row(DOCUMENTS - 2));
    expect(filtered).not.toContain(row(DOCUMENTS - 1));

    const searched = await renderWith({ q: 'owner family 2' });
    expect(searched).not.toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(searched).toContain(row(DOCUMENTS - 1));
    expect(searched).not.toContain(row(DOCUMENTS - 2));
  });

  it('a family label read that fails is still the read-error state', async () => {
    seedPastTheFamilyCeiling();
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'in') ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(html).not.toContain(row(0));
  });

  it('a family filter read that fails is still the read-error state', async () => {
    seedPastTheFamilyCeiling();
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'range') ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['content.couldNotLoadContentFrom']);
    expect(html).not.toContain(row(0));
  });

  it('the control: under the ceiling the filter offers every family and says nothing', async () => {
    seedPlatform();
    const html = await render();
    expect(bannerTitled(html, offeredTitle())).toBeNull();
    for (const f of [0, 1, 2]) expect(html).toContain(`<option value="fam-${pad(f)}">Family ${f}</option>`);
  });
});
