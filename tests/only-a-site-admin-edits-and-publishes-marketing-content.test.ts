// The marketing content actions (app/(app)/admin/marketing/content/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. These actions edit the content pipeline and put articles on, or
// take them off, the public /blog and /faq. That is a site-admin control: the
// /admin layout renders only for a super admin (app/(app)/admin/layout.tsx:14),
// and each action re-verifies through requireMarketingAdmin
// (lib/marketing/admin.ts:76), which refuses a signed-out caller (401), anyone
// not on the super_admins allowlist (403) and an admin who still owes a
// two-step code (403). A household's roles grant nothing here: a family's
// parent is not a platform admin. marketing_content_items, blog_posts,
// marketing_pages and marketing_aeo_questions are site-wide, not family data,
// so there is no "other family" id to reach.
//
// The whole success path runs for real against the in-memory tables: the
// blog_posts upsert, the platform mirror (lib/marketing/legacy-bridge.ts), the
// generated AEO answers and their retirement (lib/marketing/platform.ts).
//
// WHAT IS ASSERTED: the super admin's call writes exactly what the action
// promises and one audit row; every other caller is refused with the gate's
// own status and no table of either household, the pipeline, the blog, the
// mirror, the answers or the audit log changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: h.revalidateTag, unstable_cache: (fn: unknown) => fn }));

const { updateContentAction, publishContentToBlogAction, unpublishBlogPostAction, archiveContentAction } =
  await import('@/app/(app)/admin/marketing/content/actions');

const UPDATE = 'ACTION-5808E1A55143';
const PUBLISH = 'ACTION-AEC31509ACBA';
const UNPUBLISH = 'ACTION-28408A7C8CCF';
const ARCHIVE = 'ACTION-0368F45E7CF8';

const DRAFT = 'c1000000-0000-4000-8000-000000000001';
const LIVE = 'c1000000-0000-4000-8000-000000000002';
const DRAFT_SLUG = 'spring-cleaning-with-kids';
const LIVE_SLUG = 'a-calmer-morning-routine';

let db: InMemorySupabase;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.revalidateTag.mockReset();
  db = newAdminWorld({
    uniques: { marketing_pages: [['path']], blog_posts: [['slug']] },
    defaults: { marketing_pages: { deleted_at: null } },
  });
  db.seed('marketing_content_items', [
    {
      id: DRAFT, kind: 'blog', title: 'Spring cleaning with kids', status: 'approved', deleted_at: null,
      body: 'Start with one drawer.\n\nThen let each child pick a shelf.',
      metadata: { blog: { slug: DRAFT_SLUG, category: 'Organization', excerpt: 'One drawer at a time.' } },
    },
    {
      id: LIVE, kind: 'blog', title: 'A calmer morning routine', status: 'published', deleted_at: null,
      body: 'Lay out clothes the night before.', publish_at: '2026-10-01T00:00:00.000Z',
      metadata: { blog: { slug: LIVE_SLUG, category: 'Routines' } },
    },
  ]);
  db.seed('blog_posts', [{ slug: LIVE_SLUG, title: 'A calmer morning routine', published: true }]);
  db.seed('marketing_aeo_questions', [{
    question: 'How do I calm the morning?', answer: 'Read the full guide.', source_path: `/blog/${LIVE_SLUG}`,
    status: 'published', metadata: { seed: 'blog_aeo_v1' },
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const item = (id: string) => db.table('marketing_content_items').find((row) => row.id === id);
const post = (slug: string) => db.table('blog_posts').find((row) => row.slug === slug);
const answersFor = (slug: string) => db.table('marketing_aeo_questions').filter((row) => row.source_path === `/blog/${slug}`);

const ACTIONS = [
  { id: UPDATE, name: 'updateContentAction', run: () => updateContentAction(form({ id: DRAFT, body: 'Rewritten', status: 'review' })) },
  { id: PUBLISH, name: 'publishContentToBlogAction', run: () => publishContentToBlogAction(form({ id: DRAFT })) },
  { id: UNPUBLISH, name: 'unpublishBlogPostAction', run: () => unpublishBlogPostAction(LIVE_SLUG) },
  { id: ARCHIVE, name: 'archiveContentAction', run: () => archiveContentAction(form({ id: LIVE })) },
];

describe(`${UPDATE} updateContentAction`, () => {
  it(`${UPDATE} a super admin edits the body, status and blog metadata`, async () => {
    signInAs({ kind: 'super_admin' });
    await updateContentAction(form({
      id: DRAFT, body: 'Rewritten', status: 'review', slug: DRAFT_SLUG, category: 'Home', author: 'Editor',
      excerpt: 'Short', featured: 'on', tags: 'kids, chores',
    }));
    expect(item(DRAFT)).toEqual(expect.objectContaining({
      body: 'Rewritten', status: 'review', updated_by: SUPER_ADMIN.id,
      metadata: { blog: { slug: DRAFT_SLUG, category: 'Home', author: 'Editor', excerpt: 'Short', featured: true, tags: ['kids', 'chores'] } },
    }));
    expect(item(LIVE)).toEqual(expect.objectContaining({ status: 'published', body: 'Lay out clothes the night before.' }));
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'update', resource: 'marketing_content_item', resource_id: DRAFT, actor_id: SUPER_ADMIN.id,
    })]);
  });
});

describe(`${PUBLISH} publishContentToBlogAction`, () => {
  it(`${PUBLISH} a super admin publishes the approved item to the blog, its mirror and its answers`, async () => {
    signInAs({ kind: 'super_admin' });
    await publishContentToBlogAction(form({ id: DRAFT }));
    expect(post(DRAFT_SLUG)).toEqual(expect.objectContaining({ slug: DRAFT_SLUG, title: 'Spring cleaning with kids', published: true }));
    expect(item(DRAFT)).toEqual(expect.objectContaining({
      status: 'published', publish_at: expect.any(String), updated_by: SUPER_ADMIN.id,
      metadata: expect.objectContaining({ blog: expect.objectContaining({ slug: DRAFT_SLUG }) }),
    }));
    expect(db.table('marketing_pages').map((row) => [row.path, row.status])).toEqual([[`/blog/${DRAFT_SLUG}`, 'published']]);
    expect(answersFor(DRAFT_SLUG).length).toBeGreaterThan(0);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'publish', resource: 'blog_post', resource_id: DRAFT_SLUG, actor_id: SUPER_ADMIN.id, metadata: { fromContentItem: DRAFT },
    })]);
    expect(h.revalidatePath).toHaveBeenCalledWith(`/blog/${DRAFT_SLUG}`);
  });
});

describe(`${UNPUBLISH} unpublishBlogPostAction`, () => {
  it(`${UNPUBLISH} a super admin pulls the post, returns its item to approved and retires its answers`, async () => {
    signInAs({ kind: 'super_admin' });
    await unpublishBlogPostAction(LIVE_SLUG);
    expect(post(LIVE_SLUG)).toEqual(expect.objectContaining({ published: false }));
    expect(item(LIVE)).toEqual(expect.objectContaining({ status: 'approved', publish_at: null }));
    expect(item(DRAFT)).toEqual(expect.objectContaining({ status: 'approved' }));
    expect(answersFor(LIVE_SLUG).map((row) => row.status)).toEqual(['answered']);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'unpublish', resource: 'blog_post', resource_id: LIVE_SLUG, actor_id: SUPER_ADMIN.id,
    })]);
  });
});

describe(`${ARCHIVE} archiveContentAction`, () => {
  it(`${ARCHIVE} a super admin archives the item and takes its post and answers down with it`, async () => {
    signInAs({ kind: 'super_admin' });
    await archiveContentAction(form({ id: LIVE }));
    expect(item(LIVE)).toEqual(expect.objectContaining({ status: 'approved', deleted_at: expect.any(String), updated_by: SUPER_ADMIN.id }));
    expect(item(DRAFT)).toEqual(expect.objectContaining({ deleted_at: null }));
    expect(post(LIVE_SLUG)).toEqual(expect.objectContaining({ published: false }));
    expect(answersFor(LIVE_SLUG).map((row) => row.status)).toEqual(['answered']);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'archive', resource: 'marketing_content_item', resource_id: LIVE, actor_id: SUPER_ADMIN.id,
    })]);
  });
});

describe.each(ACTIONS)('$id $name refuses everyone but a site admin', ({ id, run }) => {
  it.each(REFUSED_CALLERS)(`${id} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(run()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(post(LIVE_SLUG)).toEqual(expect.objectContaining({ published: true }));
    expect(post(DRAFT_SLUG)).toBeUndefined();
    expect(item(DRAFT)).toEqual(expect.objectContaining({ status: 'approved', deleted_at: null }));
    expect(item(LIVE)).toEqual(expect.objectContaining({ status: 'published', deleted_at: null }));
    expect(answersFor(LIVE_SLUG).map((row) => row.status)).toEqual(['published']);
    expect(db.table('marketing_audit_logs')).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });
});
