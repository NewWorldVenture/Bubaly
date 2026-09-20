-- ── O-01 The family password vault is not a child's to change ───────────────
--
-- `family_credentials` holds the "Wi-Fi & Passwords" vault. Its category check
-- allows 'card' and 'pin', so the table is designed for bank card numbers and
-- PINs, and `secret` is plain text rather than one of this schema's `_enc`
-- columns.
--
-- Before 0297 every policy on it was `is_family_member(family_id)`, so a member
-- with role 'child' could read the stored PIN, change it, and delete the row —
-- and the module in front of it (components/modules/passwords-module.tsx) has
-- no role check at all and writes with the caller's own client, so RLS was the
-- only boundary that ever existed.
--
-- Proves the write half behaviourally, in both directions, and proves the read
-- half is still OPEN so the finding's remaining part cannot be quietly lost:
--
--   1. a child cannot INSERT, UPDATE or DELETE a credential;
--   2. a parent still can (a guard that refuses everyone is not a boundary);
--   3. a child CAN still read — recorded, not asserted as correct, because
--      'wifi' is a category and which entries are family-wide is a product
--      decision (O-02);
--   4. the three write policies carry the SAME condition, so tightening one
--      and forgetting another fails here rather than in production.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/family-credential-write-boundary-check.sql

\set FV '00000000-0000-4000-8000-0000000000e1'
\set UP '00000000-0000-4000-8000-0000000000e2'
\set UC '00000000-0000-4000-8000-0000000000e3'

begin;

insert into auth.users (id, email) values (:'UP','e-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UC','e-child@example.com')  on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FV','Vault House',:'UP') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FV',:'UP','Parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FV',:'UC','Kid','child',true) on conflict do nothing;
insert into public.family_credentials (id, family_id, category, label, username, secret, created_by)
  values ('00000000-0000-4000-8000-0000000000e4', :'FV','card','Family Debit Card','4242 4242 4242 4242','PIN 9317',:'UP');

grant select, insert, update, delete on public.family_credentials to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam constant uuid := '00000000-0000-4000-8000-0000000000e1';
  row_id constant uuid := '00000000-0000-4000-8000-0000000000e4';
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  begin
    insert into public.family_credentials (family_id, category, label, secret, created_by)
      values (fam,'pin','Planted by the child','0000','00000000-0000-4000-8000-0000000000e3');
    failures := array_append(failures, 'a child INSERTED a credential');
  exception when insufficient_privilege then null;
  end;

  update public.family_credentials set secret = 'changed-by-the-child' where id = row_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child UPDATED %s credential row(s)', n)); end if;

  delete from public.family_credentials where id = row_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s credential row(s)', n)); end if;

  -- O-02 IS NOW CLOSED, and this line is the record of the moment it closed.
  --
  -- It used to say the opposite: the read half was open, a child could still SEE
  -- the family's stored passwords and card PINs, and this probe asserted that
  -- state so a half-fixed finding could not read as fixed. It failed on the
  -- merge with main — which is exactly what it was written to do —
  -- because main's `0296_family_credentials_manager_only.sql` closed the read
  -- side as well as the write side, going further than the audit branch's own
  -- `family_credentials` migration, which is why that one was dropped rather
  -- than renumbered.
  --
  -- The assertion is inverted rather than deleted: a child must NOT be able to
  -- read a credential, and if that ever regresses this line fails again.
  select count(*) into n from public.family_credentials where id = row_id;
  if n <> 0 then
    failures := array_append(failures, format('a child READ %s credential row(s) — O-02 has regressed; the vault holds passwords and card PINs', n));
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e2', true);
  update public.family_credentials set secret = 'rotated-by-the-parent' where id = row_id;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a PARENT could not update the vault — the guard refuses everyone'); end if;

  begin
    insert into public.family_credentials (family_id, category, label, secret, created_by)
      values (fam,'wifi','Guest network','letmein','00000000-0000-4000-8000-0000000000e2');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT could not add a credential');
  end;

  perform set_config('role','postgres', true);

  -- ── The three write verbs must carry ONE condition ──────────────────────
  select count(distinct expr) into n from (
    select coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) as expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'family_credentials' and p.polcmd in ('a','w','d')
  ) e;
  if n <> 1 then
    failures := array_append(failures, format('the three write policies carry %s different conditions; tightening one and forgetting another is how this started', n));
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'family credential write boundary failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK family credentials: a child can neither write nor read the vault, and a parent can (O-02 closed by main 0296)';
end $$;

rollback;
