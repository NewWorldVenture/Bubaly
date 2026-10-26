-- ── A post on the Idea Board is the caller's own (0527) ──────────────────────
--
-- CALHUB-O1: the Idea Board is shown to every family, and 0197's insert
-- policies check only `author_id = auth.uid()`, so any signed-in user could
-- file a comment as a team reply, or an idea already shipped, pinned, voted up
-- and linked to the tracker, under the team's name. The held 0527 refuses that
-- for a signed-in caller; the service role (the admin console, the step-up team
-- reply, the GitHub sync) writes as before.
--
-- Fixture: Ada, a parent of Board House (display name "  Ada " as typed, with
-- the spaces) and of Second House, where she named herself "Bubaly Team"
-- (so only the never-the-team's-name rule refuses that name), email
-- ada@example.com; Ben, in no household, email ben@example.com; one idea.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as Ada, each refused by 0527's guard (42501, its own sentence): an idea
--      carrying, one at a time, a roadmap status, an admin_note, a pin, a
--      vote_count, a comment_count and each of the four github_* columns; an
--      idea or a comment signed "Bubaly Team" or with another person's name;
--      a comment with is_team = true;
--   2. control: Ada posts an idea and a comment as "Ada" (her display name,
--      trimmed), as "ada" (her email's local part) and as "A Bubaly family";
--      Ben, in no household, comments as "ben"; Ada's vote moves the idea's
--      vote_count (0197's counter trigger); the server (service_role, no user)
--      posts a team reply as "Bubaly Team" and moves an idea to shipped with a
--      note;
--   3. wiring: each table carries its guard, enabled, FOR EACH ROW, BEFORE
--      INSERT; the guards and the name check are SECURITY DEFINER with a pinned
--      search_path, and no client may call the name check;
--
-- and, only where 0527 is installed:
--
--   N1. NEGATIVE CONTROL: with both guards disabled, Ada's team reply and her
--       shipped idea land: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the name check answering yes to any name, Ada's
--       comment signed with another person's name lands, so 1. is what catches
--       the name half going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0527: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/idea-board-authorship-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0527 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8527-0000000000a1','ada@example.com'),
  ('00000000-0000-4000-8527-0000000000a2','ben@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8527-0000000000f1','Board House','00000000-0000-4000-8527-0000000000a1'),
  ('00000000-0000-4000-8527-0000000000f2','Second House','00000000-0000-4000-8527-0000000000a1');
update public.family_members set role = 'parent', is_active = true,
       display_name = case family_id when '00000000-0000-4000-8527-0000000000f1' then '  Ada ' else 'Bubaly Team' end
 where user_id = '00000000-0000-4000-8527-0000000000a1';
insert into public.feedback_ideas (id, author_id, author_name, title) values
  ('00000000-0000-4000-8527-0000000000c1', null, 'A Bubaly family', 'Dark mode');

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0527_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- The same, undone afterwards, so no attempt changes what the next one sees.
create or replace function pg_temp.c0527_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0527_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

-- What Ada may not post, the refusal 0527 gives, and the statement.
create temp table c0527_refused (what text, refusal text, stmt text) on commit drop;
insert into c0527_refused
select format('filed an idea with %s', col), 'idea',
       format('insert into public.feedback_ideas (author_id, author_name, title, %s) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''Forged'', %s)', col, val)
  from (values ('status', '''shipped'''), ('admin_note', '''Shipped today!'''), ('pinned', 'true'),
               ('vote_count', '9999'), ('comment_count', '42'), ('github_issue_number', '1'),
               ('github_issue_url', '''https://github.com/x/y/issues/1'''), ('github_state', '''closed'''),
               ('github_synced_at', 'now()')) v(col, val);
insert into c0527_refused values
  ('filed an idea as the Bubaly Team', 'name',
   'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a1'', ''Bubaly Team'', ''Forged'')'),
  ('filed an idea under another person''s name', 'name',
   'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a1'', ''Ben'', ''Forged'')'),
  ('posted a team reply', 'team',
   'insert into public.feedback_comments (idea_id, author_id, author_name, is_team, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Ada'', true, ''Official'')'),
  ('commented as the Bubaly Team', 'name',
   'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''bubaly team '', ''Official'')'),
  ('commented under another person''s name', 'name',
   'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Ben'', ''Hello'')');

do $$
declare
  idea_refusal constant text := '42501: A new idea starts under review, unpinned, with no votes, note or tracker link';
  team_refusal constant text := '42501: Only the Bubaly Team posts a team reply';
  name_refusal constant text := '42501: A post on the Idea Board is signed with your own name';
  ada constant text := '00000000-0000-4000-8527-0000000000a1';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  r record;
  expected text;
  got text;
  n bigint;
begin
  installed := (select count(*) from pg_trigger g
                 where g.tgfoid in (to_regprocedure('public.a_feedback_comment_is_the_callers_own()'),
                                    to_regprocedure('public.a_feedback_idea_starts_as_the_callers_own()'))) = 2;

  -- 1. What Ada may not post.
  for r in select * from c0527_refused loop
    expected := case r.refusal when 'idea' then idea_refusal when 'team' then team_refusal else name_refusal end;
    got := pg_temp.c0527_try('authenticated', ada, r.stmt);
    if got like 'OK%' then
      failures := array_append(failures, format('Ada %s (%s)', r.what, got));
    elsif got is distinct from expected then
      failures := array_append(failures, format('Ada was refused when she %s, but not by 0527''s guard (%s)', r.what, got));
    end if;
  end loop;

  -- 2. Controls.
  bad := '{}';
  for r in select * from (values
      ('post an idea as "Ada"', 'authenticated', ada, 'insert into public.feedback_ideas (author_id, author_name, title, category, impact, audience, kind) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''Shared calendars'', ''calendar'', ''helpful'', ''me'', ''idea'')'),
      ('post an idea as "ada"', 'authenticated', ada, 'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a1'', ''ada'', ''A bug'')'),
      ('post an idea as "A Bubaly family"', 'authenticated', ada, 'insert into public.feedback_ideas (author_id, title) values (''00000000-0000-4000-8527-0000000000a1'', ''Unsigned'')'),
      ('comment as "Ada"', 'authenticated', ada, 'insert into public.feedback_comments (idea_id, author_id, author_name, is_team, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Ada'', false, ''Yes please'')'),
      ('comment as "ada"', 'authenticated', ada, 'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''ada'', ''Me too'')'),
      ('comment as "A Bubaly family"', 'authenticated', ada, 'insert into public.feedback_comments (idea_id, author_id, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Same'')'),
      ('(Ben, in no household) comment as "ben"', 'authenticated', '00000000-0000-4000-8527-0000000000a2', 'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a2'', ''ben'', ''Agreed'')'),
      ('(the server) post a team reply', 'service_role', '', 'insert into public.feedback_comments (idea_id, author_id, author_name, is_team, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Bubaly Team'', true, ''On the roadmap'')'),
      ('(the server) move an idea to shipped', 'service_role', '', 'update public.feedback_ideas set status = ''shipped'', admin_note = ''Shipped'' where id = ''00000000-0000-4000-8527-0000000000c1''')) v(what, role, uid, stmt) loop
    got := pg_temp.c0527_try(r.role, r.uid, r.stmt);
    if got <> 'OK 1' then
      bad := array_append(bad, format('could not %s (%s)', r.what, got));
    end if;
  end loop;
  begin
    got := pg_temp.c0527_as('authenticated', ada,
      'insert into public.feedback_votes (idea_id, user_id) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'')');
    select vote_count into n from public.feedback_ideas where id = '00000000-0000-4000-8527-0000000000c1';
    if got <> 'OK 1' or n <> 1 then
      bad := array_append(bad, format('Ada''s vote did not move the idea''s vote_count (%s, vote_count %s)', got, n));
    end if;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  bad := '{}';
  for r in select * from (values
      ('feedback_comments', 'trg_feedback_comments_callers_own', 'public.a_feedback_comment_is_the_callers_own()'),
      ('feedback_ideas', 'trg_feedback_ideas_callers_own', 'public.a_feedback_idea_starts_as_the_callers_own()')) v(tbl, trg, fn) loop
    if to_regprocedure(r.fn) is null
       or not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                       where g.tgrelid = ('public.' || r.tbl)::regclass and g.tgname = r.trg
                         and g.tgfoid = to_regprocedure(r.fn) and g.tgenabled <> 'D'
                         and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 4) = 4
                         and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
      bad := array_append(bad, r.tbl);
    end if;
  end loop;
  if to_regprocedure('public.feedback_name_is_the_callers_own(text)') is null
     or has_function_privilege('authenticated', 'public.feedback_name_is_the_callers_own(text)', 'execute')
     or has_function_privilege('anon', 'public.feedback_name_is_the_callers_own(text)', 'execute') then
    bad := array_append(bad, 'the name check (missing, or callable by a client)');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0527''s guard is not in place on %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. Both guards disabled.
    begin
      alter table public.feedback_comments disable trigger trg_feedback_comments_callers_own;
      alter table public.feedback_ideas disable trigger trg_feedback_ideas_callers_own;
      bad := '{}';
      for r in select * from c0527_refused where what in ('posted a team reply', 'filed an idea with status') loop
        got := pg_temp.c0527_try('authenticated', ada, r.stmt);
        if got <> 'OK 1' then
          bad := array_append(bad, format('%s (%s)', r.what, got));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guards disabled Ada still was not let through: %s, so this fixture cannot see the defect', array_to_string(bad, '; ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The name check answers yes to any name.
    begin
      create or replace function public.feedback_name_is_the_callers_own(p_name text)
      returns boolean language sql stable security definer set search_path = public, pg_temp
      as $m$ select true $m$;
      got := pg_temp.c0527_try('authenticated', ada,
        'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a1'', ''Ben'', ''Hello'')');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the name check answering yes to any name Ada''s comment as Ben still did not land (%s), so 1. cannot catch the name half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a post on the Idea Board is not the caller''s own:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-post-on-the-idea-board-is-the-callers-own: OK (as Ada, an idea with a roadmap status, note, pin, counts or any tracker column, an idea or comment signed as the Bubaly Team or as Ben, and a team reply were each refused by 0527''s guard; she still posts and comments as her trimmed display name, her email''s local part and the default, Ben in no household comments as himself, her vote moves the count, and the server posts a team reply and ships an idea; both guards and the name check are in place, the check not a client''s to call; negative control: with the guards disabled her team reply and shipped idea landed; mutation control: with the name check answering yes her comment as Ben landed)';
end $$;

rollback;
