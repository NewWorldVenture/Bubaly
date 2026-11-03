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
-- ada@example.com; Ben, in no household, email ben@example.com; in Board House
-- too, Cleo (display name E'\tCleo\n', email morgan@...), Dee (display name
-- between a no-break space and an em space, email dee.r@...), Eve (display
-- name E'\tBubaly Team\n') and Fay (display name "Bubaly<NBSP>Team"); Gil, in
-- no household, whose email's local part is E'\tBubaly Team\n'; one idea.
-- Names are unconstrained text (0002), and the app signs with authorNameFor(),
-- which trims a display name with JavaScript's trim() and takes the email's
-- local part as it is.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as Ada, each refused by 0527's guard (42501, its own sentence): an idea
--      carrying, one at a time, a roadmap status, an admin_note, a pin, a
--      vote_count, a comment_count and each of the four github_* columns; an
--      idea or a comment signed "Bubaly Team" or with another person's name;
--      a comment with is_team = true; and, past the board's own limits, a sixth
--      idea within a minute and a twenty-first within a day (CALHUB-O5), while
--      a fifth within a minute, a twentieth within a day and one after thirty
--      the day before still land; and the limits hold when Ada herself backdates
--      each idea's created_at (it is stamped with the database's time), and a
--      second insert of hers from another session waits while her first is in
--      flight; and the team's name however it is spaced: as Eve, a comment under
--      her display name as stored, E'\tBubaly Team\n', and as "Bubaly Team",
--      that name as the app trims it; as Fay, under her own "Bubaly<NBSP>Team";
--      and as Gil, under the email's local part E'\tBubaly Team\n';
--   2. control: Ada posts an idea and a comment as "Ada" (her display name,
--      trimmed), as "ada" (her email's local part) and as "A Bubaly family";
--      Cleo posts an idea as "Cleo" and Dee comments as "Dee", their display
--      names as JavaScript's trim() leaves them;
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
  ('00000000-0000-4000-8527-0000000000a2','ben@example.com'),
  ('00000000-0000-4000-8527-0000000000a3','morgan@example.com'),
  ('00000000-0000-4000-8527-0000000000a4','dee.r@example.com'),
  ('00000000-0000-4000-8527-0000000000a5','eve@example.com'),
  ('00000000-0000-4000-8527-0000000000a6','fay@example.com'),
  ('00000000-0000-4000-8527-0000000000a7',E'\tBubaly Team\n@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8527-0000000000f1','Board House','00000000-0000-4000-8527-0000000000a1'),
  ('00000000-0000-4000-8527-0000000000f2','Second House','00000000-0000-4000-8527-0000000000a1');
update public.family_members set role = 'parent', is_active = true,
       display_name = case family_id when '00000000-0000-4000-8527-0000000000f1' then '  Ada ' else 'Bubaly Team' end
 where user_id = '00000000-0000-4000-8527-0000000000a1';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8527-0000000000f1','00000000-0000-4000-8527-0000000000a3', E'\tCleo\n', 'adult', true),
  ('00000000-0000-4000-8527-0000000000f1','00000000-0000-4000-8527-0000000000a4', E'\u00A0Dee\u2003', 'teen', true),
  ('00000000-0000-4000-8527-0000000000f1','00000000-0000-4000-8527-0000000000a5', E'\tBubaly Team\n', 'adult', true),
  ('00000000-0000-4000-8527-0000000000f1','00000000-0000-4000-8527-0000000000a6', E'Bubaly\u00A0Team', 'adult', true);
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

-- A second session, for the concurrent admission (1d). dblink lands in public, and
-- the harness's default privileges would hand its functions to the client
-- roles; this whole probe is rolled back, so neither the extension nor any
-- grant outlives it (see a-child-cannot-spend-the-same-dollar-twice-check.sql).
create extension if not exists dblink;

do $$
declare
  idea_refusal constant text := '42501: A new idea starts under review, unpinned, with no votes, note or tracker link';
  team_refusal constant text := '42501: Only the Bubaly Team posts a team reply';
  name_refusal constant text := '42501: A post on the Idea Board is signed with your own name';
  burst_refusal constant text := '42501: Five ideas a minute is the board''s limit; try again in a moment';
  day_refusal constant text := '42501: Twenty ideas a day is the board''s limit; try again tomorrow';
  ada constant text := '00000000-0000-4000-8527-0000000000a1';
  eve constant text := '00000000-0000-4000-8527-0000000000a5';
  fay constant text := '00000000-0000-4000-8527-0000000000a6';
  gil constant text := '00000000-0000-4000-8527-0000000000a7';
  other_pid int;
  waited boolean;
  stamped timestamptz;
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

  -- 1b. The board's limits: five ideas a minute and twenty a day per author.
  -- Each case seeds Ada's earlier ideas as the owner, then asks for one more as
  -- her, and is rolled back.
  for r in select * from (values
      ('posted a sixth idea within a minute', 5, interval '30 seconds', 'minute'),
      ('posted a twenty-first idea within a day', 20, interval '2 hours', 'day'),
      ('(control) posted a fifth idea within a minute', 4, interval '30 seconds', 'ok'),
      ('(control) posted a twentieth idea within a day', 19, interval '2 hours', 'ok'),
      ('(control) posted an idea after thirty the day before', 30, interval '2 days', 'ok')) v(what, earlier, ago, want) loop
    begin
      insert into public.feedback_ideas (author_id, author_name, title, created_at)
      select ada::uuid, 'Ada', 'Earlier idea ' || g, now() - r.ago from generate_series(1, r.earlier) g;
      got := pg_temp.c0527_as('authenticated', ada,
        'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''One more'')');
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    if r.want = 'ok' and got <> 'OK 1' then
      failures := array_append(failures, format('CONTROL: Ada could not post when she %s (%s)', r.what, got));
    elsif r.want <> 'ok' and got like 'OK%' then
      failures := array_append(failures, format('Ada %s (%s)', r.what, got));
    elsif r.want = 'minute' and got is distinct from burst_refusal then
      failures := array_append(failures, format('Ada was refused when she %s, but not by 0527''s minute limit (%s)', r.what, got));
    elsif r.want = 'day' and got is distinct from day_refusal then
      failures := array_append(failures, format('Ada was refused when she %s, but not by 0527''s day limit (%s)', r.what, got));
    end if;
  end loop;

  -- 1c. The limits on the database's clock: Ada backdates each of her own
  -- ideas. created_at is the caller's to send, so a guard that trusted it would
  -- count none of them.
  bad := '{}';
  for r in select * from (values
      ('posted a sixth idea within a minute, backdating each', 0, 5, 'minute'),
      ('posted a twenty-first idea within a day, backdating her last five', 16, 4, 'day')) v(what, earlier, own, want) loop
    begin
      insert into public.feedback_ideas (author_id, author_name, title, created_at)
      select ada::uuid, 'Ada', 'Earlier idea ' || g, now() - interval '2 hours' from generate_series(1, r.earlier) g;
      for n in 1 .. r.own loop
        got := pg_temp.c0527_as('authenticated', ada,
          'insert into public.feedback_ideas (author_id, author_name, title, created_at) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''Backdated'', now() - interval ''2 days'')');
        if got <> 'OK 1' then
          bad := array_append(bad, format('Ada could not post backdated idea %s of %s before the limit (%s)', n, r.own, got));
        end if;
      end loop;
      got := pg_temp.c0527_as('authenticated', ada,
        'insert into public.feedback_ideas (author_id, author_name, title, created_at) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''One more'', now() - interval ''2 days'')');
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    if got like 'OK%' then
      failures := array_append(failures, format('Ada %s (%s)', r.what, got));
    elsif got is distinct from (case r.want when 'minute' then burst_refusal else day_refusal end) then
      failures := array_append(failures, format('Ada was refused when she %s, but not by 0527''s %s limit (%s)', r.what, r.want, got));
    end if;
  end loop;
  begin
    got := pg_temp.c0527_as('authenticated', ada,
      'insert into public.feedback_ideas (id, author_id, author_name, title, created_at) values (''00000000-0000-4000-8527-0000000000c2'', ''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''Old news'', timestamptz ''2020-01-01 00:00:00+00'')');
    select created_at into stamped from public.feedback_ideas where id = '00000000-0000-4000-8527-0000000000c2';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' then
    bad := array_append(bad, format('Ada could not post an idea with a created_at of her own (%s)', got));
  elsif stamped is distinct from now() then
    failures := array_append(failures, format('Ada''s idea kept the created_at she gave it (%s)', stamped));
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 1d. One admission at a time per author: while Ada's insert's transaction is
  -- open, a second insert of hers from another session waits for it, so it
  -- counts the first once that is committed (READ COMMITTED, as PostgREST runs,
  -- takes each statement's snapshot afresh). The second insert is signed with
  -- the default name, which needs none of this transaction's fixtures; it is
  -- always rolled back, and gives up after lock_timeout.
  begin
    got := pg_temp.c0527_as('authenticated', ada,
      'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a1'', ''Ada'', ''In flight'')');
    begin
      perform dblink_connect('c0527_other', 'dbname=' || current_database()
        || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
        || ' port=' || current_setting('port') || ' user=' || current_user
        || ' application_name=c0527_other');
      select t.pid into other_pid from dblink('c0527_other', 'select pg_backend_pid()') as t(pid int);
      perform dblink_send_query('c0527_other', format($q$
        do $d$
        begin
          perform set_config('lock_timeout', '20s', true);
          perform set_config('role', 'authenticated', true);
          perform set_config('request.jwt.claims', %L, true);
          insert into public.feedback_ideas (author_id, author_name, title) values (%L, 'A Bubaly family', 'Also in flight');
          raise exception using errcode = 'P0R01';
        end
        $d$
      $q$, json_build_object('sub', ada, 'role', 'authenticated')::text, ada));
      for n in 1 .. 100 loop
        exit when dblink_is_busy('c0527_other') = 0
               or exists (select 1 from pg_locks l where l.pid = other_pid and not l.granted);
        perform pg_sleep(0.1);
      end loop;
      waited := exists (select 1 from pg_locks l where l.pid = other_pid and not l.granted);
    exception when others then
      waited := null;
      failures := array_append(failures, format('CONTROL: Ada''s second insert could not be sent from another session (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  -- That rollback ends Ada's first admission; the second goes on, and is rolled
  -- back by its own block.
  begin
    perform * from dblink_get_result('c0527_other') as t(status text);
  exception when others then null;
  end;
  begin perform dblink_disconnect('c0527_other'); exception when others then null; end;
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: Ada could not post the idea held in flight (%s)', got));
  elsif waited is not null and not waited then
    failures := array_append(failures, 'a second insert of Ada''s went ahead while her first was in flight, so each would count without the other');
  end if;

  -- 1e. The team's name, however it is spaced. Eve's display name is the
  -- team's between a tab and a newline; Fay's has a no-break space for its
  -- space; Gil's email's local part is the team's between a tab and a newline.
  -- "Bubaly Team" (Eve's name as the app trims it), Fay's and Gil's are each
  -- the caller's own, so only the never-the-team's-name rule can refuse them:
  -- the name trimmed as the app trims, each run of whitespace inside it read as
  -- one space, and its case ignored.
  for r in select * from (values
      ('Eve', eve, 'commented under her display name as stored, E''\tBubaly Team\n''', E'E''\\tBubaly Team\\n'''),
      ('Eve', eve, 'commented as "Bubaly Team", her display name as the app trims it', '''Bubaly Team'''),
      ('Fay', fay, 'commented as "Bubaly<NBSP>Team", her own display name', E'E''Bubaly\\u00A0Team'''),
      ('Gil', gil, 'commented as E''\tBubaly Team\n'', the local part of Gil''s email', E'E''\\tBubaly Team\\n''')) v(who, uid, what, name_sql) loop
    got := pg_temp.c0527_try('authenticated', r.uid, format(
      'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', %L, %s, ''Official'')', r.uid, r.name_sql));
    if got like 'OK%' then
      failures := array_append(failures, format('%s %s (%s)', r.who, r.what, got));
    elsif got is distinct from name_refusal then
      failures := array_append(failures, format('refused, but not by 0527''s name check: %s %s (%s)', r.who, r.what, got));
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
      ('(Cleo, display name E''\tCleo\n'') post an idea as "Cleo"', 'authenticated', '00000000-0000-4000-8527-0000000000a3', 'insert into public.feedback_ideas (author_id, author_name, title) values (''00000000-0000-4000-8527-0000000000a3'', ''Cleo'', ''Tabs'')'),
      ('(Dee, display name between a no-break space and an em space) comment as "Dee"', 'authenticated', '00000000-0000-4000-8527-0000000000a4', 'insert into public.feedback_comments (idea_id, author_id, author_name, body) values (''00000000-0000-4000-8527-0000000000c1'', ''00000000-0000-4000-8527-0000000000a4'', ''Dee'', ''Spaces'')'),
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
  raise notice 'a-post-on-the-idea-board-is-the-callers-own: OK (as Ada, an idea with a roadmap status, note, pin, counts or any tracker column, an idea or comment signed as the Bubaly Team or as Ben, a team reply, and a sixth idea in a minute or a twenty-first in a day were each refused by 0527''s guard, while she still posts under both limits and after the day; the limits held when she backdated each idea, which was stamped with the database''s time, and her second insert from another session waited while her first was in flight; the team''s name was refused however it was spaced: Eve''s comments under her display name as stored (E''\tBubaly Team\n'') and as "Bubaly Team", Fay''s as her own "Bubaly<NBSP>Team" and Gil''s as the local part of Gil''s email (E''\tBubaly Team\n''); Cleo and Dee posted as their names trimmed the way the app trims them; she still posts and comments as her trimmed display name, her email''s local part and the default, Ben in no household comments as himself, her vote moves the count, and the server posts a team reply and ships an idea; both guards and the name check are in place, the check not a client''s to call; negative control: with the guards disabled her team reply and shipped idea landed; mutation control: with the name check answering yes her comment as Ben landed)';
end $$;

rollback;
