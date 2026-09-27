-- A family can create a circle on Supabase, where pgcrypto lives in
-- `extensions` rather than `public` (0444).
--
-- `marketplace_create_circle` pinned `search_path = public` and calls
-- pgcrypto's `gen_random_bytes`. This replay runs on plain Postgres, where
-- pgcrypto lands in `public`, so the function worked here and failed on every
-- Supabase database with 42883. The probe reproduces Supabase's layout: inside
-- a transaction it rolls back, it moves pgcrypto into `extensions`, then
-- creates a circle as a family's parent.
--
-- CONTROL, first: after the move, `gen_random_bytes` must NOT resolve from a
-- `public`-only search path. If it still did, the layout was not reproduced
-- and a green result would prove nothing.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

create schema if not exists extensions;
do $move$
begin
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pgcrypto') <> 'extensions' then
    alter extension pgcrypto set schema extensions;
  end if;
end
$move$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000c9e01';
  u   uuid := '00000000-0000-4000-8000-0000000c9e0a';
  got uuid;
  code text;
begin
  -- Control: Supabase's layout is in force for this transaction.
  begin
    perform set_config('search_path', 'public', true);
    perform gen_random_bytes(8);
    raise exception 'CONTROL FAILED: gen_random_bytes still resolves from search_path=public, so pgcrypto was not moved and this probe reproduces nothing';
  exception when undefined_function then null;
  end;
  perform set_config('search_path', 'public', true);

  insert into auth.users (id, email) values (u, 'circle-pgcrypto@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Pgcrypto circle family', u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, u, 'Parent', 'parent', true) on conflict do nothing;

  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin
    got := public.marketplace_create_circle(fam, 'Probe circle');
  exception when undefined_function then
    raise exception 'BREACH: creating a circle fails where pgcrypto lives in extensions (as on Supabase): %', sqlerrm;
  end;
  reset role;

  select join_code into code from public.marketplace_circles where id = got;
  if code is null or length(code) <> 8 then
    raise exception 'BREACH: the circle was created without an 8-character join code (got %)', code;
  end if;
  raise notice '0444 OK: with pgcrypto in extensions (control: not reachable from public alone), a parent creates a circle with an 8-character join code';
end
$probe$;

rollback;
