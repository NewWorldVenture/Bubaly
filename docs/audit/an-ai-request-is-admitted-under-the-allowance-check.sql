-- ── A capped family's AI request is admitted under its allowance (0477, F19) ──
--
-- The Free plan sells 10 AI requests a month, and the meter is a COUNT of the
-- family's metered `ai_requests` rows since the UTC month began. 0477's
-- `admit_ai_request` counts and files as ONE decision under a per-family lock,
-- so parallel requests at 9 of 10 file exactly one row; `ai_requests.metered`
-- keeps work the family did not ask for (chore-proof checks, inbound intake,
-- routines, paperwork transcription) out of that count.
--
-- The app's tests drive an in-memory emulator of this function. This probe is
-- the same contract against the real migration, on the replayed database:
--
--   1. at 9 of 10 a request is ADMITTED, and the answer reports 10 used;
--   2. at 10 of 10 the next is REFUSED, and nothing is filed;
--   3. unmetered rows are not counted: 9 metered + 5 unmetered admits;
--   4. NEGATIVE CONTROL: the same 5 rows metered make the family 14 of 10, and
--      the request is refused — the predicate is what lets 3 pass;
--   5. a row filed last month is outside the window;
--   6. a retry key already filed answers EXISTING with the first row's id, even
--      at the cap, and files nothing; a new key at the cap is refused;
--   7. a plain insert that says nothing about `metered` is metered (the
--      column's default — every writer that predates 0477 stays counted);
--   8. no client role may execute the function: only the ledger client
--      (service_role) admits.
--
-- Concurrency itself (the per-family advisory lock) needs several sessions and
-- is proven by the local multi-session script in docs/audit/f19-atomic-
-- admission.md; this probe proves the decision each session makes.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/an-ai-request-is-admitted-under-the-allowance-check.sql

\set FA '00000000-0000-4000-8000-00000000f190'
\set UA '00000000-0000-4000-8000-00000000f191'

begin;

insert into auth.users (id, email) values (:'UA', 'f19-admission-probe@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA', 'Admission Probe House', :'UA') on conflict do nothing;

do $$
declare
  fam   constant uuid := '00000000-0000-4000-8000-00000000f190';
  fn    constant text := 'public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz)';
  failures text[] := '{}';
  r     record;
  first_id uuid;
  n     int;
begin
  -- 8. Only the ledger client may admit.
  if has_function_privilege('authenticated', fn, 'execute') or has_function_privilege('anon', fn, 'execute') then
    failures := array_append(failures, 'a client role can execute admit_ai_request — admission must be the ledger client''s alone');
  end if;
  if not has_function_privilege('service_role', fn, 'execute') then
    failures := array_append(failures, 'service_role cannot execute admit_ai_request, so no capped request can be filed');
  end if;

  -- 7. The column's default keeps every older writer counted.
  insert into public.ai_requests (family_id, kind, feature, request_text, status)
    values (fam, 'feature', 'probe.default', 'Probe default', 'completed') returning metered into r;
  if r.metered is distinct from true then
    failures := array_append(failures, 'a row filed without saying metered is not metered — writers that predate 0477 would stop counting');
  end if;
  delete from public.ai_requests where family_id = fam;

  -- 9 metered rows this month, 5 unmetered (exempt work), 3 last month.
  insert into public.ai_requests (family_id, kind, feature, request_text, status)
    select fam, 'feature', 'probe.paid', 'Probe paid', 'completed' from generate_series(1, 9);
  insert into public.ai_requests (family_id, kind, feature, request_text, status, metered)
    select fam, 'feature', 'chores.validate', 'Probe exempt', 'completed', false from generate_series(1, 5);
  insert into public.ai_requests (family_id, kind, feature, request_text, status, created_at)
    select fam, 'feature', 'probe.old', 'Probe last month', 'completed', date_trunc('month', now(), 'UTC') - interval '1 day' from generate_series(1, 3);

  perform set_config('role', 'service_role', true);

  -- 4. NEGATIVE CONTROL first, in a subtransaction: count the exempt rows and
  --    the family is past its cap.
  begin
    update public.ai_requests set metered = true where family_id = fam and feature = 'chores.validate';
    select * into r from public.admit_ai_request(fam, 10, 'feature', 'Probe control', p_feature => 'probe.control');
    if r.outcome <> 'refused' then
      failures := array_append(failures, format('negative control: with the exempt rows metered the family is 14 of 10, yet the admission answered %s', r.outcome));
    end if;
    raise exception using errcode = 'P0001', message = 'probe-rollback';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'probe-rollback' then raise; end if;
  end;

  -- 1, 3, 5, 6. At 9 metered (5 unmetered, 3 last month ignored), a keyed request is admitted as the 10th.
  select * into r from public.admit_ai_request(fam, 10, 'feature', 'Probe tenth', p_feature => 'probe.tenth', p_client_request_id => 'probe-key-0001');
  if r.outcome <> 'admitted' or r.used <> 10 or r.request_id is null then
    failures := array_append(failures, format('at 9 of 10 (with 5 unmetered and 3 last-month rows) the request was not admitted as the 10th: %s used %s', r.outcome, r.used));
  end if;
  first_id := r.request_id;

  -- 6. The same key again, now at the cap: the request it already filed.
  select * into r from public.admit_ai_request(fam, 10, 'feature', 'Probe tenth', p_feature => 'probe.tenth', p_client_request_id => 'probe-key-0001');
  if r.outcome <> 'existing' or r.request_id is distinct from first_id then
    failures := array_append(failures, format('a retry of the 10th request at the cap answered %s (%s), not existing with its own id', r.outcome, r.request_id));
  end if;

  -- 2, 6. A new request — keyed or not — at the cap is refused and files nothing.
  select * into r from public.admit_ai_request(fam, 10, 'feature', 'Probe eleventh', p_feature => 'probe.eleventh', p_client_request_id => 'probe-key-0002');
  if r.outcome <> 'refused' or r.used <> 10 then
    failures := array_append(failures, format('a new key at 10 of 10 answered %s used %s', r.outcome, r.used));
  end if;
  select * into r from public.admit_ai_request(fam, 10, 'feature', 'Probe eleventh', p_feature => 'probe.eleventh');
  if r.outcome <> 'refused' then
    failures := array_append(failures, format('an unkeyed request at 10 of 10 answered %s', r.outcome));
  end if;

  perform set_config('role', 'none', true);
  select count(*) into n from public.ai_requests where family_id = fam and metered and created_at >= date_trunc('month', now(), 'UTC');
  if n <> 10 then
    failures := array_append(failures, format('the family holds %s metered rows this month after admitting to its cap of 10', n));
  end if;
  select count(*) into n from public.ai_requests where family_id = fam and feature = 'probe.eleventh';
  if n <> 0 then
    failures := array_append(failures, format('%s refused request(s) were filed anyway', n));
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'0477 admission probe failed:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice '0477 admission probe: 8 assertions hold (admit at 9, refuse at 10, exempt rows uncounted with a negative control, month window, retry key, default, privileges)';
end
$$;

rollback;
