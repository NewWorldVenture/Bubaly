-- Bubaly :: 0355 an archived page takes its public answers with it
-- ----------------------------------------------------------------------------
-- Generated FAQ answers do not live in the page row. They are separate rows in
-- `public.marketing_aeo_questions`, and migration 0228 made them world-readable
-- on ONE predicate:
--
--     create policy marketing_aeo_public_read on public.marketing_aeo_questions
--       for select to anon, authenticated using (status = 'published');
--
-- There is no join back to the source page. So when a page leaves the public
-- set, its answers do not. `marketing_pages_public_read` (0237) hides the page
-- itself with `status = 'published' and deleted_at is null`, and the archived
-- page's own route goes dark — but the answers keep rendering:
--
--   * /faq's "Knowledge Center" tab lists them (readPublishedAeoQuestions), and
--     folds them into the page's FAQPage structured data submitted to search
--     engines;
--   * every OTHER, still-live article in the same category renders them in its
--     own 4-slot FAQ block and FAQPage schema, because the blog rows carry
--     `metadata.category` (readAeoQuestionsForCategory);
--   * for a blog article the answer body itself ends "Read the full guide at
--     /blog/<slug>", so a public answer cites a URL that now calls notFound().
--
-- NOTHING SELF-HEALS IT. The regeneration trigger that would rewrite the rows is
-- switched off for exactly this case — 0237's update trigger fires only
-- `when (new.updated_by is not null and new.deleted_at is null and new.version
-- is distinct from old.version)`, and archiving sets `deleted_at`. Belt and
-- braces, `runQuestions` and `runRegeneration` both select the page
-- `.is('deleted_at', null)`, so even a hand-retried job cannot reach them. And
-- the blog-seeded rows are out of `runQuestions`' reach in any case: its delete
-- is scoped `.contains('metadata', {source: 'marketing_platform'})`, while the
-- blog writer stamps `metadata.seed = 'blog_aeo_v1'`.
--
-- ── WHY THIS IS SQL AND NOT ONLY TYPESCRIPT ──────────────────────────────────
--
-- The server actions were fixed in the same change (archivePlatformPage,
-- updatePlatformPage, archiveContentAction, unpublishBlogPostAction, and the
-- three take-down paths in lib/marketing/legacy-bridge.ts). That is the fast
-- path, but it is not the guarantee: `marketing_pages` and `blog_posts` are also
-- written by the cron worker, by scripts/backfill-*.mjs, by the legacy bridge's
-- upserts and by hand in the SQL editor. A retirement that lives only in an
-- action is skipped by every one of those. Here it is a property of the table,
-- applied inside the same transaction as the take-down, so there is no window.
--
-- 'answered' rather than a delete: that is the status runQuestions itself writes
-- for a page that is not published (`page.status === 'published' ? 'published' :
-- 'answered'`). The editorial text survives for a later re-publish, it stays
-- visible and editable in /admin/marketing/aeo, and it leaves the public set.
-- Only PUBLISHED rows are moved, so an 'opportunity' or 'drafting' row an admin
-- is mid-way through keeps its own status.
--
-- Fully replay-safe: `create or replace function`, `drop trigger if exists`
-- before each `create trigger`, and a backfill that is idempotent because it
-- only ever moves rows OUT of 'published'.
-- ============================================================================

-- ── 1. Retire the orphans that already exist in production ──────────────────
-- A published answer whose source page is not publicly resolvable. Scoped to
-- the two generated writers by their own metadata stamps, so hand-authored
-- console answers (which carry neither) are never touched.

update public.marketing_aeo_questions q
   set status = 'answered',
       last_reviewed = now()
 where q.status = 'published'
   and q.source_path is not null
   and q.metadata->>'source' = 'marketing_platform'
   and not exists (
     select 1 from public.marketing_pages p
      where p.path = q.source_path
        and p.status = 'published'
        and p.deleted_at is null
   );

update public.marketing_aeo_questions q
   set status = 'answered',
       last_reviewed = now()
 where q.status = 'published'
   and q.source_path like '/blog/%'
   and q.metadata->>'seed' = 'blog_aeo_v1'
   and not exists (
     select 1 from public.blog_posts b
      where '/blog/' || b.slug = q.source_path
        and b.published
   );

-- ── 2. A page leaving the public set takes ITS OWN answers with it ─────────
-- Each of the two writers owns only the rows it stamped, and nothing else:
--
--   marketing_pages  owns  metadata.source = 'marketing_platform'  (runQuestions)
--   blog_posts       owns  metadata.seed   = 'blog_aeo_v1'         (deriveArticleAeoQuestions)
--
-- Both writers use the same `source_path` for a /blog/<slug>, so a wider scope
-- here would be a second bug in the other direction: archiving the platform
-- MIRROR row of a still-published article would strip that live article's FAQ
-- block. A blog row's liveness is `blog_posts.published`, and part 3 enforces it.
--
-- SECURITY DEFINER so the retirement cannot be half-applied by a writer that can
-- update the page but not the answers; `search_path` is pinned, matching 0237's
-- own trigger functions. anon and authenticated hold only SELECT on
-- marketing_pages, so no unprivileged caller can reach this at all.

-- The answers are filed under the path the page had WHEN THEY WERE WRITTEN, i.e.
-- OLD.path. The admin form carries `slug` and `status` together, so one save can
-- rename a page and take it down in the same UPDATE; retiring by NEW.path alone
-- retired nothing in that case. A rename of a page that STAYS live orphans the
-- old path's answers just the same — runQuestions deletes and re-inserts only
-- under the page's current path — so the old path is retired on a rename too.
--
-- Each candidate path is retired only while no publicly resolvable page holds
-- it, which is exactly the orphan predicate of part 1 and part 4 below — so the
-- trigger retires precisely what part 4 would count as a leak, and never an
-- answer at a path another live page has taken over in the same statement.
--
-- NEW is NULL in a DELETE trigger, so the paths and the return value are both
-- chosen off TG_OP rather than read from a row that is not there.
create or replace function public.retire_marketing_aeo_on_page_hidden()
returns trigger language plpgsql security definer set search_path = public as $$
declare old_path text; new_path text;
begin
  old_path := old.path;
  if tg_op = 'UPDATE' then new_path := new.path; end if;
  update public.marketing_aeo_questions q
     set status = 'answered',
         last_reviewed = now()
   where q.status = 'published'
     and q.metadata->>'source' = 'marketing_platform'
     and q.source_path is not null
     and q.source_path in (old_path, new_path)
     and not exists (
       select 1 from public.marketing_pages p
        where p.path = q.source_path
          and p.status = 'published'
          and p.deleted_at is null
     );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- A trigger function is never called directly, and firing a trigger does not
-- check EXECUTE — so nobody needs the privilege, and PUBLIC's default grant on
-- a SECURITY DEFINER function is taken away (0344:330 is the pattern).
revoke all on function public.retire_marketing_aeo_on_page_hidden() from public, anon, authenticated;

-- Fires only when a LIVE page stops resolving at the path its answers carry:
-- the transition INTO hidden, or a rename. A normal edit of an already-draft
-- page does no work, and publishing is never affected. Covers both shapes of
-- take-down: `deleted_at` set (the Archive button, the legacy bridge) and status
-- moved off 'published' (the status dropdown, syncLegacyBlogVisibility(false)).
drop trigger if exists trg_retire_marketing_aeo_on_page_hidden on public.marketing_pages;
create trigger trg_retire_marketing_aeo_on_page_hidden
after update on public.marketing_pages
for each row
when (
  (old.status = 'published' and old.deleted_at is null)
  and (
    not (new.status = 'published' and new.deleted_at is null)
    or old.path is distinct from new.path
  )
)
execute function public.retire_marketing_aeo_on_page_hidden();

-- A hard DELETE never passes through the update trigger above and would leave
-- the answers published with no page left to point the orphan check at.
drop trigger if exists trg_retire_marketing_aeo_on_page_deleted on public.marketing_pages;
create trigger trg_retire_marketing_aeo_on_page_deleted
after delete on public.marketing_pages
for each row execute function public.retire_marketing_aeo_on_page_hidden();

-- ── 3. An unpublished blog post takes its answers with it ──────────────────
-- The `blog_aeo_v1` rows are keyed on the slug, not on a marketing_pages row,
-- and a post can be unpublished without any platform page existing for it.

-- Same shape as part 2: the answers carry the slug the post had when they were
-- written (OLD.slug), and a path is retired only while no published post holds
-- it — the part 1 / part 4 predicate.
create or replace function public.retire_marketing_aeo_on_post_unpublished()
returns trigger language plpgsql security definer set search_path = public as $$
declare gone_path text;
begin
  gone_path := '/blog/' || old.slug;
  update public.marketing_aeo_questions q
     set status = 'answered',
         last_reviewed = now()
   where q.status = 'published'
     and q.metadata->>'seed' = 'blog_aeo_v1'
     and q.source_path = gone_path
     and not exists (
       select 1 from public.blog_posts b
        where '/blog/' || b.slug = q.source_path
          and b.published
     );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.retire_marketing_aeo_on_post_unpublished() from public, anon, authenticated;

drop trigger if exists trg_retire_marketing_aeo_on_post_unpublished on public.blog_posts;
create trigger trg_retire_marketing_aeo_on_post_unpublished
after update on public.blog_posts
for each row
when (old.published and (not new.published or old.slug is distinct from new.slug))
execute function public.retire_marketing_aeo_on_post_unpublished();

drop trigger if exists trg_retire_marketing_aeo_on_post_deleted on public.blog_posts;
create trigger trg_retire_marketing_aeo_on_post_deleted
after delete on public.blog_posts
for each row execute function public.retire_marketing_aeo_on_post_unpublished();

-- ── 4. Prove the invariant holds at the end of this migration ──────────────
-- Not decoration: if the backfill above ever stops matching the writers' own
-- metadata stamps, this raises instead of leaving a leak behind quietly.
--
-- Each count below is part 1's WHERE clause, predicate for predicate — it asks
-- "did the backfill leave anything it was meant to retire", never a wider
-- question. When they differed (this count lacked `like '/blog/%'`), a blog row
-- an admin had re-pointed at /features, or blanked, in /admin/marketing/aeo
-- matched here but not there, and the migration refused to apply on exactly the
-- drifted data it exists for. docs/audit/a-renamed-page-leaves-no-public-
-- answer-behind-check.sql (step 3) re-applies this file over both of those shapes.
do $$
declare orphans integer;
begin
  select count(*) into orphans
    from public.marketing_aeo_questions q
   where q.status = 'published'
     and q.source_path is not null
     and q.metadata->>'source' = 'marketing_platform'
     and not exists (
       select 1 from public.marketing_pages p
        where p.path = q.source_path
          and p.status = 'published'
          and p.deleted_at is null
     );
  if orphans > 0 then
    raise exception
      'migration 0355: % published AEO answers still have no publicly resolvable marketing page', orphans;
  end if;

  select count(*) into orphans
    from public.marketing_aeo_questions q
   where q.status = 'published'
     and q.source_path like '/blog/%'
     and q.metadata->>'seed' = 'blog_aeo_v1'
     and not exists (
       select 1 from public.blog_posts b
        where '/blog/' || b.slug = q.source_path
          and b.published
     );
  if orphans > 0 then
    raise exception
      'migration 0355: % published blog AEO answers still point at an unpublished post', orphans;
  end if;
end $$;
