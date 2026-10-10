-- a-parent-is-made-unmade-and-invited-only-by-a-parent-check.sql
-- ----------------------------------------------------------------------------
-- Probes for 0482_who_may_make_unmake_and_invite_a_parent: each forbidden write
-- the family-membership audit found open (an adult making or unmaking a parent,
-- moving a member between families, issuing or re-wording a parent invite,
-- forging an invite's terms, resurrecting a revoked invite, a removed child-login
-- founding a family, a family losing its last parent) is REFUSED by 0482's own
-- guards, and every write the app needs still lands with the state it expects.
--
-- accept_invite is not probed here: 0482 leaves 0136's function as it is, since
-- a returning member's role is the held 0495's to fix and its negative control
-- (.github/workflows/invite-rejoin-role-runtime.yml) needs the released schema
-- to still show that defect.
--
-- Runs as a superuser against a THROWAWAY database replayed from
-- supabase/migrations (docs/audit/pg-bootstrap.sh). Everything happens in one
-- transaction that is rolled back; each probe also runs in its own
-- subtransaction that is rolled back, so probes do not see each other.
--
-- Every probe is executed as the role PostgREST would use (authenticated with
-- request.jwt.claims, or service_role), then deferred constraint triggers are
-- fired (SET CONSTRAINTS ALL IMMEDIATE) so 0299's commit-time check is part of
-- the outcome. Outcome is ALLOWED (with rows affected and a state check),
-- NO-OP (RLS filtered every row) or REFUSED <sqlstate>.
--
-- `expect` is what 0482 produces. On a database replayed through 0476 every
-- forbidden probe came back ALLOWED (that was the gap); the verdict at the end
-- fails the probe unless each forbidden write is refused with 42501 or 23514
-- and each allowed one lands with the state named.
--
--   psql -v ON_ERROR_STOP=1 -f docs/audit/a-parent-is-made-unmade-and-invited-only-by-a-parent-check.sql

\set QUIET on
\pset pager off
begin;

create temp table probe_result (n serial, name text, kind text, expect text, outcome text, state text);

create function pg_temp.probe(p_name text, p_kind text, p_expect text,
                              p_claims jsonb, p_sql text, p_check text default null)
returns void language plpgsql as $$
declare
  v_rows bigint; v_state text; v_msg text; v_det text; v_code text;
begin
  begin
    if p_claims is null then
      perform set_config('request.jwt.claims', '', true);
      execute 'set local role service_role';
    else
      perform set_config('request.jwt.claims', p_claims::text, true);
      execute 'set local role authenticated';
    end if;
    execute p_sql;
    get diagnostics v_rows = row_count;
    execute 'set constraints all immediate';
    execute 'set constraints all deferred';
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    if p_check is not null then execute p_check into v_state; end if;
    raise exception using message = 'PROBE_OK', detail = v_rows::text || '|' || coalesce(v_state, '');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_code = returned_sqlstate;
    if v_msg = 'PROBE_OK' then
      v_rows := split_part(v_det, '|', 1)::bigint;
      v_state := nullif(substr(v_det, length(split_part(v_det, '|', 1)) + 2), '');
      insert into probe_result (name, kind, expect, outcome, state)
      values (p_name, p_kind, p_expect,
              case when v_rows = 0 and p_sql !~* '^\s*select' then 'NO-OP (0 rows)'
                   else 'ALLOWED (' || v_rows || ' row)' end,
              v_state);
    else
      insert into probe_result (name, kind, expect, outcome, state)
      values (p_name, p_kind, p_expect, 'REFUSED ' || v_code || ': ' || left(v_msg, 90), null);
    end if;
  end;
end $$;

create function pg_temp.who(p uuid, p_email text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('sub', p, 'role', 'authenticated', 'email', p_email))
$$;

-- ── fixtures (as postgres, so every guard is bypassed) ───────────────────────
insert into auth.users (id, email) values
  ('0482000a-0000-4000-8000-000000000001', 'p1@probe.test'),
  ('0482000a-0000-4000-8000-000000000002', 'a1@probe.test'),
  ('0482000a-0000-4000-8000-000000000003', 'g@probe.test'),
  ('0482000a-0000-4000-8000-000000000004', 'a2@probe.test'),
  ('0482000a-0000-4000-8000-000000000005', 'new@probe.test'),
  ('0482000a-0000-4000-8000-000000000006', 'child.kidd@kids.bubaly.app'),
  ('0482000a-0000-4000-8000-000000000007', 'outsider@probe.test'),
  ('0482000a-0000-4000-8000-000000000008', 'p3@probe.test'),
  ('0482000a-0000-4000-8000-000000000009', 'a3@probe.test'),
  ('0482000a-0000-4000-8000-00000000000a', 'p4@probe.test'),
  ('0482000a-0000-4000-8000-00000000000b', 'p5@probe.test'),
  ('0482000a-0000-4000-8000-00000000000c', 't1@probe.test')
on conflict do nothing;

insert into public.families (id, name) values
  ('0482000f-0000-4000-8000-00000000000a', 'Probe A'),
  ('0482000f-0000-4000-8000-00000000000b', 'Probe B'),
  ('0482000f-0000-4000-8000-00000000000c', 'Probe C'),
  ('0482000f-0000-4000-8000-00000000000d', 'Probe D');

insert into public.family_members (id, family_id, user_id, role, display_name, is_active) values
  -- family A: parent P1, adult A1, child C1 (no login), removed adult G,
  -- removed adult A2, removed child K (has a child login), teen T1 with a
  -- calendar sync
  ('0482000b-0000-4000-8000-0000000000a1', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-000000000001', 'parent', 'P1', true),
  ('0482000b-0000-4000-8000-0000000000a2', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-000000000002', 'adult',  'A1', true),
  ('0482000b-0000-4000-8000-0000000000a3', '0482000f-0000-4000-8000-00000000000a', null,                                   'child',  'C1', true),
  ('0482000b-0000-4000-8000-0000000000a4', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-000000000003', 'adult',  'G (removed)', false),
  ('0482000b-0000-4000-8000-0000000000a5', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-000000000004', 'adult',  'A2 (removed)', false),
  ('0482000b-0000-4000-8000-0000000000a6', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-000000000006', 'child',  'K (removed)', false),
  ('0482000b-0000-4000-8000-0000000000a7', '0482000f-0000-4000-8000-00000000000a', '0482000a-0000-4000-8000-00000000000c', 'teen',   'T1', true),
  -- family B: A1 is its parent (so A1 manages both A and B)
  ('0482000b-0000-4000-8000-0000000000b1', '0482000f-0000-4000-8000-00000000000b', '0482000a-0000-4000-8000-000000000002', 'parent', 'A1 in B', true),
  -- family C: sole parent P3, adult A3
  ('0482000b-0000-4000-8000-0000000000c1', '0482000f-0000-4000-8000-00000000000c', '0482000a-0000-4000-8000-000000000008', 'parent', 'P3', true),
  ('0482000b-0000-4000-8000-0000000000c2', '0482000f-0000-4000-8000-00000000000c', '0482000a-0000-4000-8000-000000000009', 'adult',  'A3', true),
  -- family D: two parents
  ('0482000b-0000-4000-8000-0000000000d1', '0482000f-0000-4000-8000-00000000000d', '0482000a-0000-4000-8000-00000000000a', 'parent', 'P4', true),
  ('0482000b-0000-4000-8000-0000000000d2', '0482000f-0000-4000-8000-00000000000d', '0482000a-0000-4000-8000-00000000000b', 'parent', 'P5', true);

insert into public.child_logins (family_id, member_id, user_id, username) values
  ('0482000f-0000-4000-8000-00000000000a', '0482000b-0000-4000-8000-0000000000a6', '0482000a-0000-4000-8000-000000000006', 'kidd');

insert into public.invites (id, family_id, email, role, token, status, invited_by) values
  ('0482000c-0000-4000-8000-000000000001', '0482000f-0000-4000-8000-00000000000a', 'g@probe.test',   'guest', 'tok-guest-reinvite', 'pending', '0482000a-0000-4000-8000-000000000001'),
  ('0482000c-0000-4000-8000-000000000004', '0482000f-0000-4000-8000-00000000000a', 'x@probe.test',   'adult', 'tok-revoked',        'revoked', '0482000a-0000-4000-8000-000000000001'),
  ('0482000c-0000-4000-8000-000000000005', '0482000f-0000-4000-8000-00000000000a', 'y@probe.test',   'adult', 'tok-pending',        'pending', '0482000a-0000-4000-8000-000000000001');

insert into public.sync_accounts (id, user_id, family_id, provider, external_id, sync_status) values
  ('0482000d-0000-4000-8000-000000000001', '0482000a-0000-4000-8000-00000000000c', '0482000f-0000-4000-8000-00000000000a', 'google', 't1@gmail', 'synced');
insert into public.sync_tokens (account_id, user_id, family_id, provider, access_token_enc, refresh_token_enc) values
  ('0482000d-0000-4000-8000-000000000001', '0482000a-0000-4000-8000-00000000000c', '0482000f-0000-4000-8000-00000000000a', 'google', 'enc-access', 'enc-refresh');
insert into public.sync_connections (account_id, user_id, family_id, provider, sync_status) values
  ('0482000d-0000-4000-8000-000000000001', '0482000a-0000-4000-8000-00000000000c', '0482000f-0000-4000-8000-00000000000a', 'google', 'synced');

set constraints all immediate;
set constraints all deferred;

\o /dev/null
-- ── control: RLS is live (an outsider's write matches no row) ───────────────
select pg_temp.probe('X01 control: outsider promotes a member of family A', 'control', 'NO-OP',
  pg_temp.who('0482000a-0000-4000-8000-000000000007'),
  $q$update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000a2'$q$);

-- ── A. family_members ────────────────────────────────────────────────────────
select pg_temp.probe('A01 adult self-promotes to parent', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000a2'$q$,
  $q$select role::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000a2'$q$);

select pg_temp.probe('A02 parent promotes an adult to parent', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000001'),
  $q$update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000a2'$q$,
  $q$select role::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000a2'$q$);

select pg_temp.probe('A03 adult demotes a parent', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set role = 'adult' where id = '0482000b-0000-4000-8000-0000000000a1'$q$,
  $q$select role::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000a1'$q$);

select pg_temp.probe('A04 adult deactivates a parent', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set is_active = false where id = '0482000b-0000-4000-8000-0000000000a1'$q$,
  $q$select is_active::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000a1'$q$);

select pg_temp.probe('A05 adult deletes a parent', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$delete from public.family_members where id = '0482000b-0000-4000-8000-0000000000a1'$q$,
  $q$select count(*)::text || ' parent rows left' from public.family_members where id = '0482000b-0000-4000-8000-0000000000a1'$q$);

select pg_temp.probe('A06 adult renames a parent (not a role change)', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set display_name = 'P1 renamed' where id = '0482000b-0000-4000-8000-0000000000a1'$q$,
  $q$select display_name from public.family_members where id = '0482000b-0000-4000-8000-0000000000a1'$q$);

select pg_temp.probe('A07 manager moves a member to another family (family_id)', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set family_id = '0482000f-0000-4000-8000-00000000000b' where id = '0482000b-0000-4000-8000-0000000000a3'$q$,
  $q$select family_id::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000a3'$q$);

select pg_temp.probe('A08 adult inserts a parent member row', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$insert into public.family_members (family_id, role, display_name) values ('0482000f-0000-4000-8000-00000000000a', 'parent', 'Fake parent')$q$);

select pg_temp.probe('A09 adult inserts a child member row', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$insert into public.family_members (family_id, role, display_name) values ('0482000f-0000-4000-8000-00000000000a', 'child', 'New kid')$q$);

select pg_temp.probe('A10 adult removes a child', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.family_members set is_active = false where id = '0482000b-0000-4000-8000-0000000000a3'$q$);

-- ── A. last parent ───────────────────────────────────────────────────────────
select pg_temp.probe('L01 sole parent demotes self (an adult remains)', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000008'),
  $q$update public.family_members set role = 'adult' where id = '0482000b-0000-4000-8000-0000000000c1'$q$,
  $q$select role::text from public.family_members where id = '0482000b-0000-4000-8000-0000000000c1'$q$);

select pg_temp.probe('L02 sole parent deactivates self (an adult remains)', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000008'),
  $q$update public.family_members set is_active = false where id = '0482000b-0000-4000-8000-0000000000c1'$q$);

select pg_temp.probe('L03 service_role demotes the sole parent', 'forbidden', 'REFUSED',
  null,
  $q$update public.family_members set role = 'adult' where id = '0482000b-0000-4000-8000-0000000000c1'$q$);

select pg_temp.probe('L04 parent demotes a co-parent (one parent remains)', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-00000000000a'),
  $q$update public.family_members set role = 'adult' where id = '0482000b-0000-4000-8000-0000000000d2'$q$);

select pg_temp.probe('L05 sole parent hands over: promote the adult, then demote self', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000008'),
  $q$update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000c2';
     update public.family_members set role = 'adult'  where id = '0482000b-0000-4000-8000-0000000000c1'$q$,
  $q$select string_agg(display_name || '=' || role, ',' order by display_name) from public.family_members where family_id = '0482000f-0000-4000-8000-00000000000c'$q$);

select pg_temp.probe('L05b demote self first, then try to promote (no longer a parent)', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000008'),
  $q$update public.family_members set role = 'adult'  where id = '0482000b-0000-4000-8000-0000000000c1';
     update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000c2'$q$,
  $q$select string_agg(display_name || '=' || role, ',' order by display_name) from public.family_members where family_id = '0482000f-0000-4000-8000-00000000000c'$q$);

select pg_temp.probe('L06 service_role tears down a whole family roster', 'allowed', 'ALLOWED',
  null,
  $q$delete from public.family_members where family_id = '0482000f-0000-4000-8000-00000000000c'$q$);

-- ── B. invites ───────────────────────────────────────────────────────────────
select pg_temp.probe('B01 adult inserts a parent invite', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$insert into public.invites (family_id, email, role, invited_by) values ('0482000f-0000-4000-8000-00000000000a', 'mine2@probe.test', 'parent', '0482000a-0000-4000-8000-000000000002')$q$);

select pg_temp.probe('B02 adult inserts an adult invite with forged terms', 'allowed (terms forced)', 'ALLOWED; status=pending, invited_by=A1, token<>chosen, expiry<=14d',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$insert into public.invites (family_id, email, role, invited_by, status, token, expires_at)
     values ('0482000f-0000-4000-8000-00000000000a', 'friend@probe.test', 'adult', '0482000a-0000-4000-8000-000000000001', 'accepted', 'chosen-token', now() + interval '365 days')$q$,
  $q$select 'status=' || status || ', invited_by=' || case invited_by when '0482000a-0000-4000-8000-000000000002' then 'A1' when '0482000a-0000-4000-8000-000000000001' then 'P1' else coalesce(invited_by::text,'null') end
           || ', token=' || case when token = 'chosen-token' then 'chosen' else 'generated(' || length(token) || ')' end
           || ', expiry=' || round(extract(epoch from expires_at - now()) / 86400) || 'd'
       from public.invites where email = 'friend@probe.test'$q$);

select pg_temp.probe('B03 parent inserts a parent invite', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000001'),
  $q$insert into public.invites (family_id, email, role, invited_by) values ('0482000f-0000-4000-8000-00000000000a', 'coparent@probe.test', 'parent', '0482000a-0000-4000-8000-000000000001')$q$);

select pg_temp.probe('B04 adult rewrites a pending guest invite to parent', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.invites set role = 'parent' where id = '0482000c-0000-4000-8000-000000000001'$q$,
  $q$select role::text from public.invites where id = '0482000c-0000-4000-8000-000000000001'$q$);

select pg_temp.probe('B05 adult resurrects a revoked invite', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.invites set status = 'pending' where id = '0482000c-0000-4000-8000-000000000004'$q$,
  $q$select status::text from public.invites where id = '0482000c-0000-4000-8000-000000000004'$q$);

select pg_temp.probe('B06 adult extends a pending invite by a year', 'allowed (clamped)', 'ALLOWED; expiry<=14d',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.invites set expires_at = now() + interval '365 days' where id = '0482000c-0000-4000-8000-000000000005'$q$,
  $q$select 'expiry=' || round(extract(epoch from expires_at - now()) / 86400) || 'd' from public.invites where id = '0482000c-0000-4000-8000-000000000005'$q$);

select pg_temp.probe('B07 adult revokes a pending invite', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000002'),
  $q$update public.invites set status = 'revoked' where id = '0482000c-0000-4000-8000-000000000005'$q$,
  $q$select status::text from public.invites where id = '0482000c-0000-4000-8000-000000000005'$q$);

-- ── D. removed child / removed member ────────────────────────────────────────
select pg_temp.probe('D01 removed child-login account founds a family', 'forbidden', 'REFUSED',
  pg_temp.who('0482000a-0000-4000-8000-000000000006', 'child.kidd@kids.bubaly.app'),
  $q$insert into public.families (name, created_by) values ('Kid HQ', '0482000a-0000-4000-8000-000000000006')$q$,
  $q$select coalesce(string_agg(role::text, ','), 'none') from public.family_members m join public.families f on f.id = m.family_id where f.name = 'Kid HQ'$q$);

select pg_temp.probe('D02 ordinary account founds a family', 'allowed', 'ALLOWED',
  pg_temp.who('0482000a-0000-4000-8000-000000000007', 'outsider@probe.test'),
  $q$insert into public.families (name, created_by) values ('Outsider HQ', '0482000a-0000-4000-8000-000000000007')$q$,
  $q$select string_agg(role::text, ',') from public.family_members m join public.families f on f.id = m.family_id where f.name = 'Outsider HQ'$q$);

select pg_temp.probe('D03 parent removes a teen who syncs a calendar', 'outcome', 'ALLOWED; sync rows disabled, tokens cleared',
  pg_temp.who('0482000a-0000-4000-8000-000000000001'),
  $q$update public.family_members set is_active = false where id = '0482000b-0000-4000-8000-0000000000a7'$q$,
  $q$select 'account=' || (select sync_status from public.sync_accounts where id = '0482000d-0000-4000-8000-000000000001')
          || ', connection=' || (select string_agg(sync_status::text, ',') from public.sync_connections where account_id = '0482000d-0000-4000-8000-000000000001')
          || ', token=' || (select sync_status || '/' || case when access_token_enc is null and refresh_token_enc is null then 'cleared' else 'present' end from public.sync_tokens where account_id = '0482000d-0000-4000-8000-000000000001')$q$);

-- ── service_role is unchanged ────────────────────────────────────────────────
select pg_temp.probe('S01 service_role promotes an adult to parent', 'allowed', 'ALLOWED',
  null,
  $q$update public.family_members set role = 'parent' where id = '0482000b-0000-4000-8000-0000000000a2'$q$);

select pg_temp.probe('S02 service_role moves a member to another family', 'allowed', 'ALLOWED',
  null,
  $q$update public.family_members set family_id = '0482000f-0000-4000-8000-00000000000b' where id = '0482000b-0000-4000-8000-0000000000a3'$q$);

select pg_temp.probe('S03 service_role removes a parent where another parent remains', 'allowed', 'ALLOWED',
  null,
  $q$update public.family_members set is_active = false where id = '0482000b-0000-4000-8000-0000000000d2'$q$);

select pg_temp.probe('S04 service_role writes an invite with its own terms', 'allowed', 'ALLOWED; token/expiry kept',
  null,
  $q$insert into public.invites (family_id, email, role, token, status, expires_at) values ('0482000f-0000-4000-8000-00000000000a', 'svc@probe.test', 'parent', 'svc-token', 'pending', now() + interval '30 days')$q$,
  $q$select 'token=' || token || ', expiry=' || round(extract(epoch from expires_at - now()) / 86400) || 'd' from public.invites where email = 'svc@probe.test'$q$);

select pg_temp.probe('S05 service_role revokes an invite', 'allowed', 'ALLOWED',
  null,
  $q$update public.invites set status = 'revoked' where id = '0482000c-0000-4000-8000-000000000001'$q$);

\o
\pset format aligned
\pset border 1
select n, name, kind, expect, outcome, state from probe_result order by n;

select
  count(*) filter (where kind = 'forbidden' and outcome like 'ALLOWED%')  as forbidden_allowed,
  count(*) filter (where kind = 'forbidden' and outcome like 'REFUSED%')  as forbidden_refused,
  count(*) filter (where kind not in ('forbidden','control') and outcome like 'ALLOWED%') as others_allowed,
  count(*) filter (where kind not in ('forbidden','control') and outcome not like 'ALLOWED%') as others_not_allowed,
  count(*) filter (where kind = 'control' and outcome like 'NO-OP%') as controls_held
from probe_result;

-- ── verdict ──────────────────────────────────────────────────────────────────
-- A forbidden write must be refused by 0482's own guards: 42501 from a guard
-- trigger or a policy WITH CHECK, 23514 from trg_family_keeps_a_manager. Any
-- other error (42703 absent column, 42P01 missing table, 23503 FK) is a broken
-- fixture, not a boundary, and fails here. An allowed or outcome write must land
-- and leave the state its `expect` names; the control must be filtered to no
-- row (RLS is live, so a refusal above is the guard and not invisibility).
do $verdict$
declare
  r record;
  bad text := '';
  n int := 0;
  -- A refused write records no state (its subtransaction is gone); these are
  -- the writes that land, and the state each must leave behind.
  expected_state constant jsonb := jsonb_build_object(
    'A02 parent promotes an adult to parent', 'parent',
    'A06 adult renames a parent (not a role change)', 'P1 renamed',
    'L05 sole parent hands over: promote the adult, then demote self', 'A3=parent,P3=adult',
    'B02 adult inserts an adult invite with forged terms', 'status=pending, invited_by=A1, token=generated(48), expiry=14d',
    'B06 adult extends a pending invite by a year', 'expiry=14d',
    'B07 adult revokes a pending invite', 'revoked',
    'D02 ordinary account founds a family', 'parent',
    'D03 parent removes a teen who syncs a calendar', 'account=disabled, connection=disabled, token=disabled/cleared',
    'S04 service_role writes an invite with its own terms', 'token=svc-token, expiry=30d');
begin
  for r in select * from probe_result order by n loop
    n := n + 1;
    if r.kind = 'forbidden' then
      if r.outcome !~ '^REFUSED (42501|23514):' then
        bad := bad || format(E'\n  - %s: expected a 42501/23514 refusal, got %s', r.name, r.outcome);
      end if;
    elsif r.kind = 'control' then
      if r.outcome !~ '^NO-OP' then
        bad := bad || format(E'\n  - %s: the control must be filtered to no row, got %s', r.name, r.outcome);
      end if;
    elsif r.outcome !~ '^ALLOWED' then
      bad := bad || format(E'\n  - %s: expected the write to land, got %s', r.name, r.outcome);
    end if;
    if expected_state ? r.name and r.state is distinct from (expected_state ->> r.name) then
      bad := bad || format(E'\n  - %s: expected state %L, got %L', r.name, expected_state ->> r.name, r.state);
    end if;
  end loop;
  if n <> 33 then
    bad := bad || format(E'\n  - %s probes ran, 33 expected', n);
  end if;
  if (select count(*) from probe_result where kind = 'forbidden') <> 14 then
    bad := bad || format(E'\n  - %s forbidden probes ran, 14 expected', (select count(*) from probe_result where kind = 'forbidden'));
  end if;
  if bad <> '' then
    raise exception '0482 FAILED (who may make, unmake and invite a parent):%', bad;
  end if;
  raise notice '0482 OK: all 14 forbidden writes refused by 42501/23514, 18 allowed writes landed with the state expected, and the outsider control was filtered to no row';
end
$verdict$;

rollback;
