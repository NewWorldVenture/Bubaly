-- 0527 — A post on the Idea Board is the caller's own.
-- Requested on #771 in comment 6421813855, before any SQL: CALHUB-O1, the
-- database half of CALHUB-01 ("any signed-in user could post as the Bubaly Team
-- and forge roadmap status"), and CALHUB-O5's per-author insert throttle.
--
-- The Idea Board is shown to every family (feedback_ideas_select and
-- feedback_comments_select are `auth.uid() is not null`). 0197's insert
-- policies check only `author_id = auth.uid()`. Measured on a replay of main, as
-- an ordinary signed-in parent, one PostgREST insert each, OK 1 both times: an
-- idea filed as "Bubaly Team" with status 'shipped', pinned, an admin_note,
-- vote_count 9999, comment_count 42 and a GitHub issue; and a comment with
-- is_team = true and author_name 'Bubaly Team', which every family's board
-- renders as a team reply. The app writes team replies and roadmap changes only
-- through the service client after the super-admin step-up
-- (app/(app)/feedback/actions.ts, app/(app)/admin/feedback/actions.ts).
--
-- A BEFORE INSERT trigger on each table, for a signed-in caller, 42501 with its
-- own sentence:
--
--   feedback_comments   is_team is false;
--   feedback_ideas      a new idea starts as the board starts one: status
--                       'under_review', no admin_note, not pinned, vote_count
--                       and comment_count 0, and no github_* link;
--   both                author_name is one of the caller's own names, the ones
--                       authorNameFor() picks: a family_members.display_name of
--                       theirs (trimmed), their email's local part, or the
--                       column default 'A Bubaly family'; and never the team's;
--   feedback_ideas      and no more than the board's own limits, five ideas a
--                       minute and twenty a day per author (CALHUB-O5, the
--                       per-author insert throttle "alongside N3's migration":
--                       each idea opens a GitHub issue with the bot token).
--
-- The service role and session-less writers are exempt (no auth.uid()), so the
-- admin console, the step-up team reply, the GitHub sync and the seeds write as
-- before. UPDATE and DELETE have no client policy (the counters move through
-- 0197's SECURITY DEFINER triggers), so this guards INSERT only. Reads are
-- unchanged. SECURITY DEFINER with a pinned search_path, so the name check can
-- read auth.users.
--
-- HELD: 0527, requested on #771 in comment 6421813855 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-post-on-the-idea-board-is-the-callers-own-check.sql
-- and .github/workflows/idea-board-authorship-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

-- Whose name this is: the signed-in caller's own, by the rule the board's
-- authorNameFor() follows. Not callable by a client; the guards below call it.
create or replace function public.feedback_name_is_the_callers_own(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_name is not null
     and lower(btrim(p_name)) <> 'bubaly team'
     and (p_name = 'A Bubaly family'
          or exists (select 1 from public.family_members m
                      where m.user_id = auth.uid()
                        and nullif(btrim(m.display_name), '') = p_name)
          or exists (select 1 from auth.users u
                      where u.id = auth.uid()
                        and nullif(split_part(u.email, '@', 1), '') = p_name));
$$;

-- One function per table: a body that names the other table's column would not
-- resolve against this one (docs/audit/plpgsql-bodies-resolve-check.sql).
create or replace function public.a_feedback_comment_is_the_callers_own()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service role / server-side jobs
  end if;
  if new.is_team then
    raise exception 'Only the Bubaly Team posts a team reply' using errcode = '42501';
  end if;
  if not public.feedback_name_is_the_callers_own(new.author_name) then
    raise exception 'A post on the Idea Board is signed with your own name' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function public.a_feedback_idea_starts_as_the_callers_own()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service role / server-side jobs
  end if;
  if new.status is distinct from 'under_review' or new.admin_note is not null or new.pinned
     or new.vote_count <> 0 or new.comment_count <> 0
     or new.github_issue_number is not null or new.github_issue_url is not null
     or new.github_state is not null or new.github_synced_at is not null then
    raise exception 'A new idea starts under review, unpinned, with no votes, note or tracker link' using errcode = '42501';
  end if;
  if not public.feedback_name_is_the_callers_own(new.author_name) then
    raise exception 'A post on the Idea Board is signed with your own name' using errcode = '42501';
  end if;
  -- The board's own limits (app/(app)/feedback/actions.ts IDEA_BURST and
  -- IDEAS_PER_DAY): each idea opens a GitHub issue with the bot token, so a
  -- scripted loop of direct inserts spent its allowance (CALHUB-O5).
  if (select count(*) from public.feedback_ideas i
       where i.author_id = auth.uid() and i.created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Five ideas a minute is the board''s limit; try again in a moment' using errcode = '42501';
  end if;
  if (select count(*) from public.feedback_ideas i
       where i.author_id = auth.uid() and i.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Twenty ideas a day is the board''s limit; try again tomorrow' using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.feedback_name_is_the_callers_own(text) is
  'Whether a feedback author_name is the signed-in caller''s own (0527): one of their family_members display names (trimmed), their email''s local part, or the default ''A Bubaly family''; never ''Bubaly Team''. Called by the 0527 guards; not granted to clients.';
comment on function public.a_feedback_comment_is_the_callers_own() is
  'Refuses (42501) a signed-in caller''s feedback comment that claims a team reply or another name (0527). The service role is exempt.';
comment on function public.a_feedback_idea_starts_as_the_callers_own() is
  'Refuses (42501) a signed-in caller''s new idea that carries a roadmap status, note, pin, counts or tracker link, or another name, or that passes the board''s limits of five a minute and twenty a day (0527). The service role is exempt.';

revoke all on function public.feedback_name_is_the_callers_own(text) from public, anon, authenticated;
revoke all on function public.a_feedback_comment_is_the_callers_own() from public, anon;
revoke all on function public.a_feedback_idea_starts_as_the_callers_own() from public, anon;

do $$
begin
  if to_regclass('public.feedback_ideas') is null or to_regclass('public.feedback_comments') is null then
    raise exception '0527 needs public.feedback_ideas and public.feedback_comments (0197)';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'feedback_ideas'
         and column_name in ('github_issue_number', 'github_issue_url', 'github_state', 'github_synced_at')) <> 4 then
    raise exception '0527 needs feedback_ideas'' github_* columns (0206)';
  end if;
  drop trigger if exists trg_feedback_comments_callers_own on public.feedback_comments;
  create trigger trg_feedback_comments_callers_own before insert on public.feedback_comments
    for each row execute function public.a_feedback_comment_is_the_callers_own();
  drop trigger if exists trg_feedback_ideas_callers_own on public.feedback_ideas;
  create trigger trg_feedback_ideas_callers_own before insert on public.feedback_ideas
    for each row execute function public.a_feedback_idea_starts_as_the_callers_own();
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g
   where ((g.tgrelid = 'public.feedback_comments'::regclass
           and g.tgfoid = 'public.a_feedback_comment_is_the_callers_own()'::regprocedure)
          or (g.tgrelid = 'public.feedback_ideas'::regclass
              and g.tgfoid = 'public.a_feedback_idea_starts_as_the_callers_own()'::regprocedure))
     and g.tgenabled <> 'D'
     and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2      -- FOR EACH ROW, BEFORE
     and (g.tgtype & 4) = 4;                            -- INSERT
  if n <> 2 then
    raise exception '0527: % of 2 Idea Board tables carry the own-post guard', n;
  end if;
  if (select count(*) from pg_proc p
       where p.oid in ('public.feedback_name_is_the_callers_own(text)'::regprocedure,
                       'public.a_feedback_comment_is_the_callers_own()'::regprocedure,
                       'public.a_feedback_idea_starts_as_the_callers_own()'::regprocedure)
         and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') <> 3 then
    raise exception '0527: the guards and the name check must be SECURITY DEFINER with a pinned search_path';
  end if;
  if has_function_privilege('anon', 'public.feedback_name_is_the_callers_own(text)', 'execute')
     or has_function_privilege('authenticated', 'public.feedback_name_is_the_callers_own(text)', 'execute') then
    raise exception '0527: the name check is not a client''s to call';
  end if;
end
$$;
