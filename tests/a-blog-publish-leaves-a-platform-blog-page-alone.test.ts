// Admin reach N12-S1 — the blog publisher's bridge into the platform registry.
//
// publishContentToBlogAction mirrors every post into marketing_pages with an
// upsert on `path` (/blog/<slug>), and the platform console offers the page type
// "Blog" under the same prefix. So a page made in the console at that path had
// its title, body, content, SEO and AEO replaced by the post's and its status
// forced to published, and Unpublish and Archive then drafted or archived it by
// path alone. Round 1 closed the same defect on the landing bridge only.
//
// What may sit at /blog/<slug> is a mirror of the legacy blog: this publisher's
// own rows (`marketing_content_items`) or the copies
// scripts/backfill-marketing-pages.mjs made of blog_posts (`blog_posts`). Any of
// those is the article's own row — blog_posts is keyed by slug — so publishing,
// unpublishing and archiving keep working on them, which the controls pin.
//
// Driven through the REAL content and platform actions and the bridge against
// one in-memory database. Negative controls: before the fix the console page was
// overwritten on publish, drafted on unpublish and archived on archive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: h.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));

const { publishContentToBlogAction, unpublishBlogPostAction, archiveContentAction } = await import('@/app/(app)/admin/marketing/content/actions');
const { createPlatformPage, updatePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');

const SLUG = 'spring-cleaning-with-kids';
const PATH = `/blog/${SLUG}`;
let db: InMemorySupabase;

function form(fields: Record<string, unknown>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, String(value));
  return fd;
}
async function digestOf(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string });
  return error?.digest ?? null;
}
const pageAt = (path: string) => db.table('marketing_pages').find((row) => row.path === path);
const item = () => db.table('marketing_content_items').find((row) => row.id === 'item-1')!;
const post = () => db.table('blog_posts').find((row) => row.slug === SLUG);

/** A page an admin makes in the platform console at /blog/<slug> and publishes. */
async function aConsoleBlogPageAtThePath(): Promise<Row> {
  await createPlatformPage(form({ page_type: 'blog', title: 'Spring cleaning (editorial)', slug: SLUG, summary: 'Our editors’ take', body: 'Console body' }));
  const created = pageAt(PATH)!;
  expect(created.content).toEqual({});
  await updatePlatformPage(form({
    id: created.id, page_type: 'blog', title: 'Spring cleaning (editorial)', slug: SLUG, summary: 'Our editors’ take', body: 'Console body', status: 'published',
  }));
  return structuredClone(pageAt(PATH)!);
}

/**
 * The console path to that state for a post that is ALREADY live: publish the
 * post, rename its mirror off the path in the console, then make the console
 * page at the path that freed.
 */
async function aLivePostWhosePathTheConsoleGaveAway(): Promise<Row> {
  await publishContentToBlogAction(form({ id: 'item-1' }));
  const mirror = pageAt(PATH)!;
  await updatePlatformPage(form({ id: mirror.id, page_type: 'blog', title: 'Spring cleaning with kids', slug: `${SLUG}-old`, status: 'published' }));
  expect(pageAt(PATH)).toBeUndefined();
  return aConsoleBlogPageAtThePath();
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { marketing_pages: [['path']], blog_posts: [['slug']] },
    defaults: { marketing_pages: { deleted_at: null } },
  });
  h.db = db;
  db.seed('marketing_pages', []);
  db.seed('blog_posts', []);
  db.seed('marketing_aeo_questions', []);
  db.seed('marketing_content_items', [{
    id: 'item-1', kind: 'blog', title: 'Spring cleaning with kids', status: 'approved', deleted_at: null,
    body: 'Start with one drawer.\n\nThen let each child pick a shelf.',
    metadata: { blog: { slug: SLUG, category: 'Organization', excerpt: 'One drawer at a time.' } },
  }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the blog publisher leaves a console page at its /blog path alone', () => {
  it('publishing onto that path is refused before anything is written', async () => {
    const consolePage = await aConsoleBlogPageAtThePath();

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(pageAt(PATH)).toEqual(consolePage);
    expect(post()).toBeUndefined();
    expect(item()).toMatchObject({ status: 'approved' });
    expect(db.table('marketing_aeo_questions')).toEqual([]);
  });

  it('republishing a live post whose path the console gave away is refused, and its live article is kept', async () => {
    const consolePage = await aLivePostWhosePathTheConsoleGaveAway();
    const article = structuredClone(post());

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(pageAt(PATH)).toEqual(consolePage);
    expect(post()).toEqual(article);
  });

  it('unpublishing the post takes the article down and leaves the console page as it was', async () => {
    const consolePage = await aLivePostWhosePathTheConsoleGaveAway();

    await unpublishBlogPostAction(SLUG);

    expect(post()).toMatchObject({ published: false });
    expect(pageAt(PATH)).toEqual(consolePage);
  });

  it('archiving the content item takes the article down and leaves the console page as it was', async () => {
    const consolePage = await aLivePostWhosePathTheConsoleGaveAway();

    await archiveContentAction(form({ id: 'item-1' }));

    expect(post()).toMatchObject({ published: false });
    expect(pageAt(PATH)).toEqual(consolePage);
  });
});

describe('the control: every legacy blog mirror is still the article’s own row', () => {
  it('publish, republish, unpublish and archive move the publisher’s own mirror', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirror = pageAt(PATH)!;
    expect(mirror).toMatchObject({ page_type: 'blog', status: 'published', content: { source: 'marketing_content_items', source_id: 'item-1' } });
    expect(post()).toMatchObject({ published: true });

    await publishContentToBlogAction(form({ id: 'item-1' }));
    expect(pageAt(PATH)).toMatchObject({ id: mirror.id, status: 'published' });

    await unpublishBlogPostAction(SLUG);
    expect(pageAt(PATH)).toMatchObject({ id: mirror.id, status: 'draft' });

    await archiveContentAction(form({ id: 'item-1' }));
    expect(pageAt(PATH)).toMatchObject({ id: mirror.id, status: 'archived' });
    expect(pageAt(PATH)!.deleted_at).not.toBeNull();
  });

  // The rows scripts/backfill-marketing-pages.mjs wrote for every existing post,
  // and the content items migration 0228 registered for them.
  const backfilled = (overrides: Row = {}): Row => ({
    id: 'backfilled-page', page_type: 'blog', slug: SLUG, path: PATH, title: 'Spring cleaning with kids', summary: 'One drawer at a time.',
    body: 'Start with one drawer.', content: { source: 'blog_posts', source_id: 'post-1', category: 'Organization', tags: [], blocks: [] },
    seo: { title: 'Spring cleaning with kids', canonical: PATH }, aeo: {}, status: 'published', published_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null, ...overrides,
  });

  it('a post backfilled from blog_posts can be republished from its content item', async () => {
    db.seed('blog_posts', [{ id: 'post-1', slug: SLUG, title: 'Spring cleaning with kids', published: true }]);
    db.seed('marketing_pages', [backfilled()]);

    await publishContentToBlogAction(form({ id: 'item-1' }));

    expect(pageAt(PATH)).toMatchObject({ id: 'backfilled-page', status: 'published', content: { source: 'marketing_content_items', source_id: 'item-1' } });
    expect(item()).toMatchObject({ status: 'published' });
  });

  it.each(['unpublish', 'archive'])('a backfilled mirror still follows its article on %s', async (operation) => {
    db.seed('blog_posts', [{ id: 'post-1', slug: SLUG, title: 'Spring cleaning with kids', published: true }]);
    db.seed('marketing_pages', [backfilled()]);
    Object.assign(item(), { status: 'published' });

    if (operation === 'archive') await archiveContentAction(form({ id: 'item-1' }));
    else await unpublishBlogPostAction(SLUG);

    expect(post()).toMatchObject({ published: false });
    expect(pageAt(PATH)).toMatchObject({ id: 'backfilled-page', status: operation === 'archive' ? 'archived' : 'draft' });
  });

  it('with the platform registry not migrated, publishing still goes out (the bridge’s compatibility state)', async () => {
    const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.marketing_pages' in the schema cache" } };
    const absent: object = new Proxy({}, {
      get: (_target, property) => property === 'then'
        ? (resolve: (value: unknown) => unknown) => resolve(missing)
        : () => (property === 'single' || property === 'maybeSingle' ? Promise.resolve(missing) : absent),
    });
    h.db = { from: (table: string) => (table === 'marketing_pages' ? absent : db.from(table)) };

    await publishContentToBlogAction(form({ id: 'item-1' }));

    expect(post()).toMatchObject({ published: true });
    expect(item()).toMatchObject({ status: 'published' });
  });

  it('a slug another content item published before is reused, as blog_posts itself allows', async () => {
    db.seed('blog_posts', [{ id: 'post-2', slug: SLUG, title: 'An older take', published: false }]);
    db.seed('marketing_pages', [backfilled({ id: 'older-mirror', status: 'archived', deleted_at: '2026-09-01T00:00:00.000Z',
      content: { source: 'marketing_content_items', source_id: 'item-0' } })]);

    await publishContentToBlogAction(form({ id: 'item-1' }));

    expect(pageAt(PATH)).toMatchObject({ id: 'older-mirror', status: 'published', deleted_at: null, content: { source_id: 'item-1' } });
    expect(post()).toMatchObject({ published: true, title: 'Spring cleaning with kids' });
  });
});
