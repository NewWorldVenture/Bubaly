-- Bubaly :: 0477 - a capped family's AI request is admitted atomically (F19)
-- ----------------------------------------------------------------------------
-- The Free plan sells "10 AI requests/month", and the meter is a COUNT of the
-- family's `ai_requests` rows since the start of the UTC month
-- (lib/server/ai-access.ts `monthlyAllowance`: `.eq('family_id', f)
-- .eq('metered', true) .gte('created_at', <UTC month start>)`, every kind,
-- every status). A route
-- reads that count, and the row that makes the request count is filed later
-- (`withAiRequest` -> `createRequest`, or the gift route's own insert). Two
-- requests at 9 of 10 both read 9, both pass, both file: 11 rows. N requests
-- in parallel overshoot by N-1, each a paid model call.
--
-- Measured on the local stack (docs/audit/f19-atomic-admission.md): a family
-- seeded with 9 rows this month, 8 concurrent count-then-insert transactions
-- -> 17 rows. The same 8 through this function -> exactly 10, 1 admitted and
-- 7 refused.
--
-- `admit_ai_request` does the count and the insert as ONE decision, serialised
-- per family by a transaction-scoped advisory lock: the second caller waits for
-- the first to commit, then counts the row it filed. The count uses exactly
-- the predicate the TypeScript meter uses. The month start is computed HERE,
-- from the database clock, because `created_at` is stamped by that same clock
-- (`default now()`): a row and the window it is counted in cannot disagree.
--
-- A retry key (`client_request_id`, unique per family under 0252's partial
-- index) is honoured before the allowance: a retry of a request already filed
-- is not a new request, so it answers 'existing' with the first row's id (the
-- same answer `createRequest` gives from its 23505 path), even at 10 of 10. A
-- unique violation raised by a writer that does not take this lock is caught
-- and answered the same way.
--
-- WHAT IS METERED. Not every row is a request the family is charged for: the
-- owner's ruling (#771 review 5391362628) is that background work is not to be
-- silently charged against the allowance. Chore-proof validation, an inbound
-- message the contact center routes on a system scope, and a scheduled routine
-- all file rows (they are the observability record), and the meter used to
-- count them: a family at 9 of 10 whose child submitted a chore proof was at
-- 10 of 10 and refused its next real request (#892 review 5970498462).
-- `metered` says which rows the allowance counts. It defaults to true, so every
-- existing row and every writer that does not say otherwise is counted exactly
-- as before; server code files exempt work with `metered = false`. Clients
-- cannot unmeter a row: members have no UPDATE or DELETE policy on this table,
-- and a concierge row a member inserts directly is never planned by anything,
-- whatever its flag (no sweeper picks up queued rows), so it buys no AI work.
--
-- Additive: one new column with a constant default (no table rewrite) and one
-- new function. Nothing existing is altered. Server-only: the ledger client
-- (`createServiceClient`, service_role) is the function's only caller, so
-- every client role is refused EXECUTE, including the direct grants Supabase's
-- default privileges give anon and authenticated (0456).

alter table public.ai_requests add column if not exists metered boolean not null default true;

comment on column public.ai_requests.metered is
  'F19 (0477): counted against the family''s monthly AI allowance. False for work the family did not ask for (chore-proof validation, system-scope intake, scheduled routines). Written by server code only.';

create or replace function public.admit_ai_request(
  p_family_id uuid,
  p_allowance integer,
  p_kind text,
  p_request_text text,
  p_requested_by uuid default null,
  p_requested_by_member_id uuid default null,
  p_conversation_id uuid default null,
  p_feature text default null,
  p_interpreted_intent text default null,
  p_status text default 'queued',
  p_priority smallint default 0,
  p_client_request_id text default null,
  p_started_at timestamptz default null
)
returns table (request_id uuid, outcome text, used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_id   uuid;
  v_used integer;
begin
  if p_family_id is null then
    raise exception 'admit_ai_request: family is required' using errcode = '22023';
  end if;
  if p_allowance is null or p_allowance < 0 then
    -- An unlimited plan is not admitted here; it files with a plain insert.
    raise exception 'admit_ai_request: allowance must be a non-negative number' using errcode = '22023';
  end if;

  -- One admission at a time per family, held until this transaction commits.
  perform pg_advisory_xact_lock(hashtextextended('ai_requests_admission:' || p_family_id::text, 0));

  if p_client_request_id is not null then
    select r.id into v_id
      from public.ai_requests r
     where r.family_id = p_family_id
       and r.client_request_id = p_client_request_id;
    if v_id is not null then
      return query select v_id, 'existing'::text, null::integer;
      return;
    end if;
  end if;

  -- The meter: the same rows lib/server/ai-access.ts counts. An unmetered row
  -- (exempt work) is filed without this lock and is never counted, so it can
  -- neither use up the allowance nor race an admission.
  select count(*)::integer into v_used
    from public.ai_requests r
   where r.family_id = p_family_id
     and r.metered
     and r.created_at >= date_trunc('month', now(), 'UTC');

  if v_used >= p_allowance then
    return query select null::uuid, 'refused'::text, v_used;
    return;
  end if;

  begin
    insert into public.ai_requests (
      family_id, conversation_id, requested_by, requested_by_member_id, kind, feature,
      request_text, interpreted_intent, status, priority, client_request_id, started_at
    ) values (
      p_family_id, p_conversation_id, p_requested_by, p_requested_by_member_id, p_kind, p_feature,
      p_request_text, p_interpreted_intent, coalesce(p_status, 'queued'), coalesce(p_priority, 0),
      p_client_request_id, p_started_at
    )
    returning id into v_id;
  exception when unique_violation then
    if p_client_request_id is null then
      raise;
    end if;
    select r.id into v_id
      from public.ai_requests r
     where r.family_id = p_family_id
       and r.client_request_id = p_client_request_id;
    if v_id is null then
      raise;
    end if;
    return query select v_id, 'existing'::text, null::integer;
    return;
  end;

  return query select v_id, 'admitted'::text, v_used + 1;
end
$$;

comment on function public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz) is
  'F19 (0477): files an ai_requests row for a capped plan only while the family''s rows since the UTC month start are below p_allowance, counted and inserted under a per-family advisory lock. Returns outcome admitted | refused | existing (a retry key already filed). Service role only.';

revoke all on function public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz) to service_role;

do $check$
declare
  fn text := 'public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz)';
begin
  if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
    raise exception '0477: a client role can still execute %', fn;
  end if;
  if not has_function_privilege('service_role', fn, 'execute') then
    raise exception '0477: service_role cannot execute %, so the ledger client cannot admit a request', fn;
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_requests' and column_name = 'metered'
       and is_nullable = 'NO' and column_default = 'true'
  ) then
    raise exception '0477: ai_requests.metered must be NOT NULL DEFAULT true, or existing rows and writers would stop being counted';
  end if;
end
$check$;
