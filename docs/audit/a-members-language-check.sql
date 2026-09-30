-- A member's language is stored, is theirs alone to set, and is only ever a
-- language the product ships. (I18N-001, migration 0466)
--
--   a member sets their own language to de-DE                   -> allowed (control)
--   a member clears their own language (back to "never chosen")  -> allowed (control)
--   a co-member reads it                                         -> allowed (control)
--   a member sets ANOTHER member's language                      -> REFUSED (0 rows)
--   someone in ANOTHER family reads or sets it                   -> REFUSED (0 rows)
--   a member moves their own row onto another id                 -> REFUSED
--   a language the product does not ship ('xx-XX', 'de')        -> REFUSED (23514)
--   the service role (the senders) reads every member's language -> allowed (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  parent   uuid := '00000000-0000-4000-8000-00000000e468';
  spouse   uuid := '00000000-0000-4000-8000-00000000e469';
  fam      uuid := '00000000-0000-4000-8000-00000000e46a';
  outsider uuid := '00000000-0000-4000-8000-00000000e46b';
  other    uuid := '00000000-0000-4000-8000-00000000e46c';
  n        int;
  v        text;
  before   text;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (parent, 'lang-parent@example.test'), (spouse, 'lang-spouse@example.test'),
    (outsider, 'lang-outsider@example.test')
  on conflict (id) do nothing;
  insert into public.profiles (id, email, full_name) values
    (parent, 'lang-parent@example.test', 'Parent'), (spouse, 'lang-spouse@example.test', 'Spouse'),
    (outsider, 'lang-outsider@example.test', 'Outsider')
  on conflict (id) do update set locale = null;
  insert into public.families (id, name, created_by) values
    (fam, 'Family', parent), (other, 'Other family', outsider)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent, 'Parent', 'parent', true), (fam, spouse, 'Spouse', 'adult', true),
    (other, outsider, 'Outsider', 'parent', true)
  on conflict (family_id, user_id) do update set is_active = true;

  -- ── CONTROL: a member sets their own language ───────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', spouse::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set locale = 'de-DE' where id = spouse;
  get diagnostics n = row_count;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: a member could not set their own language (% rows)', n; end if;

  -- ── CONTROL: a co-member reads it ────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select locale into v from public.profiles where id = spouse;
  reset role;
  if v is distinct from 'de-DE' then raise exception 'CONTROL FAILED: the stored language reads back as %', v; end if;

  -- ── 1. a member sets ANOTHER member's language ───────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set locale = 'fr-FR' where id = spouse;
  get diagnostics n = row_count;
  reset role;
  select locale into v from public.profiles where id = spouse;
  if n <> 0 or v is distinct from 'de-DE' then
    raise warning 'BREACH: a member rewrote another member''s language (% rows, now %)', n, v;
    failures := failures + 1;
  end if;

  -- ── 2. someone in ANOTHER family reads or sets it ───────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', outsider::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = spouse;
  reset role;
  if n <> 0 then
    raise warning 'BREACH: another family reads a member''s profile (and language)';
    failures := failures + 1;
  end if;
  select locale into before from public.profiles where id = spouse;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set locale = 'it-IT' where id = spouse;
  get diagnostics n = row_count;
  reset role;
  select locale into v from public.profiles where id = spouse;
  if n <> 0 or v is distinct from before then
    raise warning 'BREACH: another family rewrote a member''s language (% rows, now %)', n, v;
    failures := failures + 1;
  end if;

  -- ── 3. a member moves their own row onto another id ─────────────────────
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', parent::text, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.profiles set id = '00000000-0000-4000-8000-00000000e46f' where id = parent;
    reset role;
    raise warning 'BREACH: a member moved their profile row onto another id';
    failures := failures + 1;
  exception when insufficient_privilege or foreign_key_violation or check_violation then
    reset role;
  end;

  -- ── 4. a language the product does not ship ──────────────────────────────
  foreach v in array array['xx-XX', 'de', 'de-de', ''] loop
    begin
      update public.profiles set locale = v where id = parent;
      raise warning 'BREACH: profiles.locale accepted %', quote_literal(v);
      failures := failures + 1;
    exception when check_violation then
      null;
    end;
  end loop;

  -- ── CONTROL: clearing is allowed, and the service role reads everyone ────
  perform set_config('request.jwt.claims', json_build_object('sub', spouse::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set locale = null where id = spouse;
  get diagnostics n = row_count;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: a member could not clear their own language'; end if;
  update public.profiles set locale = 'nl-NL' where id = spouse;
  set local role service_role;
  select count(*) into n from public.profiles where id in (parent, spouse);
  reset role;
  if n <> 2 then raise exception 'CONTROL FAILED: the service role reads % of 2 member languages', n; end if;

  if failures > 0 then
    raise exception 'a-members-language: % breach(es)', failures;
  end if;
  raise notice 'a-members-language: all checks passed';
end
$probe$;

rollback;
