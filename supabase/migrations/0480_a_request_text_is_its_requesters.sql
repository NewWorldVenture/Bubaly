-- ── A request's own words are its requester's (and a manager's) ──────────────
--
-- #892 comment 5973332041. `ai_requests.request_text` holds what a member typed
-- to the concierge, verbatim (lib/ai/runs/intake.ts → createRequest), and a
-- routine's configured prompt; `ai_requests.clarifications` holds the questions
-- the planner asked and the member's ANSWERS, verbatim. The row is
-- readable by every member of the family (0250 `ai_requests_select`:
-- `is_family_member(family_id)`), and no column grant narrowed it, so a child
-- could read a sibling's or a parent's private request through the Data API —
-- reproduced on the replayed schema as `authenticated`. The run page showed it
-- the same way: `family_automation_runs` is family-readable and the page read
-- the request with the member's session.
--
-- Everything ELSE about a request stays family-readable, on purpose:
--   • the F19 allowance meter counts the family's rows through the member's own
--     session (`monthlyAllowance`: `select id … head`); hiding rows from a
--     sibling would let a child see fewer and under-count the family's cap;
--   • the policies on `ai_plans`, `ai_plan_steps`, `ai_request_context` and
--     `ai_run_events` test `r.id` / `r.requested_by` of this table as the
--     invoking member.
-- So the narrowing is a COLUMN privilege, not a row policy: `authenticated`
-- may select every column of `ai_requests` except `request_text` and
-- `clarifications`.
-- `interpreted_intent` stays readable: it is a classifier key (`plan_week`),
-- not the member's words.
--
-- The words themselves are served by `ai_request_words(uuid[])`: SECURITY
-- DEFINER, `search_path` pinned, returning a row only where the caller filed
-- the request or manages the family — the same rule 0250/0264 already apply to
-- the request's context snapshot, plans, steps and run events.
--
-- The server (service_role) is untouched: the planner, the intake and the
-- super-admin activity page read the column as before.
--
-- A column added to `ai_requests` later is NOT readable by `authenticated`
-- until granted; the probe docs/audit/a-request-text-is-its-requesters-check.sql
-- names the columns a member keeps, so that is a visible decision.

-- Every current column but the two private ones, granted by name.
do $grant$
declare cols text;
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_requests' and column_name not in ('request_text', 'clarifications');
  execute 'revoke select on public.ai_requests from anon, authenticated';
  execute format('grant select (%s) on public.ai_requests to authenticated', cols);
end
$grant$;

create or replace function public.ai_request_words(p_request_ids uuid[])
returns table (id uuid, request_text text, clarifications jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.request_text, r.clarifications
    from public.ai_requests r
   where r.id = any (p_request_ids)
     and auth.uid() is not null
     and public.is_family_member(r.family_id)
     and (r.requested_by = auth.uid() or public.can_manage_family(r.family_id));
$$;

comment on function public.ai_request_words(uuid[]) is
  'The words of the given AI requests (request_text, clarifications), for their requester or a family manager only (0480). Other members read every other column of ai_requests directly.';

revoke all on function public.ai_request_words(uuid[]) from public, anon;
grant execute on function public.ai_request_words(uuid[]) to authenticated, service_role;
