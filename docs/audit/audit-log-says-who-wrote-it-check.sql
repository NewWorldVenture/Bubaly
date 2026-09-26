-- ── S-04 The audit trail records who actually appended, not who was claimed ──
--
-- `audit_insert` pinned `family_id` and nothing else, so `actor_id` was free: a
-- child could file a row attributing an action to a parent, and
-- `/family/activity` renders exactly what the row says. The `family_id is null`
-- branch let any authenticated user write rows no RLS reader can see and which
-- `app/(app)/admin/security/page.tsx` renders with the SERVICE client.
--
-- 0260 fixed the same defect on `trust_audit_logs` by dropping member INSERT
-- outright. That is not available here: 0320 counted fourteen callers that
-- append on the caller's own client, and `docs/audit/household-trail-check.sql`
-- states the intent — "ANY member may append … while only a parent or adult may
-- read it back". So 0320 pins the shape instead, and this proves the pin without
-- weakening append.
--
--   1. a child can STILL append a row about themselves (append is preserved —
--      a boundary that stops the honest caller is the wrong boundary);
--   2. a child CANNOT append a row naming the parent as actor;
--   3. a child CANNOT append a row with no household at all;
--   4. a parent cannot forge either — this is not a role check, it is identity;
--   5. reads stay manager-only (unchanged by 0320, asserted so a later edit to
--      the insert policy cannot quietly take the read policy with it);
--   6. the policies refusing 2–5 are the ones this header names, read back from
--      `pg_policies` at run time rather than from a grep of the corpus.
--
-- NEGATIVE CONTROL, and it runs FIRST, before any of the six
-- ---------------------------------------------------------------------------
-- The rule under test is 0320's, not 0004's and not 0118's. The policy is
-- created in exactly three files:
--
--   grep -ln "audit_insert on public\.audit_logs" supabase/migrations/*.sql
--     -> 0004_rls.sql  0118_rls_drift_repair.sql  0320_audit_logs_says_who_wrote_it.sql
--
-- (a bare `grep -l audit_insert` also hits 0093_trust_engine.sql and
-- 0260_trust_ledger_lockdown.sql, whose `trust_audit_insert` is the SIBLING
-- table's policy and matches only as a substring). The last of the three,
-- `0320_audit_logs_says_who_wrote_it.sql:51-57`, drops `audit_insert` and
-- re-creates it as
--
--   for insert to authenticated
--   with check (public.is_family_member(family_id) and actor_id = auth.uid())
--
-- so the predicate under test is that conjunction, and NOT 0118's
-- `family_id is null or public.is_family_member(family_id)`. The READ half
-- asserted in 5 is still `audit_select`, `using (public.can_manage_family
-- (family_id))`, last created at 0118_rls_drift_repair.sql:113 and deliberately
-- left alone by 0320. (Earlier revisions of this header said "0300" for the fix;
-- 0300 is `0300_entitlement_is_not_client_writable.sql` and never touches this
-- table.)
--
-- The mechanism is RLS on both halves — not a trigger, not a CHECK, not a GRANT.
-- The evidence, and the greps that actually find these things in this repo:
--
--   * Every STATIC statement naming the table:
--       grep -n "on public\.audit_logs" supabase/migrations/*.sql
--     returns 0002's `idx_audit_family` and the drop/create policy lines of 0004,
--     0118 and 0320 — nothing else, and nothing in any file after 0320. (A
--     `grep trigger … | grep audit_logs` pipeline is NOT evidence: this repo
--     writes `create trigger x` and `after insert … on public.t` on separate
--     lines, e.g. 0034_social_command_center.sql:675-676, so it cannot see a
--     trigger in the house style.)
--   * Every DYNAMIC trigger: `grep -n -iE "create (constraint )?trigger"
--     supabase/migrations/*.sql | grep -E "%I|%s"` finds the `set_updated_at`
--     loops (0003, 0013, 0018, 0020, 0022, 0034, 0036, …), every one of them
--     BEFORE UPDATE — it cannot fire on an INSERT — and chosen either by an
--     `updated_at` column `audit_logs` does not have (0002_tables.sql:454-463)
--     or by a fixed list; plus four more fixed-list loops — 0134
--     (`trg_mark_model_dirty`), 0311 and 0313 (`reference_shares_family`), 0338
--     (`attribution_is_immutable`). `grep -n "'audit_logs'"
--     supabase/migrations/*.sql` shows the only list naming the table is
--     0118's EXCLUSION list, below.
--   * Dynamic policies: 0004's generic-CRUD loop is a fixed list without
--     `audit_logs`, and 0118's catalog-driven heal loop excludes it by name
--     (0118_rls_drift_repair.sql:159). Check 6 settles the rest at run time:
--     the table must carry exactly `audit_insert` and `audit_select`.
--   * No CHECK constraint and no unique index beyond the PK (0002:454-464); no
--     GRANT, REVOKE or ALTER TABLE names `public.audit_logs` anywhere in the
--     corpus, and no migration sets FORCE ROW LEVEL SECURITY. `authenticated`
--     holds DML here through the bootstrap's `alter default privileges in schema
--     public grant all on tables` (docs/audit/pg-bootstrap.sh), which is what a
--     hosted project ships.
--   * 0004 and 0118 enable row level security on every public BASE TABLE in a
--     loop, this one included.
--
-- This probe grants NOTHING. An earlier revision ran `grant select, insert on
-- public.audit_logs to authenticated` before the checks, which made a
-- production `revoke insert … from authenticated` invisible here, and made a
-- revoke-or-narrow refusal of 2, 3 or 4 read as the actor pin. With the grant
-- gone the controls below see the privileges the schema really has.
--
-- Why the six checks need one. Check 1 — the child's honest append — is a
-- positive append and it does rule out the crudest confounders: a dead
-- `auth.uid()` makes `actor_id = auth.uid()` NULL and refuses check 1 too, and
-- so does a missing table-level INSERT. What check 1 is NOT is the MIRROR of any
-- refusal below. It differs from 2 in actor_id, action, resource AND metadata
-- (a column check 1 does not even name, so a column grant narrowed to leave
-- `metadata` out refuses 2 with the same bare 42501 and leaves 1 alone); from 3
-- in family_id, action AND resource; from 4 in the session. So a guard trigger
-- keyed on the SHAPE of the write — `action = 'delete'`, `resource =
-- 'platform'`, `family_id is null`, `metadata is not null` — raises 42501 on 2
-- or 3 and leaves 1 completely untouched, and this repository refuses writes
-- with exactly that kind of guard trigger in 0223, 0305, 0326 and 0331. Add one
-- for an unrelated rule and 2 and 3 keep passing with the WITH CHECK loosened
-- back to 0118's, which is the whole of what 0320 bought. Check 5's
-- child-reads-zero has no control at all: the parent's read above it proves rows
-- exist and that a PARENT can see them, and says nothing about whether the
-- CHILD's session could have read an audit row through `audit_select` at all — a
-- session that can read none reports zero exactly as a working
-- `can_manage_family` does.
--
-- So the control has five legs, and every one must LAND. They run in the order
-- D's seed row and O (both as the owner, before any role switch), then A, B, D,
-- C — D reads as the child, so it has to run before C moves the session to the
-- parent:
--
--   O. the EXACT rows of 2, 3 and 4, appended by the table's owner before any
--      role switch. The owner bypasses RLS and privileges and nothing else:
--      BEFORE triggers, CHECK and NOT NULL constraints and FKs all still fire.
--      So a landing row proves that nothing but RLS (or the client session)
--      can refuse that row — including the key leg B cannot reach, a trigger
--      on `family_id is null`, whose refusal would otherwise be certified as
--      0320 having dropped the null branch;
--   A. the mirror of 2, in the child's session: the kid's own id in place of
--      the parent's, every other column AND value identical — `metadata`
--      included, same jsonb note. It is the one column no other write in this
--      probe names, so it is what catches a column grant narrowed to leave
--      `metadata` out (and a trigger keyed on it);
--   B. the mirror of 3: `family_id = FA` in place of null, same action, same
--      resource — 'security.alert' on 'platform' is precisely the shape a
--      future "platform rows are service-role only" trigger would key on;
--   D. the mirror of 5: the SAME child reading `audit_logs` in a SECOND family
--      where that child is an ADULT — the one `member_role` value
--      (0001_extensions_enums.sql:9-10) that `can_manage_family` counts and
--      `is_family_admin` (0003:32-39, parent-only) does not. So `audit_select`
--      answers yes for the very session it answers no for in 5 ONLY if it is
--      still `can_manage_family`; a drift to the parent-only helper reads zero
--      here. Its row is appended as postgres before any role switch — inside
--      the control and row-counted, so a refused seed fails D by name instead
--      of aborting the file — and D measures the read policy, not the write;
--   C. the mirror of 4: the PARENT signing for themselves instead of for the
--      child. The probe appends that row again further down as the fix's
--      positive control, but a control that runs AFTER the refusal it explains
--      cannot stop the refusal being misread, and that one is not row-counted.
--
-- Every write leg row-counts with `get diagnostics` instead of trusting the
-- absence of an exception, because a BEFORE trigger that returns NULL swallows
-- a row silently and "no error" is not "the write landed"; and every leg
-- catches `others`, not just `insufficient_privilege`, because the confounder
-- being ruled out may not raise 42501 at all.
--
-- If any leg fails the probe raises UNPROVEN and does not run the refusals: not
-- "the boundary holds", not "the boundary is broken", but "this session never
-- had the access the refusals are supposed to be measuring". Red either way.
-- Legs A and C are also the honest appends 1 and the parent's positive control
-- guard, so an append regression surfaces HERE, as UNPROVEN, and their messages
-- say so rather than leaving the operator to hunt for a confounder.
--
-- The control's rows are left where they land rather than deleted, unlike the
-- child_logins control: `audit_logs` has no unique index for them to collide
-- with, every count this probe takes afterwards is asserted zero/non-zero and
-- never exact (so extra rows in FA cannot change an answer), and the whole file
-- is one transaction that ends in `rollback`.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/audit-log-says-who-wrote-it-check.sql

\set FA '00000000-0000-4000-8000-0000000000d1'
\set UP '00000000-0000-4000-8000-0000000000d2'
\set UK '00000000-0000-4000-8000-0000000000d3'
-- The control household for leg D: a second family the SAME child manages.
\set FB '00000000-0000-4000-8000-0000000000d9'

begin;

insert into auth.users (id, email) values (:'UP','d-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','d-kid@example.com')    on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA','Trail House',:'UP') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

-- ── The negative control's own household (leg D) ─────────────────────────────
-- FB is a family the KID created. `handle_new_family` (0257_family_ai_settings
-- .sql:78-98) files the creator as a 'parent' member, so the upsert below always
-- takes its `do update` branch and DEMOTES that row to 'adult': the role
-- `can_manage_family` (`role in ('parent','adult') and is_active`, 0003:22-29)
-- counts and `is_family_admin` (`role = 'parent'`) does not. A parent here
-- would read the trail under either helper and prove nothing about which one
-- `audit_select` is. 0299's `trg_family_keeps_a_manager` is satisfied (an
-- active adult IS a manager) and is deferred to a COMMIT this file never runs.
insert into public.families (id, name, created_by) values (:'FB','Kid''s Own House',:'UK') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FB',:'UK','Kid (an adult here)','adult',true)
  on conflict (family_id, user_id) do update set role = 'adult', is_active = true;
-- The trail row leg D reads is appended INSIDE the control, as postgres before
-- any role switch (so D measures `audit_select`, not `audit_insert`), and is
-- row-counted there. As a bare statement up here, anything that refused it — a
-- guard trigger on audit_logs, say — would abort the file before a single leg
-- ran, and the red would name no control at all.

do $$
declare
  n int;
  pols text;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-0000000000d1';
  parent_u constant uuid := '00000000-0000-4000-8000-0000000000d2';
  kid_u    constant uuid := '00000000-0000-4000-8000-0000000000d3';
  ctl_fam  constant uuid := '00000000-0000-4000-8000-0000000000d9';
  control_ok boolean := true;
begin
  -- ── NEGATIVE CONTROL: same row or same session, the other answer ───────────
  -- Five legs, and they run FIRST. O appends the refused rows themselves as the
  -- owner; A, B, D and C are each the mirror of one check below — the same
  -- session, one field changed, the field the predicate keys on. All must LAND.
  -- See the header for what each one catches.

  -- D's seed: the one trail row in FB that leg D must be able to read.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (ctl_fam, kid_u, 'update', 'chores');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL D FAILED: the table OWNER''s append of the trail row leg D reads stored 0 rows, so leg D has nothing to read and the zero-row read in 5 would prove nothing about audit_select');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL D FAILED: the table OWNER was refused the trail row leg D reads (%s: %s) — RLS does not apply to the owner, so a trigger or constraint refuses every audit row of this shape, and the zero-row read in 5 would prove nothing about audit_select', sqlstate, sqlerrm));
  end;

  -- O. The EXACT rows of 2, 3 and 4, as the table owner, before any role
  --    switch: RLS and privileges are bypassed, triggers and constraints are not.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values (fam, parent_u, 'delete', 'wallet_transactions', '{"note":"written by the child"}'::jsonb);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL O FAILED: the table OWNER''s append of check 2''s exact row stored 0 rows, so something other than RLS swallows that row and the refusal in 2 would prove nothing about actor_id = auth.uid()');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL O FAILED: the table OWNER was refused check 2''s exact row (%s: %s) — RLS does not apply to the owner, so a trigger or constraint refuses it and the refusal in 2 would prove nothing about actor_id = auth.uid()', sqlstate, sqlerrm));
  end;
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (null, kid_u, 'security.alert', 'platform');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL O FAILED: the table OWNER''s append of check 3''s exact family_id IS NULL row stored 0 rows, so something other than RLS swallows that row and the refusal in 3 would prove nothing about 0320 dropping the null branch');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL O FAILED: the table OWNER was refused check 3''s exact family_id IS NULL row (%s: %s) — RLS does not apply to the owner, so a trigger or constraint refuses it and the refusal in 3 would prove nothing about 0320 dropping the null branch', sqlstate, sqlerrm));
  end;
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'create', 'allowance');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL O FAILED: the table OWNER''s append of check 4''s exact row stored 0 rows, so something other than RLS swallows that row and the refusal in 4 would prove nothing about identity');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL O FAILED: the table OWNER was refused check 4''s exact row (%s: %s) — RLS does not apply to the owner, so a trigger or constraint refuses it and the refusal in 4 would prove nothing about identity', sqlstate, sqlerrm));
  end;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- A. The mirror of 2 — the forgery, signed with the kid's OWN id. Same
  --    columns, same values, `metadata` included: it is the one column no other
  --    write here names, and Postgres checks column privileges against the
  --    column list rather than the values, so naming it is what catches a
  --    column grant narrowed to leave it out.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values (fam, kid_u, 'delete', 'wallet_transactions', '{"note":"written by the child"}'::jsonb);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL A FAILED: the child''s append of the SAME row signed with their OWN id stored 0 rows, so the forgery refusal in 2 would prove nothing about actor_id = auth.uid()');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL A FAILED: the child was refused the SAME row signed with their OWN id (%s: %s). Either the honest append is broken — check 1''s regression: a child can no longer append a row about THEMSELVES — or something else says no to this session: a guard trigger keyed on action/resource/metadata, a revoked or narrowed INSERT grant, a dead auth.uid(). Either way the forgery refusal in 2 proves nothing', sqlstate, sqlerrm));
  end;

  -- B. The mirror of 3 — the platform-feed row with a household instead of
  --    none. Same action, same resource: 'security.alert' on 'platform' is the
  --    shape a future "platform rows are service-role only" trigger would key
  --    on, and that trigger would refuse 3 no matter what the WITH CHECK said.
  --    (A trigger keyed on `family_id is null` itself is leg O's to catch.)
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'security.alert', 'platform');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL B FAILED: the child''s append of the SAME security.alert row with family_id = FA stored 0 rows, so the household-less refusal in 3 would prove nothing about is_family_member(family_id)');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL B FAILED: the child was refused the SAME security.alert row with family_id = FA (%s: %s), so the household-less refusal in 3 would prove only that something refuses this SHAPE of row, not that 0320 dropped the family_id IS NULL branch', sqlstate, sqlerrm));
  end;

  -- D. The mirror of 5 — the same child, the same read, in the family where
  --    they are an ADULT, so `can_manage_family` answers YES and the
  --    parent-only `is_family_admin` answers no. Without this, a child who could
  --    see no audit row at all reports zero exactly as a working read policy does.
  begin
    select count(*) into n from public.audit_logs where family_id = ctl_fam;
    if n = 0 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL D FAILED: this child, an ADULT in the family they manage, READ 0 trail rows there although one was seeded as postgres — so audit_select is not answering can_manage_family (a drift to the parent-only is_family_admin reads exactly this), or this session cannot see a trail row under any predicate; either way the zero-row read in 5 would prove nothing about audit_select');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL D FAILED: this child''s read of the trail in the family where they are an ADULT raised %s: %s, so the zero-row read in 5 would prove nothing about audit_select', sqlstate, sqlerrm));
  end;

  -- C. The mirror of 4 — the PARENT signing for themselves rather than for the
  --    child. One field changed from 4's forgery: actor_id.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, parent_u, 'create', 'allowance');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL C FAILED: the parent''s append of the SAME row signed with their OWN id stored 0 rows, so the refusal in 4 would prove nothing about the pin being identity rather than role');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL C FAILED: the parent was refused the SAME row signed with their OWN id (%s: %s). Either the parent''s honest append is broken — a PARENT could not append a row about themselves — or the parent''s session cannot write at all; either way the refusal in 4 proves nothing about identity', sqlstate, sqlerrm));
  end;
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  -- A failed control makes every refusal below unreadable. Say WHY the probe
  -- cannot speak, here, while the reason is still in hand. The boundary is not
  -- reported as holding and not as broken: it is reported as unproven.
  if not control_ok then
    perform set_config('role','postgres', true);
    raise exception 'audit trail authenticity UNPROVEN (the controls this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  -- 1. Append, as themselves. This has to keep working.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'update', 'chores');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer append a row about THEMSELVES — the trail now has holes where the work is');
  end;

  -- 2. The forgery: the same row, signed with the parent's id.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values (fam, parent_u, 'delete', 'wallet_transactions', '{"note":"written by the child"}'::jsonb);
    failures := array_append(failures, 'a child ATTRIBUTED a wallet deletion to the parent');
  exception when insufficient_privilege then null;
  end;

  -- 3. The platform-feed flood: rows that belong to no household, which no RLS
  --    reader can see and the admin Security page renders with the service client.
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (null, kid_u, 'security.alert', 'platform');
    failures := array_append(failures, 'a child wrote a family_id IS NULL row into the platform security feed');
  exception when insufficient_privilege then null;
  end;

  -- 4. Identity, not role: a parent cannot sign for the child either.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, kid_u, 'create', 'allowance');
    failures := array_append(failures, 'a PARENT attributed an action to the child — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;

  -- The parent's own append still works (the positive control for the fix).
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (fam, parent_u, 'create', 'allowance');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT could not append a row about themselves');
  end;

  -- 5. Reads stay manager-only.
  select count(*) into n from public.audit_logs where family_id = fam;
  if n = 0 then failures := array_append(failures, 'a PARENT cannot read the trail'); end if;
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  select count(*) into n from public.audit_logs where family_id = fam;
  if n <> 0 then failures := array_append(failures, format('a child READ %s trail row(s); audit_select is supposed to be can_manage_family', n)); end if;

  perform set_config('role','postgres', true);

  -- 6. The refusals are the policies this probe names. The controls prove the
  --    rows are acceptable to everything but RLS and that the session can write
  --    and read; this proves WHICH RLS — the header's migration inventory, read
  --    back from the catalog so it cannot go stale behind a grep. A permissive
  --    second INSERT policy would OR straight past the pin; a restrictive one
  --    would refuse 2–4 in its place with the WITH CHECK loosened underneath.
  select count(*) into n from pg_catalog.pg_class c
    where c.oid = 'public.audit_logs'::regclass and c.relrowsecurity;
  if n <> 1 then failures := array_append(failures, 'row level security is not enabled on public.audit_logs (0004/0118 enable it on every base table)'); end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_insert'
      and cmd = 'INSERT' and permissive = 'PERMISSIVE' and roles = '{authenticated}'::name[]
      and with_check ~ '\mis_family_member\(family_id\)'
      and with_check ~ '\mactor_id = auth\.uid\(\)'
      and with_check !~* '\mis null\M';
  if n <> 1 then
    select string_agg(format('%s %s %s to %s check %s', policyname, permissive, cmd, roles, with_check), '; ')
      into pols from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'INSERT';
    failures := array_append(failures, format('audit_insert is not 0320''s `for insert to authenticated with check (is_family_member(family_id) and actor_id = auth.uid())` without a null branch — found: %s — so the refusals in 2–4 are not the pin this probe attributes them to', coalesce(pols, 'no INSERT policy')));
  end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_select'
      and cmd = 'SELECT' and permissive = 'PERMISSIVE'
      and qual ~ '\mcan_manage_family\(family_id\)';
  if n <> 1 then failures := array_append(failures, 'audit_select is no longer `using (can_manage_family(family_id))` (0118:113), so the manager-only read in 5 is not the policy this probe attributes it to'); end if;

  select string_agg(format('%s (%s %s)', policyname, permissive, cmd), ', ' order by policyname)
    into pols from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs'
      and policyname not in ('audit_insert', 'audit_select');
  if pols is not null then failures := array_append(failures, format('audit_logs carries policies no migration in this header''s inventory creates: %s — the attribution of 2–5 to audit_insert/audit_select is out of date', pols)); end if;

  if array_length(failures, 1) is not null then
    raise exception 'audit trail authenticity failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK audit_logs: the controls landed (the owner appends the exact refused rows; the same child appends the same forged row signed with their OWN id and the same platform row with a household, and reads the trail where they are an ADULT; the parent appends as themselves), and given that access a member appends only as themselves, no one signs for anyone else, no household-less rows, reads stay can_manage_family-only, and pg_policies holds exactly 0320''s audit_insert and 0118''s audit_select';
end $$;

rollback;
