-- ── A request's words are its requester's and a manager's (0480) ─────────────
--
-- #892 comment 5973332041: any family member could read another member's
-- `ai_requests.request_text` (what they typed to the concierge) and
-- `ai_requests.clarifications` (the planner's questions and their ANSWERS) as
-- `authenticated`. 0480 withdraws those two columns from `authenticated` and
-- serves them through `ai_request_words(uuid[])` to the requester or a manager.
-- Against the replayed schema, as real roles with real JWT claims:
--
--   1. a CHILD reading a sibling's request_text, or its clarifications, is
--      refused (42501);
--   2. the same child still reads the row's other columns — the family ledger,
--      and the count the F19 allowance meter takes through a member's session;
--   3. the REQUESTER (a teen) gets their own words and answers from
--      ai_request_words;
--   4. a PARENT (manager) gets them too;
--   5. the sibling gets nothing from ai_request_words, and a parent of ANOTHER
--      family gets nothing either;
--   6. anon cannot execute ai_request_words; authenticated and service_role can;
--   7. the requester's own plan stays readable (0250's policy reads
--      `ai_requests.requested_by` as the invoking member);
--   8. `authenticated` holds SELECT on exactly the columns of ai_requests
--      except request_text and clarifications — a column added later must be
--      granted on purpose;
--   9. NEGATIVE CONTROL: with request_text granted back (in a subtransaction),
--      the child reads the sibling's words — so check 1 is what 0480 changed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-request-text-is-its-requesters-check.sql

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000048001', 'requester-0480@example.com'),
  ('00000000-0000-4000-8000-000000048002', 'sibling-0480@example.com'),
  ('00000000-0000-4000-8000-000000048003', 'parent-0480@example.com'),
  ('00000000-0000-4000-8000-000000048004', 'other-parent-0480@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8000-0000000480f0', 'Request Text Probe House', '00000000-0000-4000-8000-000000048003'),
  ('00000000-0000-4000-8000-0000000480f1', 'Request Text Other House', '00000000-0000-4000-8000-000000048004');
insert into public.family_members (family_id, user_id, role, display_name, is_active) values
  ('00000000-0000-4000-8000-0000000480f0', '00000000-0000-4000-8000-000000048001', 'teen',   'Requester', true),
  ('00000000-0000-4000-8000-0000000480f0', '00000000-0000-4000-8000-000000048002', 'child',  'Sibling',   true),
  ('00000000-0000-4000-8000-0000000480f0', '00000000-0000-4000-8000-000000048003', 'parent', 'Parent',    true),
  ('00000000-0000-4000-8000-0000000480f1', '00000000-0000-4000-8000-000000048004', 'parent', 'Other',     true)
  on conflict do nothing;
insert into public.ai_requests (id, family_id, kind, requested_by, request_text, status, clarifications) values
  ('00000000-0000-4000-8000-0000000480a1', '00000000-0000-4000-8000-0000000480f0', 'concierge',
   '00000000-0000-4000-8000-000000048001', 'Probe private: plan a surprise for my sister', 'queued',
   '[{"question":"Which day?","answer":"Probe answer: Saturday, while she is at practice"}]'::jsonb);
insert into public.ai_plans (family_id, request_id, objective)
  select '00000000-0000-4000-8000-0000000480f0', '00000000-0000-4000-8000-0000000480a1', 'Probe plan'
  where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_plans' and column_name = 'objective');

do $$
declare
  fam    constant uuid := '00000000-0000-4000-8000-0000000480f0';
  req    constant uuid := '00000000-0000-4000-8000-0000000480a1';
  words  constant text := 'Probe private: plan a surprise for my sister';
  fn     constant text := 'public.ai_request_words(uuid[])';
  failures text[] := '{}';
  got    text;
  n      int;
  kept   text[];
  want   text[];
  has_fn boolean;
begin
  -- The function exists at all (without it, the checks that call it are skipped
  -- and this is the failure reported).
  has_fn := to_regprocedure(fn) is not null;
  if not has_fn then
    failures := array_append(failures, 'public.ai_request_words(uuid[]) does not exist: neither the requester nor a manager can read the words through a member session');
  end if;

  -- 6. Execute privileges.
  if has_fn and has_function_privilege('anon', fn, 'execute') then
    failures := array_append(failures, 'anon can execute ai_request_words');
  end if;
  if has_fn and not has_function_privilege('authenticated', fn, 'execute') or has_fn and not has_function_privilege('service_role', fn, 'execute') then
    failures := array_append(failures, 'authenticated or service_role cannot execute ai_request_words');
  end if;

  -- 8. The columns a member keeps: all of them but request_text.
  select array_agg(column_name::text order by column_name) into want
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_requests' and column_name not in ('request_text', 'clarifications');
  select array_agg(c.column_name::text order by c.column_name) into kept
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'ai_requests'
     and has_column_privilege('authenticated', 'public.ai_requests', c.column_name, 'select');
  if kept is distinct from want then
    failures := array_append(failures, format('authenticated may select %s; expected every column but request_text and clarifications (%s)', kept, want));
  end if;
  if has_column_privilege('anon', 'public.ai_requests', 'request_text', 'select') then
    failures := array_append(failures, 'anon may select ai_requests.request_text');
  end if;

  -- ── As the SIBLING (child) ──
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000048002","role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  -- 1. The words: refused.
  begin
    select r.request_text into got from public.ai_requests r where r.id = req;
    failures := array_append(failures, format('a sibling read another member''s request_text: %L', got));
  exception when insufficient_privilege then null;
  end;
  begin
    select r.clarifications::text into got from public.ai_requests r where r.id = req;
    failures := array_append(failures, format('a sibling read another member''s clarification answers: %s', got));
  exception when insufficient_privilege then null;
  end;
  -- 2. Everything else: still the family's.
  select count(*) into n from public.ai_requests r where r.family_id = fam;
  if n <> 1 then
    failures := array_append(failures, format('a sibling counts %s of the family''s requests (expected 1): the F19 meter would under-count', n));
  end if;
  select r.kind into got from public.ai_requests r where r.id = req;
  if got is distinct from 'concierge' then
    failures := array_append(failures, 'a sibling can no longer read the request''s other columns');
  end if;
  -- 5. The function gives a sibling nothing.
  n := 0;
  if has_fn then execute 'select count(*) from public.ai_request_words($1)' into n using array[req]; end if;
  if n <> 0 then
    failures := array_append(failures, 'ai_request_words gave a sibling the request''s words');
  end if;

  -- ── As the REQUESTER (teen) ──
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000048001","role":"authenticated"}', true);
  -- 3. Their own words.
  got := null;
  if has_fn then execute 'select request_text from public.ai_request_words($1)' into got using array[req]; end if;
  if has_fn and got is distinct from words then
    failures := array_append(failures, format('the requester did not get their own words back: %L', got));
  end if;
  got := null;
  if has_fn then execute 'select clarifications::text from public.ai_request_words($1)' into got using array[req]; end if;
  if has_fn and coalesce(got, '') not like '%Probe answer: Saturday%' then
    failures := array_append(failures, format('the requester did not get their own clarification answers back: %s', got));
  end if;
  -- 7. Their plan, through 0250's policy on requested_by.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_plans' and column_name = 'objective') then
    select count(*) into n from public.ai_plans p where p.request_id = req;
    if n <> 1 then
      failures := array_append(failures, format('the requester sees %s of their own plans (expected 1): the policies on ai_requests.requested_by broke', n));
    end if;
  end if;

  -- ── As a PARENT of the family (manager) ──
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000048003","role":"authenticated"}', true);
  -- 4.
  got := null;
  if has_fn then execute 'select request_text from public.ai_request_words($1)' into got using array[req]; end if;
  if has_fn and got is distinct from words then
    failures := array_append(failures, format('a parent of the family did not get the words: %L', got));
  end if;

  -- ── As a parent of ANOTHER family ──
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000048004","role":"authenticated"}', true);
  -- 5.
  n := 0;
  if has_fn then execute 'select count(*) from public.ai_request_words($1)' into n using array[req]; end if;
  if n <> 0 then
    failures := array_append(failures, 'ai_request_words gave another family''s parent the words');
  end if;

  perform set_config('role', 'none', true);

  -- 9. NEGATIVE CONTROL: grant the column back and the sibling reads it.
  begin
    grant select (request_text) on public.ai_requests to authenticated;
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000048002","role":"authenticated"}', true);
    perform set_config('role', 'authenticated', true);
    select r.request_text into got from public.ai_requests r where r.id = req;
    if got is distinct from words then
      failures := array_append(failures, 'negative control: with request_text granted, the sibling still could not read it — check 1 does not show what 0480 changed');
    end if;
    raise exception using errcode = 'P0001', message = 'probe-rollback';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'probe-rollback' then raise; end if;
  end;
  perform set_config('role', 'none', true);

  if array_length(failures, 1) > 0 then
    raise exception E'0480 request-words probe failed:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice '0480 request-words probe: 9 assertions hold (sibling refused on text and answers, ledger and meter intact, requester and manager served, other family and anon refused, plans intact, exact column grant, negative control)';
end
$$;

rollback;
