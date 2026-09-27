-- ── A parent who leaves the family takes no assistant key with them (SRV-001 l12, 0419) ──
--
-- HOLDS: supabase/migrations/0419_a_departed_parent_keeps_no_assistant_key.sql
--
-- An assistant key speaks for the parent who minted it. Removing that parent
-- (family_members.is_active = false), demoting them, or deleting their member
-- row used to leave the key live, so a co-parent who had left could still have
-- Siri or Alexa read the family's day and, with `capture`, file into it.
-- lib/assistant/service.ts refuses such a key at resolution; 0419 retires it.
--
-- This probe proves, with the real roles where a member acts:
--
--   1. DEACTIVATION: parent A (with their own JWT) removes parent B, and B's
--      live key in this family is revoked;
--   2. DEMOTION: parent A demotes parent C to adult, and C's key is revoked;
--   3. DELETION: deleting parent D's member row revokes D's key;
--   4. WHAT IS LEFT ALONE: A's own live key stays live; A's already-retired key
--      keeps the revoked_at it had (the trigger does not re-stamp history);
--      B's key in ANOTHER household where B is still a parent stays live;
--      deactivating a CHILD changes no key; a parent re-saved as an active
--      parent (the same values) changes no key;
--   5. CATALOGUE: the trigger is on family_members for UPDATE and DELETE, its
--      function is SECURITY DEFINER with a pinned search_path, and neither
--      anon nor authenticated may EXECUTE it;
--   6. NEGATIVE CONTROL, last: with ONLY the trigger dropped, the same removal
--      of a parent leaves their key live — so 1–3 were the trigger and not
--      something else on the table.
--
-- Fixtures are seeded as postgres inside one transaction and rolled back.

\set UA '00000000-0000-4000-8419-0000000000a1'
\set UB '00000000-0000-4000-8419-0000000000a2'
\set UC '00000000-0000-4000-8419-0000000000a3'
\set UD '00000000-0000-4000-8419-0000000000a4'
\set UE '00000000-0000-4000-8419-0000000000a5'
\set UK '00000000-0000-4000-8419-0000000000a6'
\set F  '00000000-0000-4000-8419-0000000000f1'
\set F2 '00000000-0000-4000-8419-0000000000f2'

begin;

insert into auth.users (id, email) values
  (:'UA','m0419-a@example.com'), (:'UB','m0419-b@example.com'), (:'UC','m0419-c@example.com'),
  (:'UD','m0419-d@example.com'), (:'UE','m0419-e@example.com'), (:'UK','m0419-kid@example.com')
  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'F','Departed Parent House',:'UA') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F' and user_id = :'UA';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  (:'F',:'UB','Parent B','parent',true),
  (:'F',:'UC','Parent C','parent',true),
  (:'F',:'UD','Parent D','parent',true),
  (:'F',:'UE','Parent E','parent',true),
  (:'F',:'UK','Kid','child',true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;

-- F2: a household B also parents, which B's removal from F must not touch.
insert into public.families (id, name, created_by) values (:'F2','Parent B Elsewhere',:'UB') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F2' and user_id = :'UB';

insert into public.assistant_links (family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by, revoked_at) values
  (:'F', :'UA','siri',   'A live',        'm0419-a',     'm0419a',  array['ask','capture'], :'UA', null),
  (:'F', :'UA','siri',   'A retired',     'm0419-a-old', 'm0419ao', array['ask'],           :'UA', '2026-01-01T00:00:00Z'),
  (:'F', :'UB','alexa',  'B kitchen',     'm0419-b',     'm0419b',  array['ask','capture'], :'UB', null),
  (:'F2',:'UB','alexa',  'B elsewhere',   'm0419-b2',    'm0419b2', array['ask'],           :'UB', null),
  (:'F', :'UC','generic','C car',         'm0419-c',     'm0419c',  array['ask'],           :'UC', null),
  (:'F', :'UD','siri',   'D phone',       'm0419-d',     'm0419d',  array['ask'],           :'UD', null),
  (:'F', :'UE','siri',   'E phone',       'm0419-e',     'm0419e',  array['ask'],           :'UE', null);

do $$
declare
  fam uuid := '00000000-0000-4000-8419-0000000000f1';
  ua  uuid := '00000000-0000-4000-8419-0000000000a1';
  ub  uuid := '00000000-0000-4000-8419-0000000000a2';
  uc  uuid := '00000000-0000-4000-8419-0000000000a3';
  ud  uuid := '00000000-0000-4000-8419-0000000000a4';
  ue  uuid := '00000000-0000-4000-8419-0000000000a5';
  uk  uuid := '00000000-0000-4000-8419-0000000000a6';
  n int;
  failures text[] := '{}';
  live_of text;
  old_stamp timestamptz;
begin
  select revoked_at into old_stamp from public.assistant_links where token_hash = 'm0419-a-old';

  -- ── 1. Deactivation, as parent A ─────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', ua::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  update public.family_members set is_active = false where family_id = fam and user_id = ub;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('CONTROL: parent A could not remove parent B (%s rows) — step 1 measures nothing', n)); end if;

  -- ── 2. Demotion, as parent A ──────────────────────────────────────────────
  update public.family_members set role = 'adult' where family_id = fam and user_id = uc;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('CONTROL: parent A could not demote parent C (%s rows) — step 2 measures nothing', n)); end if;

  -- ── 4a. A child removed, and a parent re-saved unchanged ──────────────────
  update public.family_members set is_active = false where family_id = fam and user_id = uk;
  update public.family_members set is_active = true, role = 'parent' where family_id = fam and user_id = ue;
  perform set_config('role','postgres', true);

  -- ── 3. Deletion ───────────────────────────────────────────────────────────
  delete from public.family_members where family_id = fam and user_id = ud;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('CONTROL: parent D''s member row was not deleted (%s rows) — step 3 measures nothing', n)); end if;

  -- ── Verdicts, read as postgres ───────────────────────────────────────────
  for live_of in select token_hash from public.assistant_links where token_hash in ('m0419-b','m0419-c','m0419-d') and revoked_at is null loop
    failures := array_append(failures, format('key %s is still live after its parent left, was demoted or was deleted', live_of));
  end loop;
  select count(*) into n from public.assistant_links where token_hash in ('m0419-a','m0419-b2','m0419-e') and revoked_at is null;
  if n <> 3 then
    failures := array_append(failures, format('%s of 3 keys that must stay live are live (A''s own, B''s in the other household, E''s after an unchanged re-save)', n));
  end if;
  select count(*) into n from public.assistant_links where token_hash = 'm0419-a-old' and revoked_at = old_stamp;
  if n <> 1 then failures := array_append(failures, 'A''s already-retired key had its revoked_at rewritten — the trigger must not re-stamp history'); end if;

  -- ── 5. Catalogue ─────────────────────────────────────────────────────────
  select count(*) into n from pg_trigger t
   where t.tgname = 'family_members_retire_departed_parent_keys'
     and t.tgrelid = 'public.family_members'::regclass
     and not t.tgisinternal
     and (t.tgtype & 8) = 8     -- DELETE
     and (t.tgtype & 16) = 16;  -- UPDATE
  if n <> 1 then failures := array_append(failures, 'the retire trigger is not on family_members for both UPDATE and DELETE'); end if;
  select count(*) into n from pg_proc p
   where p.oid = 'public.retire_assistant_keys_of_a_departed_parent()'::regprocedure
     and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
  if n <> 1 then failures := array_append(failures, 'retire_assistant_keys_of_a_departed_parent is not SECURITY DEFINER with a pinned search_path'); end if;
  if has_function_privilege('anon', 'public.retire_assistant_keys_of_a_departed_parent()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.retire_assistant_keys_of_a_departed_parent()', 'EXECUTE') then
    failures := array_append(failures, 'anon or authenticated may EXECUTE the trigger function');
  end if;

  -- ── 6. Negative control: the trigger alone ────────────────────────────────
  drop trigger family_members_retire_departed_parent_keys on public.family_members;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', ua::text, true);
  update public.family_members set is_active = false where family_id = fam and user_id = ue;
  perform set_config('role','postgres', true);
  select count(*) into n from public.assistant_links where token_hash = 'm0419-e' and revoked_at is null;
  if n <> 1 then
    failures := array_append(failures, 'with the trigger dropped, removing parent E still retired their key — steps 1-3 were not shown to be the trigger''s');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a departed parent keeps an assistant key:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-departed-parent-keeps-no-assistant-key: OK (a parent removed, demoted or deleted loses their live keys in that family; their keys elsewhere, the remover''s own key, an already-retired key''s stamp, a child''s removal and an unchanged re-save are untouched; the trigger is SECURITY DEFINER with a pinned search_path and not executable by the API roles; negative control: with the trigger dropped the removed parent''s key stayed live)';
end $$;

rollback;
