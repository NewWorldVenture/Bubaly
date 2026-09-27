-- ── An archived page takes its public answers with it (0383) ────────────────
--
-- Generated FAQ answers are separate rows in `public.marketing_aeo_questions`,
-- world-readable on ONE predicate since 0228 — `status = 'published'`, no join
-- back to the page that produced them. So when a marketing page or a blog post
-- is taken down, its answers used to stay on /faq, in every sibling article's
-- FAQ block and in the FAQPage structured data, citing a URL that now 404s.
-- Nothing downstream self-heals it: 0237's regeneration trigger is switched off
-- by `deleted_at`, and the job runners refuse a deleted page.
--
-- `supabase/migrations/0383_an_archived_page_takes_its_public_answers_with_it.sql`
-- makes the retirement a property of the TABLES: four triggers over two
-- SECURITY DEFINER functions move a taken-down page's own published answers to
-- 'answered' in the same statement as the take-down. This probe holds that
-- migration under two writers and one reader:
--
--   * `service_role` — the key that REALLY writes both tables in production.
--     requireMarketingAdmin returns createServiceClient() (lib/marketing/
--     admin.ts:24), so archivePlatformPage and updatePlatformPage write
--     marketing_pages as service_role, as do the blog content actions, the cron
--     worker and the backfill scripts. service_role has BYPASSRLS and full DML,
--     so it proves the triggers fire for the real writer — but it could run
--     them as SECURITY INVOKER just as well. Cases F, G and I–L.
--   * a signed-in SUPER ADMIN (`authenticated`, through RLS policy
--     `marketing_pages_admin_all`) — NOT the production writer but the STRICTER
--     case: a session that cannot update the answers itself (no write policy on
--     marketing_aeo_questions; control 6 checks that before anything is taken
--     down), so a retirement it causes can only be the definer's work. Put a
--     SECURITY INVOKER body back and B changes 0 answers and goes red. Cases
--     B–E and H.
--   * every "is it public" question is asked as `anon`, the key the public site
--     renders /faq and article FAQ blocks with.
--
-- PREMISE, not 0383 (asserted so a regression is loud, never credited to 0383):
--
--   A. nobody unprivileged can pull the lever: a signed-in non-admin and anon
--      archive, delete or unpublish nothing, and the answers stay up. That is
--      0237's `marketing_pages_admin_all` (is_super_admin()), blog_posts having
--      no write policy (00100) and marketing_aeo_questions having only its
--      SELECT policy (0228) — it holds with or without 0383, so its notice says
--      so rather than "OK 0383".
--
-- What it proves about 0383, in order:
--
--   S. the SHAPE 0383 leaves in the catalog is still there: its four triggers
--      (`trg_retire_marketing_aeo_on_page_hidden` / `_page_deleted` on
--      marketing_pages, `_post_unpublished` / `_post_deleted` on blog_posts),
--      each enabled, AFTER UPDATE or AFTER DELETE, FOR EACH ROW, and bound to
--      its own function, which is SECURITY DEFINER with `search_path` pinned.
--      A later migration's `drop trigger`, a `create or replace … security
--      invoker`, or an `alter table … disable trigger` is what this catches by
--      name; without it a dropped trigger shows up only as eleven behavioural
--      failures below and never says WHY. It is a 0383 failure, never a
--      control: the guard being absent is exactly what the probe exists to
--      report, so it is not UNPROVEN;
--   B. the Archive button's shape (`status = 'archived', deleted_at = now()`)
--      takes the page's `marketing_platform` answers — and their translations
--      (0277 gates a translation on its PARENT's status, so there is one place
--      that decides) — out of anon's reach, as 'answered', text intact,
--      `last_reviewed` stamped;
--      a hand-authored answer on the same path (no writer stamp), an in-progress
--      'drafting' row, and a still-live sibling page's answers are untouched;
--   C. a status-only take-down (`deleted_at` still null) does the same;
--   D. a hard DELETE of the page does the same;
--   E. archiving the platform MIRROR of a still-published blog post retires the
--      mirror's own answers and NOT the live post's `blog_aeo_v1` answers on the
--      same `source_path`;
--   F. unpublishing a blog post retires its `blog_aeo_v1` answers, leaves a live
--      post's alone, and leaves the `marketing_platform` answers on its path to
--      the page that owns them;
--   G. a hard DELETE of a blog post does the same;
--   H. ONE UPDATE that renames a page and takes it down together — the exact
--      shape `updatePlatformPage` submits (`slug`, `path` and `status` are in the
--      same form) — retires the answers filed under the page's OLD path, which is
--      where they are, AND a stamped answer already filed under the NEW path,
--      which no live page holds after the write. The header's promise is that
--      the take-down is "a property of the table … so there is no window" for
--      writers that never come through the action; a rename-and-hide from the
--      SQL editor, the cron worker or the legacy bridge is one of those. 0383's
--      first draft retired by NEW.path alone and failed H; the trigger now
--      retires `source_path in (old.path, new.path)`, and putting either
--      one-path body back turns H red;
--   I. the Archive button AS IT REALLY RUNS — service_role, archivePlatformPage's
--      exact UPDATE (`status = 'archived', deleted_at = now(), updated_by`,
--      `where id = … and deleted_at is null`) — retires the page's answers;
--   J. a rename of a page that STAYS live, onto a path that already carries a
--      published `marketing_platform` answer, leaves THAT answer published and
--      anon-visible (0383:129-135: a candidate path is retired "only while no
--      publicly resolvable page holds it" — "never an answer at a path another
--      live page has taken over", 0383:110-113) while the old path's answer
--      retires. Drop the `not exists` clause and J goes red;
--   K. a blog post RENAMED while it stays published (0383:205, `old.slug is
--      distinct from new.slug`) retires the `blog_aeo_v1` answers filed under
--      its OLD slug (0383:182, `'/blog/' || old.slug`) — they cite a URL no post
--      holds any more — and leaves a different live post's answers alone;
--   L. a blog post renamed AND unpublished in ONE UPDATE does the same.
--      Dropping the slug branch from 0383:205 turns K red; retiring by
--      `new.slug` at 0383:182 turns K and L red; F and G change no slug and
--      stay green under both, which is why K and L exist.
--
--   The EXECUTE revokes on the two trigger functions, and 0383 RE-APPLYING over
--   the two drifted shapes /admin/marketing/aeo can produce, are held by the
--   companion probe a-renamed-page-leaves-no-public-answer-behind-check.sql
--   (its section 2 holds the revokes; its section 3 is the `\ir` of 0383, and
--   its section 4 is the WHEN-clause negative control). 0383's own comment at 0383:222-223
--   names THIS file as the one that re-applies it; that pointer is wrong —
--   this file has no `\i`/`\ir` — and should name the companion. 0383:100-101
--   also says "anon and authenticated hold only SELECT on marketing_pages";
--   they do not: Supabase's default privileges (reproduced by
--   docs/audit/pg-bootstrap.sh) grant them full DML on every public table, and
--   control 2 and control 3 below land an authenticated UPDATE and DELETE on
--   marketing_pages. RLS (`marketing_pages_admin_all`, is_super_admin()) is
--   what keeps a non-admin out, which premise A holds.
--
-- ── THE NEGATIVE CONTROL RUNS FIRST ─────────────────────────────────────────
--
-- Every assertion below is "anon can no longer see it" or "its status moved",
-- and both can come true for reasons that have nothing to do with 0383: anon
-- lost SELECT on the answers, the take-down itself was refused (a revoked
-- UPDATE/DELETE grant, a column revoke, a dead `is_super_admin()` because the
-- jwt email is not read, an unrelated raising trigger) and the probe "found"
-- nothing, or some other trigger retires answers on EVERY page write. So before
-- anything is taken down:
--
--   1. anon can read every fixture answer, and the translation, that is about to
--      be retired — or its absence later proves nothing;
--   2. the SAME admin runs the SAME UPDATE on the SAME page with the SAME SET
--      list the admin's take-downs below use (`slug, path, status, deleted_at,
--      updated_by`), with the one thing the trigger keys on flipped — the new
--      row stays public. It MUST land (1 row), and the page's answers MUST still
--      be published and anon-visible afterwards;
--   2b. `service_role` runs the SAME UPDATE on the SAME page I archives, with
--      the union of I's and J's SET lists (updatePlatformPage's form columns
--      plus `deleted_at`), keeping the page public — MUST land, answers up;
--   3. the same admin DELETEs a page whose only answer carries no writer stamp —
--      the one thing the delete trigger keys on — and it MUST land, answer up;
--   4. `service_role` runs the unpublish UPDATE's SET list (`published`) with
--      the value kept true — MUST land, answers up;
--   4b. `service_role` runs K's and L's SET list (`slug, published`) on K's own
--      post with both values kept — MUST land, answers up;
--   5. `service_role` DELETEs a post whose only answer has no `blog_aeo_v1`
--      stamp — MUST land, answer up;
--   6. the admin's own session UPDATEs one of the answers directly — MUST change
--      0 rows (or be refused). If it could, B–E and H would no longer show that
--      the SECURITY DEFINER did the work: a SECURITY INVOKER body would pass too.
--
-- A revoked write grant, a column-level revoke on any of those columns, a
-- broken super-admin check, or a trigger that raises on every write turns the
-- control red and the probe says UNPROVEN instead of reporting a retirement it
-- could not have observed. A trigger that retires on EVERY write turns 2–5 red.
-- Controls 3 and 5 are NOT independent of 0383: its two delete triggers DO fire
-- on those deletes, and only their writer-stamp filter keeps the unstamped
-- answer up — so a red 3 or 5 names 0383's delete trigger as a suspect too.
-- Without 0383 the controls hold and B–L go red on their own assertions.
--
-- Everything runs inside one transaction and ends in `rollback`, so a re-run is
-- idempotent and nothing reaches the shared database. Every UUID here is in the
-- 00000000-0000-4000-8000-00000383a0xx block, every path and slug starts
-- `p0383-`.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/an-archived-page-takes-its-public-answers-with-it-check.sql

\set SA  '00000000-0000-4000-8000-00000383a001'
\set NU  '00000000-0000-4000-8000-00000383a002'
-- pages
\set PA  '00000000-0000-4000-8000-00000383a010'
\set PB  '00000000-0000-4000-8000-00000383a011'
\set PC  '00000000-0000-4000-8000-00000383a012'
\set PD  '00000000-0000-4000-8000-00000383a013'
\set PM  '00000000-0000-4000-8000-00000383a014'
\set PG  '00000000-0000-4000-8000-00000383a015'
\set PR  '00000000-0000-4000-8000-00000383a016'
\set PZ  '00000000-0000-4000-8000-00000383a017'
\set PS  '00000000-0000-4000-8000-00000383a018'
\set PN  '00000000-0000-4000-8000-00000383a019'
-- blog posts
\set SG  '00000000-0000-4000-8000-00000383a020'
\set SL  '00000000-0000-4000-8000-00000383a021'
\set SD  '00000000-0000-4000-8000-00000383a022'
\set SZ  '00000000-0000-4000-8000-00000383a023'
\set SK  '00000000-0000-4000-8000-00000383a024'
\set SU  '00000000-0000-4000-8000-00000383a025'

begin;

-- ── Fixtures, as postgres ───────────────────────────────────────────────────
insert into auth.users (id, email) values (:'SA', 'p0383-admin@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'NU', 'p0383-member@example.com') on conflict do nothing;
-- is_super_admin() reads the jwt EMAIL against this table; the member is absent.
insert into public.super_admins (email) values ('p0383-admin@example.com') on conflict do nothing;

insert into public.marketing_pages (id, page_type, slug, path, title, status) values
  (:'PA', 'feature', 'p0383-archive',        '/features/p0383-archive',        'P0383 archived feature',            'published'),
  (:'PB', 'feature', 'p0383-sibling',        '/features/p0383-sibling',        'P0383 still-live sibling',          'published'),
  (:'PC', 'feature', 'p0383-status',         '/features/p0383-status',         'P0383 status-only take-down',       'published'),
  (:'PD', 'feature', 'p0383-delete',         '/features/p0383-delete',         'P0383 hard-deleted feature',        'published'),
  (:'PZ', 'feature', 'p0383-delete-control', '/features/p0383-delete-control', 'P0383 delete control',              'published'),
  (:'PM', 'blog',    'p0383-live-post',      '/blog/p0383-live-post',          'P0383 mirror of a live post',       'published'),
  (:'PG', 'blog',    'p0383-gone-post',      '/blog/p0383-gone-post',          'P0383 mirror of an unpublished post','published'),
  (:'PR', 'feature', 'p0383-rename-old',     '/features/p0383-rename-old',     'P0383 renamed and taken down',      'published'),
  (:'PS', 'feature', 'p0383-sr-archive',     '/features/p0383-sr-archive',     'P0383 service-role archived feature','published'),
  (:'PN', 'feature', 'p0383-landing-old',    '/features/p0383-landing-old',    'P0383 renamed, stays live',         'published');

insert into public.blog_posts (id, slug, title, category, excerpt, published) values
  (:'SG', 'p0383-gone-post',           'P0383 post that gets unpublished', 'Organization', 'p0383', true),
  (:'SL', 'p0383-live-post',           'P0383 post that stays live',       'Organization', 'p0383', true),
  (:'SD', 'p0383-deleted-post',        'P0383 post that gets deleted',     'Organization', 'p0383', true),
  (:'SZ', 'p0383-delete-control-post', 'P0383 delete control post',        'Organization', 'p0383', true),
  (:'SK', 'p0383-renamed-post-old',    'P0383 post renamed, stays live',   'Organization', 'p0383', true),
  (:'SU', 'p0383-renamed-gone-old',    'P0383 post renamed and unpublished','Organization', 'p0383', true);

-- Stamped exactly as the two writers stamp them: runQuestions writes
-- metadata.source = 'marketing_platform'; deriveArticleAeoQuestions writes
-- metadata.seed = 'blog_aeo_v1'. '{}' is a hand-authored console answer.
insert into public.marketing_aeo_questions (id, question, answer, source_path, pattern, status, clarity_score, metadata) values
  ('00000000-0000-4000-8000-00000383a030', 'P0383 how does the archived feature work?', 'p0383 archived-feature answer', '/features/p0383-archive', 'faq', 'published', 85,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PA')),
  ('00000000-0000-4000-8000-00000383a031', 'P0383 hand-authored on the archived path?', 'p0383 hand-authored answer', '/features/p0383-archive', 'faq', 'published', 80, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000383a032', 'P0383 still being drafted?', 'p0383 drafting answer', '/features/p0383-archive', 'faq', 'drafting', 70,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PA')),
  ('00000000-0000-4000-8000-00000383a033', 'P0383 how does the sibling work?', 'p0383 sibling answer', '/features/p0383-sibling', 'faq', 'published', 84,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PB')),
  ('00000000-0000-4000-8000-00000383a034', 'P0383 status take-down?', 'p0383 status answer', '/features/p0383-status', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PC')),
  ('00000000-0000-4000-8000-00000383a035', 'P0383 hard delete?', 'p0383 delete answer', '/features/p0383-delete', 'faq', 'published', 82,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PD')),
  ('00000000-0000-4000-8000-00000383a036', 'P0383 mirror answer?', 'p0383 mirror answer', '/blog/p0383-live-post', 'faq', 'published', 81,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PM')),
  ('00000000-0000-4000-8000-00000383a037', 'P0383 live post answer?', 'p0383 live-post answer. Read the full guide at /blog/p0383-live-post.', '/blog/p0383-live-post', 'faq', 'published', 88,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-live-post', 'category', 'Organization', 'article', true)),
  ('00000000-0000-4000-8000-00000383a038', 'P0383 gone post answer?', 'p0383 gone-post answer. Read the full guide at /blog/p0383-gone-post.', '/blog/p0383-gone-post', 'faq', 'published', 88,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-gone-post', 'category', 'Organization', 'article', true)),
  ('00000000-0000-4000-8000-00000383a039', 'P0383 gone post, where to start?', 'p0383 gone-post start. Full guide: /blog/p0383-gone-post.', '/blog/p0383-gone-post', 'how_to', 'published', 86,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-gone-post', 'category', 'Organization', 'article', true)),
  ('00000000-0000-4000-8000-00000383a03a', 'P0383 deleted post answer?', 'p0383 deleted-post answer. Read the full guide at /blog/p0383-deleted-post.', '/blog/p0383-deleted-post', 'faq', 'published', 88,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-deleted-post', 'category', 'Organization', 'article', true)),
  ('00000000-0000-4000-8000-00000383a03b', 'P0383 gone post mirror answer?', 'p0383 gone-post mirror answer', '/blog/p0383-gone-post', 'faq', 'published', 81,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PG')),
  ('00000000-0000-4000-8000-00000383a03c', 'P0383 renamed page answer?', 'p0383 renamed-page answer', '/features/p0383-rename-old', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PR')),
  ('00000000-0000-4000-8000-00000383a03d', 'P0383 delete-control hand answer?', 'p0383 delete-control hand answer', '/features/p0383-delete-control', 'faq', 'published', 80, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000383a03e', 'P0383 delete-control post hand answer?', 'p0383 delete-control post hand answer', '/blog/p0383-delete-control-post', 'faq', 'published', 80, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000383a041', 'P0383 service-role archived answer?', 'p0383 service-role archived answer', '/features/p0383-sr-archive', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PS')),
  ('00000000-0000-4000-8000-00000383a042', 'P0383 live-rename old-path answer?', 'p0383 live-rename old-path answer', '/features/p0383-landing-old', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PN')),
  ('00000000-0000-4000-8000-00000383a043', 'P0383 answer already at the path a live page renames onto?', 'p0383 landing-new answer', '/features/p0383-landing-new', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PN')),
  ('00000000-0000-4000-8000-00000383a044', 'P0383 answer already at the path a hidden page renames onto?', 'p0383 rename-new answer', '/features/p0383-rename-new', 'faq', 'published', 83,
     jsonb_build_object('source', 'marketing_platform', 'page_id', :'PR')),
  ('00000000-0000-4000-8000-00000383a045', 'P0383 renamed live post answer?', 'p0383 renamed-post answer. Read the full guide at /blog/p0383-renamed-post-old.', '/blog/p0383-renamed-post-old', 'faq', 'published', 88,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-renamed-post-old', 'category', 'Organization', 'article', true)),
  ('00000000-0000-4000-8000-00000383a046', 'P0383 renamed-and-unpublished post answer?', 'p0383 renamed-gone answer. Read the full guide at /blog/p0383-renamed-gone-old.', '/blog/p0383-renamed-gone-old', 'faq', 'published', 88,
     jsonb_build_object('seed', 'blog_aeo_v1', 'slug', 'p0383-renamed-gone-old', 'category', 'Organization', 'article', true));

insert into public.marketing_aeo_question_translations (id, question_id, locale, question, answer, source) values
  ('00000000-0000-4000-8000-00000383a040', '00000000-0000-4000-8000-00000383a030', 'de-DE', 'P0383 Wie funktioniert es?', 'p0383 Antwort', 'human');

do $probe$
declare
  n int;
  s text;
  txt text;
  lr timestamptz;
  failures text[] := '{}';
  mark int;
  control_ok boolean := true;
  r record;

  sa  constant uuid := '00000000-0000-4000-8000-00000383a001';
  nu  constant uuid := '00000000-0000-4000-8000-00000383a002';
  pa  constant uuid := '00000000-0000-4000-8000-00000383a010';
  pb  constant uuid := '00000000-0000-4000-8000-00000383a011';
  pc  constant uuid := '00000000-0000-4000-8000-00000383a012';
  pd  constant uuid := '00000000-0000-4000-8000-00000383a013';
  pm  constant uuid := '00000000-0000-4000-8000-00000383a014';
  pr  constant uuid := '00000000-0000-4000-8000-00000383a016';
  pz  constant uuid := '00000000-0000-4000-8000-00000383a017';
  ps  constant uuid := '00000000-0000-4000-8000-00000383a018';
  pn  constant uuid := '00000000-0000-4000-8000-00000383a019';

  qa1 constant uuid := '00000000-0000-4000-8000-00000383a030';  -- PA, marketing_platform
  qa2 constant uuid := '00000000-0000-4000-8000-00000383a031';  -- PA path, hand-authored
  qa3 constant uuid := '00000000-0000-4000-8000-00000383a032';  -- PA, drafting
  qb1 constant uuid := '00000000-0000-4000-8000-00000383a033';  -- PB (live sibling)
  qc1 constant uuid := '00000000-0000-4000-8000-00000383a034';  -- PC
  qd1 constant uuid := '00000000-0000-4000-8000-00000383a035';  -- PD
  qm1 constant uuid := '00000000-0000-4000-8000-00000383a036';  -- PM mirror, marketing_platform
  ql1 constant uuid := '00000000-0000-4000-8000-00000383a037';  -- live post, blog_aeo_v1
  qs1 constant uuid := '00000000-0000-4000-8000-00000383a038';  -- gone post, blog_aeo_v1
  qs2 constant uuid := '00000000-0000-4000-8000-00000383a039';  -- gone post, blog_aeo_v1
  qx1 constant uuid := '00000000-0000-4000-8000-00000383a03a';  -- deleted post, blog_aeo_v1
  qg1 constant uuid := '00000000-0000-4000-8000-00000383a03b';  -- gone post's mirror, marketing_platform
  qr1 constant uuid := '00000000-0000-4000-8000-00000383a03c';  -- PR old path (renamed + taken down)
  qz1 constant uuid := '00000000-0000-4000-8000-00000383a03d';  -- PZ path, hand-authored
  qy1 constant uuid := '00000000-0000-4000-8000-00000383a03e';  -- SZ path, hand-authored
  qi1 constant uuid := '00000000-0000-4000-8000-00000383a041';  -- PS (service_role archive)
  qj1 constant uuid := '00000000-0000-4000-8000-00000383a042';  -- PN old path (live rename)
  qj2 constant uuid := '00000000-0000-4000-8000-00000383a043';  -- PN NEW path, filed before the rename
  qh2 constant uuid := '00000000-0000-4000-8000-00000383a044';  -- PR NEW path, filed before the rename
  qk1 constant uuid := '00000000-0000-4000-8000-00000383a045';  -- SK old slug (renamed, stays live)
  qu1 constant uuid := '00000000-0000-4000-8000-00000383a046';  -- SU old slug (renamed + unpublished)
  t1  constant uuid := '00000000-0000-4000-8000-00000383a040';  -- de-DE translation of qa1

  admin_claims  constant text := json_build_object('sub', '00000000-0000-4000-8000-00000383a001', 'email', 'p0383-admin@example.com',  'role', 'authenticated')::text;
  member_claims constant text := json_build_object('sub', '00000000-0000-4000-8000-00000383a002', 'email', 'p0383-member@example.com', 'role', 'authenticated')::text;
  all_public uuid[];
  kept_public uuid[];
begin
  all_public := array[qa1, qa2, qb1, qc1, qd1, qm1, ql1, qs1, qs2, qx1, qg1, qr1, qz1, qy1,
                      qi1, qj1, qj2, qh2, qk1, qu1];
  -- Everything except the two unstamped answers under the page and post the
  -- controls DELETE (qz1, qy1): 0383's WHEN clauses keep its update triggers
  -- from firing on controls 2, 2b, 4 and 4b at all, so a retirement here is
  -- not 0383's delete path.
  kept_public := array[qa1, qa2, qb1, qc1, qd1, qm1, ql1, qs1, qs2, qx1, qg1, qr1,
                       qi1, qj1, qj2, qh2, qk1, qu1];

  -- ═══ NEGATIVE CONTROL — runs first ═════════════════════════════════════════

  -- 1. anon can see everything that is about to be retired.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    select count(*) into n from public.marketing_aeo_questions where id = any(all_public);
    if n <> array_length(all_public, 1) then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: anon sees %s of the %s published fixture answers BEFORE any take-down, so an answer "disappearing" later would prove nothing about 0383', n, array_length(all_public, 1)));
    end if;
    select count(*) into n from public.marketing_aeo_question_translations where id = t1;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: anon cannot see the de-DE translation of a published answer, so its absence after the archive would prove nothing');
    end if;
  exception when insufficient_privilege then
    -- anon lost SELECT on the answers or the translations outright (0228/0277
    -- grant it): every "anon can no longer see it" below would be vacuous.
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: anon cannot read the answers or their translations at all — %s: %s — so every "no longer world-readable" assertion below would hold for a reason that is not 0383', sqlstate, sqlerrm));
  end;

  -- 2. The same admin, the same UPDATE, the same SET list the take-downs write,
  --    with the new row still public. Must land, and must retire nothing.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  begin
    update public.marketing_pages
       set slug = 'p0383-archive', path = '/features/p0383-archive',
           status = 'published', deleted_at = null, updated_by = sa
     where id = pa and deleted_at is null;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the super admin''s UPDATE of a published page that keeps it published changed %s rows (expected 1) — this session cannot write marketing_pages at all, so every take-down below would change nothing and prove nothing', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: the super admin''s UPDATE of a published page that keeps it published (the SAME columns the archive writes: slug, path, status, deleted_at, updated_by) was refused — %s: %s. A take-down below would be refused the same way, for a reason that is not 0383', sqlstate, sqlerrm));
  end;

  -- 3. The same admin DELETEs a page whose only answer carries no writer stamp.
  begin
    delete from public.marketing_pages where id = pz;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the super admin''s DELETE of a page removed %s rows (expected 1), so the hard-delete retirement below could not be observed', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: the super admin''s DELETE of a page was refused — %s: %s', sqlstate, sqlerrm));
  end;

  -- 2b, 4, 4b & 5. service_role — the key that really writes both tables.
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- 2b. The SAME row I archives, every column I (archivePlatformPage) and J
  --     (updatePlatformPage) write, with the page kept public.
  begin
    update public.marketing_pages
       set page_type = 'feature', slug = 'p0383-sr-archive', path = '/features/p0383-sr-archive',
           title = 'P0383 service-role archived feature', summary = null, body = null,
           status = 'published', published_at = null, deleted_at = null, updated_by = sa
     where id = ps and deleted_at is null;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of a published page that keeps it published changed %s rows (expected 1), so the service_role take-down (I) and rename (J) below could not be observed', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of a published page that keeps it published (page_type, slug, path, title, summary, body, status, published_at, deleted_at, updated_by) was refused — %s: %s. I and J below would be refused the same way, for a reason that is not 0383', sqlstate, sqlerrm));
  end;

  -- 4. The unpublish SET list with the value kept.
  begin
    update public.blog_posts set published = true where slug = 'p0383-gone-post';
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of blog_posts.published (value kept true) changed %s rows (expected 1)', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of blog_posts.published (value kept true) was refused — %s: %s. The unpublish below would be refused the same way, for a reason that is not 0383', sqlstate, sqlerrm));
  end;

  -- 4b. K's and L's SET list (slug, published) on K's own post, both kept.
  begin
    update public.blog_posts set slug = 'p0383-renamed-post-old', published = true where slug = 'p0383-renamed-post-old';
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of blog_posts.slug and .published (both kept) changed %s rows (expected 1), so the blog renames (K, L) below could not be observed', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: service_role''s UPDATE of blog_posts.slug and .published (both kept) was refused — %s: %s. The renames below would be refused the same way, for a reason that is not 0383', sqlstate, sqlerrm));
  end;

  -- 5. A DELETE of a post whose only answer has no blog stamp.
  begin
    delete from public.blog_posts where slug = 'p0383-delete-control-post';
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: service_role''s DELETE of a blog post removed %s rows (expected 1)', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: service_role''s DELETE of a blog post was refused — %s: %s', sqlstate, sqlerrm));
  end;

  -- …and none of 2–5 may have retired anything: every answer is still up.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    select count(*) into n from public.marketing_aeo_questions where id = any(kept_public);
    if n <> array_length(kept_public, 1) then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: after UPDATEs that kept every page and post public (controls 2, 2b, 4, 4b — 0383''s WHEN clauses do not fire on any of them), anon sees %s of %s answers — some trigger outside 0383, or a 0383 WHEN clause widened to fire on every write, retires answers while their page is live, so the retirements below cannot be credited to 0383''s take-down guard', n, array_length(kept_public, 1)));
    end if;
    select count(*) into n from public.marketing_aeo_questions where id in (qz1, qy1);
    if n <> 2 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: after DELETEs of a page and a post whose only answers carry NO writer stamp (controls 3 and 5), anon sees %s of 2 of those answers. 0383''s own delete triggers (trg_retire_marketing_aeo_on_page_deleted, trg_retire_marketing_aeo_on_post_deleted) DO fire on these deletes, so the suspect is 0383 itself — its metadata.source / metadata.seed filter no longer scopes the retirement to its own rows — or another delete trigger that retires answers', n));
    end if;
  exception when insufficient_privilege then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: anon cannot read the answers after the public-keeping writes — %s: %s — so nothing below could be observed as anon', sqlstate, sqlerrm));
  end;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qa1;
  if s is distinct from 'published' then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: a page edit that kept the page public moved its answer to %s', coalesce(s, '<missing>')));
  end if;

  -- 6. The admin's own session cannot retire an answer directly. If it could,
  --    the retirements B–E and H observe would not show the SECURITY DEFINER
  --    doing the work: a SECURITY INVOKER body would retire them just as well.
  --    Runs after the "nothing retired" check so a landed write here is not
  --    double-reported as a retirement.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  begin
    update public.marketing_aeo_questions set status = 'answered' where id = qa1;
    get diagnostics n = row_count;
    if n <> 0 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: the super admin''s own session can now UPDATE marketing_aeo_questions directly — the premise that B–E and H prove the definer trigger (not the caller) did the retirement has changed; revisit this probe');
    end if;
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);
  if not control_ok then
    raise exception '0383 retirement UNPROVEN (a control this probe rests on did not hold; each CONTROL FAILED line says whether the cause lies outside 0383 or in 0383''s own triggers): %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK 0383 control: the super admin and service_role can write marketing_pages with every column the take-downs write, service_role can write blog_posts (published and slug), both can delete, none of those writes retires an answer while the page stays public, and the admin''s own session cannot write an answer directly';

  -- ═══ S. 0383's SHAPE is in the catalog as the migration leaves it ═════════
  -- The assertions 0383 itself makes: four row-level AFTER triggers, two
  -- SECURITY DEFINER functions with a pinned search_path, each trigger bound to
  -- its own function. tgtype bits: 1 = FOR EACH ROW, 2 = BEFORE, 8 = DELETE,
  -- 16 = UPDATE. A missing or disabled trigger is a 0383 failure by name, so a
  -- later `drop trigger` is reported as what it is rather than as B–L all red.
  mark := coalesce(array_length(failures, 1), 0);
  for r in
    select v.tg, v.tbl, v.fn, v.ev, v.evbit,
           t.oid as tgoid, t.tgenabled, t.tgtype, p.proname, p.prosecdef, p.proconfig
      from (values
        ('trg_retire_marketing_aeo_on_page_hidden',      'marketing_pages', 'retire_marketing_aeo_on_page_hidden',      'UPDATE', 16),
        ('trg_retire_marketing_aeo_on_page_deleted',     'marketing_pages', 'retire_marketing_aeo_on_page_hidden',      'DELETE', 8),
        ('trg_retire_marketing_aeo_on_post_unpublished', 'blog_posts',      'retire_marketing_aeo_on_post_unpublished', 'UPDATE', 16),
        ('trg_retire_marketing_aeo_on_post_deleted',     'blog_posts',      'retire_marketing_aeo_on_post_unpublished', 'DELETE', 8)
      ) as v(tg, tbl, fn, ev, evbit)
      left join pg_trigger t on t.tgname = v.tg and t.tgrelid = ('public.' || v.tbl)::regclass and not t.tgisinternal
      left join pg_proc p on p.oid = t.tgfoid
  loop
    if r.tgoid is null then
      failures := array_append(failures, format('S (0383 shape): trigger %s on public.%s is MISSING — the %s take-down is no longer a property of the table', r.tg, r.tbl, r.ev));
      continue;
    end if;
    if r.tgenabled = 'D' then
      failures := array_append(failures, format('S (0383 shape): trigger %s on public.%s is DISABLED', r.tg, r.tbl));
    end if;
    if (r.tgtype & 2) <> 0 or (r.tgtype & 1) = 0 or (r.tgtype & r.evbit) = 0 then
      failures := array_append(failures, format('S (0383 shape): trigger %s on public.%s is not AFTER %s FOR EACH ROW (tgtype %s)', r.tg, r.tbl, r.ev, r.tgtype));
    end if;
    if r.proname is distinct from r.fn then
      failures := array_append(failures, format('S (0383 shape): trigger %s on public.%s calls %s, expected public.%s', r.tg, r.tbl, coalesce(r.proname, '<none>'), r.fn));
    end if;
  end loop;
  -- Each function backs two triggers, so its own properties are checked once.
  for r in
    select v.fn, p.oid as fnoid, p.prosecdef, p.proconfig
      from (values ('retire_marketing_aeo_on_page_hidden'), ('retire_marketing_aeo_on_post_unpublished')) as v(fn)
      left join pg_proc p on p.proname = v.fn and p.pronamespace = 'public'::regnamespace and p.pronargs = 0
  loop
    if r.fnoid is null then
      failures := array_append(failures, format('S (0383 shape): function public.%s() is MISSING', r.fn));
      continue;
    end if;
    if not r.prosecdef then
      failures := array_append(failures, format('S (0383 shape): public.%s() is SECURITY INVOKER — a writer that can update the page but not the answers half-applies the take-down (B–E and H go red below for the same reason)', r.fn));
    end if;
    if not exists (select 1 from unnest(coalesce(r.proconfig, '{}'::text[])) c where c like 'search_path=%') then
      failures := array_append(failures, format('S (0383 shape): public.%s() has no pinned search_path (0383 sets it, matching 0237''s trigger functions)', r.fn));
    end if;
  end loop;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 S: the four retirement triggers are present, enabled, AFTER … FOR EACH ROW on their tables, and bound to SECURITY DEFINER functions with a pinned search_path';
  end if;

  -- ═══ A. PREMISE (0237, 00100, 0228 — not 0383): nobody unprivileged can pull the lever
  mark := coalesce(array_length(failures, 1), 0);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', member_claims, true);
  perform set_config('request.jwt.claim.sub', nu::text, true);
  begin
    update public.marketing_pages set status = 'archived', deleted_at = now(), updated_by = nu where id = pa;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('A (premise, 0237 not 0383): a signed-in NON-admin archived %s marketing page(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.marketing_pages where id = pb;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('A (premise, 0237 not 0383): a signed-in NON-admin deleted %s marketing page(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.blog_posts set published = false where slug = 'p0383-gone-post';
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('A (premise, 00100 not 0383): a signed-in NON-admin unpublished %s blog post(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    update public.marketing_pages set status = 'archived', deleted_at = now() where id = pa;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('A (premise, 0237 not 0383): anon archived %s marketing page(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.blog_posts where slug = 'p0383-live-post';
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('A (premise, 00100 not 0383): anon deleted %s blog post(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  select count(*) into n from public.marketing_aeo_questions where id = any(all_public);
  if n <> array_length(all_public, 1) then
    failures := array_append(failures, format('A (premise, not 0383): after refused attempts by a non-admin and anon, anon sees %s of %s answers — an unprivileged caller retired public answers', n, array_length(all_public, 1)));
  end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK premise A (held by 0237/00100/0228, not by 0383): a signed-in non-admin and anon archive, delete and unpublish nothing';
  end if;

  -- ═══ B. The Archive button: status = 'archived', deleted_at = now() ═══════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  update public.marketing_pages
     set status = 'archived', deleted_at = now(), updated_by = sa
   where id = pa and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('B: the admin''s archive changed %s rows (expected 1)', n)); end if;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qa1;
  if n <> 0 then failures := array_append(failures, 'B: an ARCHIVED page''s generated answer is still world-readable — /faq and every sibling article keep citing a page that is gone'); end if;
  select count(*) into n from public.marketing_aeo_question_translations where id = t1;
  if n <> 0 then failures := array_append(failures, 'B: the de-DE translation of an archived page''s answer is still world-readable'); end if;
  select count(*) into n from public.marketing_aeo_questions where id in (qa2, qb1);
  if n <> 2 then failures := array_append(failures, format('B: archiving one page took down %s of 2 answers it does not own (a hand-authored answer on its path, a live sibling''s answer) — the retirement is too wide', 2 - n)); end if;

  perform set_config('role', 'postgres', true);
  select status, answer, last_reviewed into s, txt, lr from public.marketing_aeo_questions where id = qa1;
  if s is distinct from 'answered' then failures := array_append(failures, format('B: the archived page''s answer is %s, expected ''answered'' (retired, not destroyed)', coalesce(s, '<deleted>'))); end if;
  if txt is distinct from 'p0383 archived-feature answer' then failures := array_append(failures, 'B: the archived page''s answer text did not survive the retirement'); end if;
  if lr is null then failures := array_append(failures, 'B: the retired answer has no last_reviewed stamp'); end if;
  select status into s from public.marketing_aeo_questions where id = qa3;
  if s is distinct from 'drafting' then failures := array_append(failures, format('B: an in-progress ''drafting'' answer on the archived page was moved to %s', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 B: archiving a page (status archived, deleted_at set) retires its marketing_platform answers and their translations to ''answered'', text intact; a hand-authored answer on its path, a drafting row and a live sibling are untouched';
  end if;

  -- ═══ C. Status-only take-down: deleted_at stays null ═════════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  update public.marketing_pages set status = 'draft', updated_by = sa where id = pc and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('C: the admin''s status take-down changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qc1;
  if n <> 0 then failures := array_append(failures, 'C: a page moved from published to draft (deleted_at still null) left its generated answer world-readable'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qc1;
  if s is distinct from 'answered' then failures := array_append(failures, format('C: the status-take-down page''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 C: moving a page off ''published'' without deleting it retires its answers';
  end if;

  -- ═══ D. Hard DELETE of the page ══════════════════════════════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  delete from public.marketing_pages where id = pd;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('D: the admin''s DELETE changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qd1;
  if n <> 0 then failures := array_append(failures, 'D: a hard-DELETED page''s generated answer is still world-readable, with no page left to point any orphan check at'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = qz1;
  if n <> 1 then failures := array_append(failures, 'D: the control page''s hand-authored answer was taken down by its page''s delete'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qd1;
  if s is distinct from 'answered' then failures := array_append(failures, format('D: the deleted page''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 D: hard-deleting a page retires its generated answers, and only those';
  end if;

  -- ═══ E. Archiving the platform MIRROR of a still-published post ══════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  update public.marketing_pages set status = 'archived', deleted_at = now(), updated_by = sa where id = pm and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('E: the admin''s archive of the mirror page changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qm1;
  if n <> 0 then failures := array_append(failures, 'E: the archived mirror page''s own marketing_platform answer is still world-readable'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = ql1;
  if n <> 1 then failures := array_append(failures, 'E: archiving the platform MIRROR row stripped the still-published article''s blog_aeo_v1 answer from its FAQ block — the retirement reached rows the page does not own'); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 E: archiving a live post''s platform mirror retires the mirror''s answers and leaves the live article''s blog_aeo_v1 answers public';
  end if;

  -- ═══ F. Unpublishing a blog post ═════════════════════════════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.blog_posts set published = false where slug = 'p0383-gone-post';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('F: service_role''s unpublish changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id in (qs1, qs2);
  if n <> 0 then failures := array_append(failures, format('F: %s blog_aeo_v1 answer(s) of an UNPUBLISHED post are still world-readable, each ending "Read the full guide at" a URL that 404s', n)); end if;
  select count(*) into n from public.marketing_aeo_questions where id = ql1;
  if n <> 1 then failures := array_append(failures, 'F: unpublishing one post took down a different, live post''s answer'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = qg1;
  if n <> 1 then failures := array_append(failures, 'F: unpublishing a post retired the marketing_platform answer its still-published MIRROR page owns — the blog trigger reached rows it does not own'); end if;
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.marketing_aeo_questions where id in (qs1, qs2) and status = 'answered';
  if n <> 2 then failures := array_append(failures, format('F: %s of 2 unpublished-post answers are ''answered''', n)); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 F: unpublishing a post retires its blog_aeo_v1 answers, and not a live post''s or its mirror page''s';
  end if;

  -- ═══ G. Hard DELETE of a blog post ═══════════════════════════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.blog_posts where slug = 'p0383-deleted-post';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('G: service_role''s DELETE of a post changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qx1;
  if n <> 0 then failures := array_append(failures, 'G: a hard-DELETED post''s blog_aeo_v1 answer is still world-readable'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = qy1;
  if n <> 1 then failures := array_append(failures, 'G: the control post''s hand-authored answer was taken down by its post''s delete'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qx1;
  if s is distinct from 'answered' then failures := array_append(failures, format('G: the deleted post''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 G: hard-deleting a post retires its blog_aeo_v1 answers, and only those';
  end if;

  -- ═══ H. Rename and take down in ONE update ═══════════════════════════════
  -- updatePlatformPage writes slug, path and status from one form, and its own
  -- comment records why: "one submit can rename the page and take it down
  -- together, and the answers still carry the old `source_path`. Retiring by the
  -- recomputed path alone retired nothing." A writer that is NOT that action —
  -- the case 0383 exists for — gets only the table's guarantee. The trigger
  -- retires `source_path in (old.path, new.path)`: qr1 holds the OLD member,
  -- qh2 (a stamped answer already filed under the NEW path, which no live page
  -- holds once this page is hidden) holds the NEW one.
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', admin_claims, true);
  perform set_config('request.jwt.claim.sub', sa::text, true);
  update public.marketing_pages
     set slug = 'p0383-rename-new', path = '/features/p0383-rename-new',
         status = 'draft', updated_by = sa
   where id = pr and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('H: the admin''s rename-and-take-down changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qr1;
  if n <> 0 then failures := array_append(failures, 'H: a page renamed AND taken down in one UPDATE left its generated answer world-readable under the OLD path (/features/p0383-rename-old) — the answers are filed under the path the page HAD, and retiring by NEW.path finds none of them'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = qh2;
  if n <> 0 then failures := array_append(failures, 'H: a stamped answer already filed under the NEW path (/features/p0383-rename-new) is still world-readable after the page took that path and was hidden in the same UPDATE — no live page holds it, and the trigger no longer retires `new.path`'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qr1;
  if s is distinct from 'answered' then failures := array_append(failures, format('H: the renamed-and-hidden page''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  select status into s from public.marketing_aeo_questions where id = qh2;
  if s is distinct from 'answered' then failures := array_append(failures, format('H: the answer under the renamed-and-hidden page''s NEW path is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 H: renaming and taking down a page in one UPDATE retires the answers filed under its old path and under its new one';
  end if;

  -- ═══ I. The Archive button as it really runs: service_role ═══════════════
  -- archivePlatformPage: .update({ status: 'archived', deleted_at, updated_by })
  --   .eq('id', id).is('deleted_at', null), on requireMarketingAdmin's
  --   createServiceClient().
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.marketing_pages
     set status = 'archived', deleted_at = now(), updated_by = sa
   where id = ps and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('I: service_role''s archive changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qi1;
  if n <> 0 then failures := array_append(failures, 'I: a page archived by service_role — the key archivePlatformPage really writes with — left its generated answer world-readable'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qi1;
  if s is distinct from 'answered' then failures := array_append(failures, format('I: the service_role-archived page''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 I: archiving a page as service_role (archivePlatformPage''s own UPDATE) retires its answers';
  end if;

  -- ═══ J. A live rename onto a path that already carries a published answer
  -- updatePlatformPage's full SET list, status kept 'published'. The trigger
  -- fires (old.path is distinct from new.path) with candidates old and new; the
  -- `not exists` clause is what keeps qj2 — at a path a live page now holds —
  -- published.
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.marketing_pages
     set page_type = 'feature', slug = 'p0383-landing-new', path = '/features/p0383-landing-new',
         title = 'P0383 renamed, stays live', summary = null, body = null,
         status = 'published', published_at = now(), updated_by = sa
   where id = pn and deleted_at is null;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('J: service_role''s live rename changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qj2;
  if n <> 1 then failures := array_append(failures, 'J: a live page renamed onto /features/p0383-landing-new took down the published answer ALREADY filed under that path — a path a live page now holds; 0383 promises "never an answer at a path another live page has taken over" (its `not exists` clause)'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = qj1;
  if n <> 0 then failures := array_append(failures, 'J: a live page''s rename left its answer world-readable under the OLD path, which no page holds any more'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qj2;
  if s is distinct from 'published' then failures := array_append(failures, format('J: the answer at the path the live page renamed onto is %s, expected ''published''', coalesce(s, '<deleted>'))); end if;
  select status into s from public.marketing_aeo_questions where id = qj1;
  if s is distinct from 'answered' then failures := array_append(failures, format('J: the live-renamed page''s old-path answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 J: a live rename retires the old path''s answers and leaves a published answer at the path the live page now holds';
  end if;

  -- ═══ K. A blog post renamed while it stays published ═════════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.blog_posts set slug = 'p0383-renamed-post-new' where slug = 'p0383-renamed-post-old';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('K: service_role''s slug rename changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qk1;
  if n <> 0 then failures := array_append(failures, 'K: a published post renamed to a new slug left its blog_aeo_v1 answer world-readable under the OLD slug (/blog/p0383-renamed-post-old), "Read the full guide at" a URL no post holds'); end if;
  select count(*) into n from public.marketing_aeo_questions where id = ql1;
  if n <> 1 then failures := array_append(failures, 'K: renaming one post took down a different, live post''s answer'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qk1;
  if s is distinct from 'answered' then failures := array_append(failures, format('K: the renamed post''s old-slug answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 K: renaming a published post retires the blog_aeo_v1 answers filed under its old slug, and not a live post''s';
  end if;

  -- ═══ L. A blog post renamed AND unpublished in ONE update ════════════════
  mark := coalesce(array_length(failures, 1), 0);
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.blog_posts set slug = 'p0383-renamed-gone-new', published = false where slug = 'p0383-renamed-gone-old';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('L: service_role''s rename-and-unpublish changed %s rows (expected 1)', n)); end if;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.marketing_aeo_questions where id = qu1;
  if n <> 0 then failures := array_append(failures, 'L: a post renamed AND unpublished in one UPDATE left its blog_aeo_v1 answer world-readable under the OLD slug (/blog/p0383-renamed-gone-old) — retiring by NEW.slug finds none of them'); end if;
  perform set_config('role', 'postgres', true);
  select status into s from public.marketing_aeo_questions where id = qu1;
  if s is distinct from 'answered' then failures := array_append(failures, format('L: the renamed-and-unpublished post''s answer is %s, expected ''answered''', coalesce(s, '<deleted>'))); end if;
  if coalesce(array_length(failures, 1), 0) = mark then
    raise notice 'OK 0383 L: renaming and unpublishing a post in one UPDATE retires the answers filed under its old slug';
  end if;

  perform set_config('role', 'postgres', true);
  if array_length(failures, 1) is not null then
    raise exception '0383 an archived page takes its public answers with it — FAILED: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK 0383: a page or post leaving the public set — archived, moved off published, unpublished, hard-deleted, or renamed on the way out or while live — takes exactly its own generated answers with it, in the same statement, whether the writer is service_role or the admin''s own RLS-bound session';
end
$probe$;

rollback;
