-- ── A renamed page leaves no public answer behind, and 0383 re-applies (0383) ─
--
-- Companion to an-archived-page-takes-its-public-answers-with-it-check.sql,
-- which proves the take-down triggers (archive, status-off, hard delete, blog
-- unpublish/delete, the blog mirror, and rename-AND-take-down in one UPDATE).
-- This file holds the parts of 0383 that one does not reach:
--
--   1. A RENAME OF A PAGE THAT STAYS LIVE retires the answers filed under the
--      old path. runQuestions deletes and re-inserts only under the page's
--      CURRENT path, so without this the old path's answers stay world-readable
--      forever under a URL no page holds.
--   2. Nobody holds EXECUTE on the two SECURITY DEFINER trigger functions.
--   3. The migration RE-APPLIES over the two drifted shapes /admin/marketing/aeo
--      can produce (updateAeoQuestion lets an admin rewrite source_path on any
--      row, and a blank field normalises to null): a `blog_aeo_v1` answer
--      re-pointed at a non-/blog path, and one with source_path null. Its
--      closing assertion once counted those while its backfill skipped them, so
--      0383 refused to apply on exactly the drifted data it exists for. It must
--      now apply, and leave both rows as they are.
--   4. NEGATIVE CONTROL: recreate the page trigger with the first cut's WHEN
--      clause (transition into hidden only) and require case 1 to leak again.
--
-- Runs as service_role — the key the marketing actions, the cron worker and the
-- backfill scripts hold — inside one transaction that ends in `rollback`.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-renamed-page-leaves-no-public-answer-behind-check.sql

\set ADMIN '00000000-0000-4000-8000-00000383b001'

begin;

insert into auth.users (id, email) values (:'ADMIN', 'p0383b-admin@example.com') on conflict do nothing;

insert into public.marketing_pages (page_type, slug, path, title, status) values
  ('feature', 'p0383b-rename-live-old', '/features/p0383b-rename-live-old', 'P0383b renamed, stays live', 'published'),
  ('feature', 'p0383b-sibling',         '/features/p0383b-sibling',         'P0383b untouched sibling',   'published');

insert into public.marketing_aeo_questions (question, answer, source_path, pattern, status, metadata) values
  ('p0383b rename-live', 'a', '/features/p0383b-rename-live-old', 'faq', 'published', '{"source":"marketing_platform"}'),
  ('p0383b sibling',     'a', '/features/p0383b-sibling',         'faq', 'published', '{"source":"marketing_platform"}');

do $$
declare
  admin constant uuid := '00000000-0000-4000-8000-00000383b001';
  failures text[] := '{}';
  st text;
  n int;
begin
  perform set_config('role', 'service_role', true);

  -- ── 1. Rename, page stays live ──────────────────────────────────────────
  update public.marketing_pages
     set slug = 'p0383b-rename-live-new', path = '/features/p0383b-rename-live-new', updated_by = admin
   where path = '/features/p0383b-rename-live-old';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('fixture: the rename changed %s rows (expected 1)', n)); end if;
  select status into st from public.marketing_pages where path = '/features/p0383b-rename-live-new';
  if st is distinct from 'published' then failures := array_append(failures, format('fixture: the renamed page should still be published, is %s', st)); end if;
  select status into st from public.marketing_aeo_questions where question = 'p0383b rename-live';
  if st is distinct from 'answered' then
    failures := array_append(failures, format('a rename left the answer filed under the OLD path, which no page holds, at %s', st));
  end if;

  select status into st from public.marketing_aeo_questions where question = 'p0383b sibling';
  if st is distinct from 'published' then
    failures := array_append(failures, format('renaming one page retired a live sibling page''s answer (now %s)', st));
  end if;

  perform set_config('role', 'postgres', true);

  -- ── 2. The grant layer ──────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.retire_marketing_aeo_on_page_hidden()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.retire_marketing_aeo_on_page_hidden()', 'EXECUTE')
     or has_function_privilege('anon', 'public.retire_marketing_aeo_on_post_unpublished()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.retire_marketing_aeo_on_post_unpublished()', 'EXECUTE') then
    failures := array_append(failures, 'anon or authenticated may EXECUTE a 0383 SECURITY DEFINER trigger function');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a renamed page still leaves public answers behind:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
end $$;

-- ── 3. The migration re-applies over drifted data ─────────────────────────
insert into public.marketing_aeo_questions (question, answer, source_path, pattern, status, metadata) values
  ('p0383b drifted re-pointed', 'a', '/features/p0383b-elsewhere', 'faq', 'published', '{"seed":"blog_aeo_v1"}'),
  ('p0383b drifted blanked',    'a', null,                         'faq', 'published', '{"seed":"blog_aeo_v1"}');

-- A refusal here stops the probe with the migration's own error, which is the
-- failure this case exists to catch.
\ir ../../supabase/migrations/0383_an_archived_page_takes_its_public_answers_with_it.sql

do $$
declare
  failures text[] := '{}';
  n int;
begin
  select count(*) into n from public.marketing_aeo_questions
   where question in ('p0383b drifted re-pointed', 'p0383b drifted blanked') and status = 'published';
  if n <> 2 then
    failures := array_append(failures, format('re-applying 0383 retired %s admin-re-pointed answer(s) that are outside its backfill', 2 - n));
  end if;

  -- ── 4. Negative control ─────────────────────────────────────────────────
  -- The first cut's WHEN clause: a rename of a page that stays live never fires.
  drop trigger if exists trg_retire_marketing_aeo_on_page_hidden on public.marketing_pages;
  create trigger trg_retire_marketing_aeo_on_page_hidden
  after update on public.marketing_pages
  for each row
  when ((old.status = 'published' and old.deleted_at is null) and not (new.status = 'published' and new.deleted_at is null))
  execute function public.retire_marketing_aeo_on_page_hidden();

  insert into public.marketing_pages (page_type, slug, path, title, status)
    values ('feature', 'p0383b-control-old', '/features/p0383b-control-old', 'P0383b control', 'published');
  insert into public.marketing_aeo_questions (question, answer, source_path, pattern, status, metadata)
    values ('p0383b control', 'a', '/features/p0383b-control-old', 'faq', 'published', '{"source":"marketing_platform"}');
  update public.marketing_pages
     set slug = 'p0383b-control-new', path = '/features/p0383b-control-new'
   where path = '/features/p0383b-control-old';
  select count(*) into n from public.marketing_aeo_questions where question = 'p0383b control' and status = 'published';
  if n <> 1 then
    failures := array_append(failures, 'with the first cut''s WHEN clause restored, a live rename still retired the answer — case 1 has never been shown to fail');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'0383 rename / re-apply:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-renamed-page-leaves-no-public-answer-behind: OK (a rename of a live page retires the old path''s answers and no sibling''s; no role may EXECUTE the trigger functions; 0383 re-applies over re-pointed and blanked blog answers without refusing or retiring them; negative control reproduced the live-rename leak)';
end $$;

rollback;
