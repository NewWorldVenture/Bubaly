// An admin clicks "Archive" in /admin/marketing/platform or /admin/marketing/content.
// The page disappears from the public site — `marketing_pages_public_read`
// (0237) hides it on `status = 'published' and deleted_at is null`.
//
// Its GENERATED FAQ ANSWERS are different rows, in `marketing_aeo_questions`,
// and migration 0228 made those world-readable on `status = 'published'` ALONE
// — no join back to the page. So unless something retires them, the public site
// keeps answering for content that was deliberately taken down:
//
//   * /faq's "Knowledge Center" tab lists them and folds them into the page's
//     FAQPage structured data submitted to search engines;
//   * every OTHER, still-live article in the same category renders them in its
//     own 4-slot FAQ block, because the blog rows carry `metadata.category`;
//   * the blog answer body ends "Read the full guide at /blog/<slug>", i.e. a
//     public answer citing a URL that now calls notFound().
//
// Nothing self-heals it. 0237's regeneration trigger fires only
// `when (... new.deleted_at is null and new.version is distinct from old.version)`,
// and archiving sets `deleted_at`; `runQuestions` refuses a deleted page; and its
// delete is scoped to `metadata.source = 'marketing_platform'`, so the blog
// writer's `metadata.seed = 'blog_aeo_v1'` rows are out of its reach entirely.
//
// This runs the REAL server actions and the REAL public readers against one
// in-memory Postgres stand-in, and asserts what a visitor to /faq and a reader of
// a live sibling article would see — not that a particular query was issued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: state.revalidatePath,
  revalidateTag: state.revalidateTag,
  // The public readers wrap themselves in unstable_cache at module load. Pass the
  // function through so each case reads the store it just wrote.
  unstable_cache: (fn: unknown) => fn,
}));
// lib/marketing/aeo.ts builds its own ANON client — the same client a visitor's
// page render uses. Point it at the same store the admin action writes to.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.db }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string, error: unknown) => {
    throw new Error(`Could not ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
}));

import { archivePlatformPage, updatePlatformPage } from '@/app/(app)/admin/marketing/platform/actions';
import { archiveContentAction, unpublishBlogPostAction } from '@/app/(app)/admin/marketing/content/actions';
import { readPublishedAeoQuestions, readAeoQuestionsForCategory, AEO_TAG } from '@/lib/marketing/aeo';

const ARCHIVED_SLUG = 'back-to-school-mornings';
const LIVE_SLUG = 'sunday-reset-routine';

function db(): InMemorySupabase {
  return state.db as InMemorySupabase;
}

/** The two rows deriveArticleAeoQuestions writes on publish, verbatim in shape. */
function blogAnswers(slug: string, title: string, category: string) {
  return [
    {
      question: `How does Bubaly help with ${title.toLowerCase()}?`,
      answer: `Some excerpt. Bubaly — the AI Family Operating System — turns this into shared, automatic routines. Read the full guide at /blog/${slug}.`,
      entity: 'Bubaly', source_path: `/blog/${slug}`, pattern: 'faq', status: 'published', clarity_score: 88,
      metadata: { seed: 'blog_aeo_v1', slug, category, article: true },
    },
    {
      question: `${title} — where should a family start?`,
      answer: `Start small and let the system do the remembering. Full guide: /blog/${slug}.`,
      entity: 'Bubaly', source_path: `/blog/${slug}`, pattern: 'how_to', status: 'published', clarity_score: 86,
      metadata: { seed: 'blog_aeo_v1', slug, category, article: true },
    },
  ];
}

function seedBlogFixture(): void {
  const fake = createInMemorySupabase();
  state.db = fake;
  fake.seed('blog_posts', [
    { id: 'post-archived', slug: ARCHIVED_SLUG, title: 'Back to school mornings', category: 'Organization', excerpt: 'Some excerpt.', published: true },
    { id: 'post-live', slug: LIVE_SLUG, title: 'The Sunday reset routine', category: 'Organization', excerpt: 'Other excerpt.', published: true },
  ]);
  fake.seed('marketing_pages', [
    { id: 'page-archived', path: `/blog/${ARCHIVED_SLUG}`, slug: ARCHIVED_SLUG, page_type: 'blog', title: 'Back to school mornings', status: 'published', deleted_at: null, version: 1 },
  ]);
  fake.seed('marketing_content_items', [
    { id: 'item-archived', kind: 'blog', status: 'published', deleted_at: null, metadata: { blog: { slug: ARCHIVED_SLUG, category: 'Organization' } } },
  ]);
  fake.seed('marketing_aeo_questions', [
    ...blogAnswers(ARCHIVED_SLUG, 'Back to school mornings', 'Organization'),
    ...blogAnswers(LIVE_SLUG, 'The Sunday reset routine', 'Organization'),
  ]);
}

/** Every answer a visitor would see, whichever public surface asked for it. */
function citations(questions: { answer: string }[]): string[] {
  return questions.map((q) => q.answer);
}

beforeEach(() => {
  state.audit.mockReset().mockResolvedValue(undefined);
  state.revalidateTag.mockReset();
  state.revalidatePath.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('archiving a page retires the answers it published', () => {
  it('drops the archived page out of the /faq Knowledge Center instead of leaving it answering', async () => {
    const fake = createInMemorySupabase();
    state.db = fake;
    fake.seed('marketing_pages', [
      { id: 'page-1', path: '/features/meal-planning', slug: 'meal-planning', page_type: 'feature', title: 'Meal planning', status: 'published', deleted_at: null, version: 3 },
      { id: 'page-2', path: '/features/chores', slug: 'chores', page_type: 'feature', title: 'Chores', status: 'published', deleted_at: null, version: 1 },
    ]);
    fake.seed('marketing_aeo_questions', [
      { question: 'How does Bubaly plan meals?', answer: 'It builds the week from what your family already eats.', source_path: '/features/meal-planning', status: 'published', clarity_score: 85, metadata: { source: 'marketing_platform', page_id: 'page-1' } },
      { question: 'How does Bubaly split chores?', answer: 'Everyone sees the same list.', source_path: '/features/chores', status: 'published', clarity_score: 84, metadata: { source: 'marketing_platform', page_id: 'page-2' } },
    ]);

    const before = await readPublishedAeoQuestions(60);
    expect(before.available).toBe(true);
    expect(citations(before.questions)).toContain('It builds the week from what your family already eats.');

    const form = new FormData();
    form.set('id', 'page-1');
    await archivePlatformPage(form);

    // The page really did go down — this is the archive the admin asked for.
    expect(fake.table('marketing_pages').find((r) => r.id === 'page-1')).toMatchObject({ status: 'archived' });
    expect(fake.table('marketing_pages').find((r) => r.id === 'page-1')?.deleted_at).not.toBeNull();

    const after = await readPublishedAeoQuestions(60);
    expect(after.available).toBe(true);
    expect(citations(after.questions)).not.toContain('It builds the week from what your family already eats.');
    // The still-published page keeps answering: this retires one page, not the set.
    expect(citations(after.questions)).toContain('Everyone sees the same list.');

    // Retired, not destroyed: the editorial text stays in /admin/marketing/aeo at
    // the same status runQuestions writes for a page that is not published.
    const retired = fake.table('marketing_aeo_questions').find((r) => r.source_path === '/features/meal-planning');
    expect(retired).toMatchObject({ status: 'answered' });
    expect(retired?.answer).toBe('It builds the week from what your family already eats.');

    // /faq caches its read for an hour under one tag. Without dropping it the
    // archived page keeps answering publicly regardless of the row's status.
    expect(state.revalidateTag).toHaveBeenCalledWith(AEO_TAG, { expire: 0 });
  });

  it('stops an archived article answering inside a live sibling article in the same category', async () => {
    seedBlogFixture();

    const before = await readAeoQuestionsForCategory('Organization', 4);
    expect(before.available).toBe(true);
    expect(citations(before.questions).some((a) => a.includes(`/blog/${ARCHIVED_SLUG}`))).toBe(true);

    const form = new FormData();
    form.set('id', 'item-archived');
    await archiveContentAction(form);

    // The article itself is gone: getPost() filters on published, so /blog/<slug>
    // now calls notFound().
    expect(db().table('blog_posts').find((r) => r.slug === ARCHIVED_SLUG)).toMatchObject({ published: false });

    // What the LIVE sibling's FAQ block and FAQPage schema now contain.
    const after = await readAeoQuestionsForCategory('Organization', 4);
    expect(after.available).toBe(true);
    expect(citations(after.questions).some((a) => a.includes(`/blog/${ARCHIVED_SLUG}`))).toBe(false);
    // The live article's own answers survive — the fix is targeted, not a purge.
    expect(citations(after.questions).some((a) => a.includes(`/blog/${LIVE_SLUG}`))).toBe(true);

    // And nothing on /faq cites the dead URL either.
    const faq = await readPublishedAeoQuestions(60);
    expect(citations(faq.questions).some((a) => a.includes(`/blog/${ARCHIVED_SLUG}`))).toBe(false);
    expect(state.revalidateTag).toHaveBeenCalledWith(AEO_TAG, { expire: 0 });
  });

  it('stops a pulled-down post answering on /faq when the admin only unpublishes it', async () => {
    seedBlogFixture();

    const before = await readPublishedAeoQuestions(60);
    expect(citations(before.questions).some((a) => a.includes(`/blog/${ARCHIVED_SLUG}`))).toBe(true);

    await unpublishBlogPostAction(ARCHIVED_SLUG);

    expect(db().table('blog_posts').find((r) => r.slug === ARCHIVED_SLUG)).toMatchObject({ published: false });

    const after = await readPublishedAeoQuestions(60);
    expect(after.available).toBe(true);
    expect(citations(after.questions).some((a) => a.includes(`/blog/${ARCHIVED_SLUG}`))).toBe(false);
    expect(citations(after.questions).some((a) => a.includes(`/blog/${LIVE_SLUG}`))).toBe(true);
    expect(state.revalidateTag).toHaveBeenCalledWith(AEO_TAG, { expire: 0 });
  });

  it('leaves an answer an admin is still drafting at its own status', async () => {
    const fake = createInMemorySupabase();
    state.db = fake;
    fake.seed('marketing_pages', [
      { id: 'page-1', path: '/features/meal-planning', slug: 'meal-planning', page_type: 'feature', title: 'Meal planning', status: 'published', deleted_at: null, version: 1 },
    ]);
    // The published answer and the drafting row sit on the SAME path, so one
    // archive has to tell them apart: before the fix neither moved, and a fix that
    // retired by path alone would move both.
    fake.seed('marketing_aeo_questions', [
      { question: 'How does Bubaly plan meals?', answer: 'It builds the week from what your family already eats.', source_path: '/features/meal-planning', status: 'published', clarity_score: 85, metadata: { source: 'marketing_platform', page_id: 'page-1' } },
      { question: 'Not ready yet?', answer: null, source_path: '/features/meal-planning', status: 'opportunity', clarity_score: 40, metadata: { source: 'marketing_platform', page_id: 'page-1' } },
    ]);

    const form = new FormData();
    form.set('id', 'page-1');
    await archivePlatformPage(form);

    const rows = fake.table('marketing_aeo_questions');
    expect(rows.find((r) => r.question === 'How does Bubaly plan meals?')).toMatchObject({ status: 'answered' });
    expect(rows.find((r) => r.question === 'Not ready yet?')).toMatchObject({ status: 'opportunity' });
  });
});

describe('a save that renames the page retires the answers filed under its old path', () => {
  // `slug` and `status` are in the same form on /admin/marketing/platform, so one
  // submit can rename a page and take it down together. The answers still carry
  // the OLD source_path; retiring by the recomputed path alone retired nothing.
  function seedRenamable(): InMemorySupabase {
    const fake = createInMemorySupabase();
    state.db = fake;
    fake.seed('marketing_pages', [
      { id: 'page-1', path: '/features/meal-planning', slug: 'meal-planning', page_type: 'feature', title: 'Meal planning', status: 'published', deleted_at: null, version: 1 },
      { id: 'page-2', path: '/features/chores', slug: 'chores', page_type: 'feature', title: 'Chores', status: 'published', deleted_at: null, version: 1 },
    ]);
    fake.seed('marketing_aeo_questions', [
      { question: 'How does Bubaly plan meals?', answer: 'It builds the week from what your family already eats.', source_path: '/features/meal-planning', status: 'published', clarity_score: 85, metadata: { source: 'marketing_platform', page_id: 'page-1' } },
      { question: 'How does Bubaly split chores?', answer: 'Everyone sees the same list.', source_path: '/features/chores', status: 'published', clarity_score: 84, metadata: { source: 'marketing_platform', page_id: 'page-2' } },
    ]);
    return fake;
  }

  function editForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    form.set('id', 'page-1');
    form.set('page_type', 'feature');
    form.set('title', 'Meal planning');
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return form;
  }

  it('takes the answers down when the same save renames the page and moves it to draft', async () => {
    const fake = seedRenamable();
    expect(citations((await readPublishedAeoQuestions(60)).questions)).toContain('It builds the week from what your family already eats.');

    await updatePlatformPage(editForm({ slug: 'weekly-meal-planning', status: 'draft' }));

    expect(fake.table('marketing_pages').find((r) => r.id === 'page-1')).toMatchObject({ path: '/features/weekly-meal-planning', status: 'draft' });
    const after = await readPublishedAeoQuestions(60);
    expect(citations(after.questions)).not.toContain('It builds the week from what your family already eats.');
    expect(citations(after.questions)).toContain('Everyone sees the same list.');
    expect(fake.table('marketing_aeo_questions').find((r) => r.source_path === '/features/meal-planning')).toMatchObject({ status: 'answered' });
    expect(state.revalidateTag).toHaveBeenCalledWith(AEO_TAG, { expire: 0 });
    expect(state.revalidatePath).toHaveBeenCalledWith('/features/meal-planning');
  });

  it('takes the old path\'s answers down when a live page is only renamed', async () => {
    // runQuestions deletes and re-inserts only under the page's CURRENT path, so
    // nothing downstream would ever touch the answers left at the old one.
    const fake = seedRenamable();

    await updatePlatformPage(editForm({ slug: 'weekly-meal-planning', status: 'published' }));

    expect(fake.table('marketing_pages').find((r) => r.id === 'page-1')).toMatchObject({ path: '/features/weekly-meal-planning', status: 'published' });
    const after = await readPublishedAeoQuestions(60);
    expect(after.available).toBe(true);
    expect(after.questions.some((q) => q.sourcePath === '/features/meal-planning')).toBe(false);
    expect(citations(after.questions)).toContain('Everyone sees the same list.');
  });

  it('leaves a live page\'s answers alone when a save neither renames nor unpublishes it', async () => {
    const fake = seedRenamable();

    await updatePlatformPage(editForm({ slug: 'meal-planning', status: 'published', summary: 'A sharper summary.' }));

    expect(fake.table('marketing_aeo_questions').find((r) => r.source_path === '/features/meal-planning')).toMatchObject({ status: 'published' });
    expect(citations((await readPublishedAeoQuestions(60)).questions)).toContain('It builds the week from what your family already eats.');
  });
});

describe('migration 0383 is wired into the CI probe run that executes it (a wiring guard; the SQL is proved by the probes)', () => {
  // The actions above are the fast path; they are not the guarantee. The cron
  // worker, the backfill scripts and the SQL editor all write these tables
  // without going through an action, and 0383's triggers are what cover them.
  //
  // Vitest has no Postgres, and a regex over the SQL proves nothing about what it
  // does — the first cut of this file pinned the very WHEN clause whose function
  // retired by NEW.path and missed a rename-and-take-down. So the behaviour is
  // proved where it can be: two boundary probes that CI's `database` job runs
  // (docs/audit/run-probes.sh, globbing docs/audit/*-check.sql) after replaying
  // every migration into pgvector/pgvector:pg16. Between them they execute every
  // take-down shape as the roles that really write, assert what anon can read,
  // re-apply 0383 over the drifted answers /admin/marketing/aeo can produce, and
  // carry negative controls that restore the first cut and go red.
  //
  // What THIS case guards is only that wiring — delete a probe, stop the runner
  // globbing, or drop the database job, and it fails.
  const root = new URL('../', import.meta.url);
  const read = async (path: string) => (await import('node:fs/promises')).readFile(new URL(path, root), 'utf8');

  it('ships with boundary probes that the CI database job executes after the replay', async () => {
    const ci = await read('.github/workflows/ci.yml');
    expect(ci).toContain('bash docs/audit/pg-bootstrap.sh');
    expect(ci).toContain('bash docs/audit/run-probes.sh');
    expect(await read('docs/audit/run-probes.sh')).toContain('probes=("$ROOT"/docs/audit/*-check.sql)');

    // The take-down probe: archive, status-off, hard delete, the blog mirror,
    // unpublish/delete, and rename-and-take-down in one UPDATE.
    const takeDown = await read('docs/audit/an-archived-page-takes-its-public-answers-with-it-check.sql');
    expect(takeDown).toMatch(/^rollback;\s*$/m);

    // The companion: a rename of a live page, the grant layer, the re-apply over
    // drifted data (by including the migration file itself), and a negative
    // control that restores the first cut's WHEN clause.
    const companion = await read('docs/audit/a-renamed-page-leaves-no-public-answer-behind-check.sql');
    expect(companion).toContain('\\ir ../../supabase/migrations/0383_an_archived_page_takes_its_public_answers_with_it.sql');
    expect(companion).toContain('has_function_privilege(\'anon\', \'public.retire_marketing_aeo_on_page_hidden()\', \'EXECUTE\')');
    expect(companion).toMatch(/Negative control/);
    expect(companion).toMatch(/^rollback;\s*$/m);
  });
});
