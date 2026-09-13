-- ============================================================
-- Migration 0286: blog_posts.updated_at stops reporting the import
--
-- Every published post carried the SAME updated_at — measured against
-- production on 2026-09-13, all 1,048 of them read exactly
-- 2026-07-18T18:05:07.518Z. One statement's transaction timestamp, which is
-- only possible if no post has ever been edited individually: the column
-- recorded when a migration last touched the table, not when anyone changed
-- the writing.
--
-- That surfaced in /sitemap.xml, which reports `lastmod` from updated_at
-- (falling back to published_at). Before this, 1,048 URLs all claimed the same
-- modification date; published_at has 398 distinct days spanning 2024-01 to
-- 2026-07, so the real authoring dates were there all along, just outranked.
--
-- This is a one-time correction of rows a bulk statement stamped, never a
-- person: a post published before the date its row was stamped, sharing that
-- exact stamp with a hundred others, was not edited then — it was imported or
-- re-seeded then. Its content dates from publication, so that is what
-- updated_at should say.
--
-- Rows edited individually are untouched: a human edit produces its own
-- timestamp, shared with nothing, and fails the batch test below. Going
-- forward trg_blog_posts_updated_at keeps recording genuine edits, and the
-- next one moves a post's date on its own merit.
--
-- Idempotent: after this runs, a corrected row's updated_at equals its
-- publication date, so `published_at < updated_at::date` is false and a replay
-- matches nothing.
-- ============================================================

do $$
declare
  corrected integer;
begin
  -- trg_blog_posts_updated_at is an unconditional BEFORE UPDATE that sets
  -- updated_at = now(), so it would overwrite this very correction with the
  -- migration's own timestamp — the exact defect being repaired. Only the
  -- updated_at trigger is suspended; trg_blog_image_provenance stays on.
  alter table public.blog_posts disable trigger trg_blog_posts_updated_at;

  update public.blog_posts p
     set updated_at = (p.published_at::timestamp at time zone 'UTC')
   where p.published_at < p.updated_at::date
     and (
       select count(*) from public.blog_posts q where q.updated_at = p.updated_at
     ) >= 100;

  get diagnostics corrected = row_count;

  alter table public.blog_posts enable trigger trg_blog_posts_updated_at;

  raise notice '[0286] blog_posts.updated_at corrected to the publication date on % row(s)', corrected;
end $$;
