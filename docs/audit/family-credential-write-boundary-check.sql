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
-- The rule under test is `0296_family_credentials_manager_only.sql` — NOT
-- 0119, which created the table with `is_family_member(family_id)` on all four
-- policies. 0296 replaced that predicate with `can_manage_family(family_id)`
-- (0003: `role in ('parent','adult') and is_active`) on all four, and nothing
-- since touches the table: 0297 and 0310 mention "credential" only in prose.
-- So the ONLY difference between a refusal and a success here is the role
-- clause, and this probe has to show that that is the clause that fired.
--
-- Proves the write half behaviourally, in both directions, and ATTRIBUTES the
-- refusal to 0296 rather than to the session being nobody:
--
--   1. a child cannot INSERT, UPDATE or DELETE a credential;
--   2. a parent still can (a guard that refuses everyone is not a boundary);
--   3. a child cannot READ one either — 0296 closed the read side as well, and
--      the assertion below is the record of the moment O-02 closed;
--   4. the three write policies carry the SAME condition, so tightening one
--      and forgetting another fails here rather than in production;
--   5. CONTROL, before the first assertion: this session really IS the child —
--      auth.uid() is the child's, `is_family_member(family)` is TRUE and
--      `can_manage_family(family)` is FALSE — so the actor has everything the
--      four policies need EXCEPT the role;
--   6. NEGATIVE CONTROL, at the end: put 0119's own predicate back on all four
--      policies — the exact pre-0296 state — and require this SAME child, on
--      this SAME table, through those SAME four policies, to read, INSERT,
--      UPDATE and DELETE — and it runs UPDATE and DELETE against `row_id`, the
--      PARENT-created card the assertions in 1 actually targeted, not only
--      against a row the child filed itself, so a guard that refuses a child
--      merely on someone else's row cannot be credited to 0296. The rows it
--      disturbs it puts back, the family's credential count is compared across
--      the whole control, and the four policies it found are compared with the
--      four it leaves, so the fixture and the catalog are as it found them.
--
-- Why 5 and 6 exist. Every refusal in 1 and 3 is either `insufficient_privilege`
-- or zero rows, and BOTH arrive identically whether can_manage_family said "not
-- a manager" or the session was simply not a member of this family at all — a
-- missing GRANT, a null auth.uid() and a deleted family_members row all land on
-- the same SQLSTATE. Measured on a replayed database with every migration
-- applied: point the child's `sub` at a uuid belonging to nobody, or delete the
-- child's `family_members` row, and every assertion in this file still passed
-- and it still printed OK. The parent's positive control does not close that —
-- it proves the PARENT's session works, and says nothing about the child's.
-- That is the document-vault trap: a probe whose subject could not have written
-- anything either way.
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
  kid_u constant uuid := '00000000-0000-4000-8000-0000000000e3';
  mem boolean;
  mgr boolean;
  planted uuid;
  fixture_n int;
  policy_n int;
  loose int;
  rls_on boolean;
  par_u constant uuid := '00000000-0000-4000-8000-0000000000e2';
  pre_state text[];
  post_state text[];
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── CONTROL: the actor has everything except the role ───────────────────
  -- Checked here, before the first refusal, so a broken fixture is reported as
  -- a broken fixture rather than banked as a boundary holding.
  if auth.uid() is distinct from kid_u then
    failures := array_append(failures, format(
      'CONTROL FAILED: auth.uid() is %s, not the child — the session never switched, so every refusal below is a refusal of NOBODY and none of it is about 0296',
      coalesce(auth.uid()::text, 'null')));
  end if;

  -- Ground truth first, out of the table the two predicates read, so the
  -- control does not rest on is_family_member being honest about itself: this
  -- user IS an active member of THIS family and their role IS 'child'.
  select count(*) into n from public.family_members
   where family_id = fam and user_id = kid_u and role = 'child' and is_active;
  if n <> 1 then
    failures := array_append(failures, format(
      'CONTROL FAILED: family_members holds %s active ''child'' row(s) for this user in this family, not 1 — the subject of every refusal below is not the child this probe claims to be testing', n));
  end if;

  mem := public.is_family_member(fam);
  mgr := public.can_manage_family(fam);
  if not mem then
    failures := array_append(failures,
      'CONTROL FAILED: the child is not an active member of this family, so can_manage_family refuses them for being a STRANGER and not for being a child — nothing below is attributable to 0296');
  end if;
  if mgr then
    failures := array_append(failures,
      'CONTROL FAILED: can_manage_family already says this session may manage the family, so the fixture is not a child and the refusals below are not the ones this probe claims');
  end if;

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

  -- ── NEGATIVE CONTROL: the same child, the same table, 0119's predicate ───
  -- The control above proves the actor was a member; this proves the POLICIES
  -- are what refused them. Restore the four policies 0296 replaced, exactly as
  -- 0119 wrote them — the precise pre-0296 state — and require this same child
  -- to get all four verbs through. If any still fails, the refusals above were
  -- caused by something this probe does not name (a revoked GRANT, a
  -- restrictive policy added elsewhere, RLS forced) and crediting them to 0296
  -- would be a guess. The outer rollback undoes this along with everything else.
  select count(*) into fixture_n from public.family_credentials where family_id = fam;
  -- What the control found, so it can be made to prove it put that back. The
  -- restore below writes 0296's four policies literally; if a later migration
  -- ever tightens this table, that restore would silently install the LOOSER
  -- 0296 policies over it. Comparing against what was captured here turns that
  -- into a failure the next maintainer reads, rather than a quiet loosening.
  select array_agg(p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|' ||
                   coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' ||
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|' || p.polroles::text
                   order by p.polname)
    into pre_state
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'family_credentials';

  drop policy if exists family_credentials_select on public.family_credentials;
  create policy family_credentials_select on public.family_credentials
    for select using (public.is_family_member(family_id));
  drop policy if exists family_credentials_insert on public.family_credentials;
  create policy family_credentials_insert on public.family_credentials
    for insert with check (public.is_family_member(family_id));
  drop policy if exists family_credentials_update on public.family_credentials;
  create policy family_credentials_update on public.family_credentials
    for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
  drop policy if exists family_credentials_delete on public.family_credentials;
  create policy family_credentials_delete on public.family_credentials
    for delete using (public.is_family_member(family_id));

  -- Read the restored state out of the CATALOG rather than trusting the four
  -- statements above: a control that succeeded because RLS was off, or because
  -- some policy here reads `true`, is a control that cannot fail.
  select count(*), count(*) filter (where
           coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
             <> 'is_family_member(family_id)')
    into policy_n, loose
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'family_credentials';
  if policy_n <> 4 or loose <> 0 then
    failures := array_append(failures, format(
      'CONTROL FAILED: after restoring 0119 the table carries %s policies of which %s do not read is_family_member(family_id) — the control below would not be measuring the role clause',
      policy_n, loose));
  end if;
  select relrowsecurity into rls_on from pg_class where oid = 'public.family_credentials'::regclass;
  if not rls_on then
    failures := array_append(failures,
      'CONTROL FAILED: row level security is OFF on family_credentials, so the control below would succeed with no policy consulted at all — and so would a child in production');
  end if;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3', true);

  select count(*) into n from public.family_credentials where id = row_id;
  if n <> 1 then
    failures := array_append(failures,
      'CONTROL FAILED: with 0119''s is_family_member predicate restored the child STILL could not READ the vault row, so the read refusal above was not 0296''s doing');
  end if;

  begin
    insert into public.family_credentials (family_id, category, label, secret, created_by)
      values (fam,'pin','Negative control','0000','00000000-0000-4000-8000-0000000000e3')
      returning id into planted;
  exception when insufficient_privilege then
    failures := array_append(failures,
      'CONTROL FAILED: with 0119''s is_family_member predicate restored the child was STILL refused an ordinary INSERT (permission denied for table family_credentials), so the INSERT refusal above proves nothing about the vault');
  end;

  if planted is not null then
    update public.family_credentials set secret = 'rotated-by-the-control' where id = planted;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format(
        'CONTROL FAILED: with is_family_member restored the child UPDATED %s row(s) of a credential they had just filed themselves, so the UPDATE refusal above is unattributed', n));
    end if;

    -- The control removes the row it filed. The count below is compared with
    -- the one taken before the control, so a control that quietly left a row
    -- behind would trade one unattributed check for one false failure.
    delete from public.family_credentials where id = planted;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format(
        'CONTROL FAILED: with is_family_member restored the child DELETED %s row(s) of a credential they had just filed themselves, so the DELETE refusal above is unattributed', n));
    end if;
  end if;

  -- Both checks above exercise a row the child FILED THEMSELVES. The boundary's
  -- UPDATE and DELETE assertions target `row_id` — the card the PARENT created.
  -- Anything that refuses a child only on somebody ELSE's row — a BEFORE
  -- UPDATE/DELETE trigger, a rule, an ownership guard in a later migration —
  -- would leave those two assertions refusing for a reason that is not 0296,
  -- and a control that only ever touches the child's own row cannot see it.
  -- Measured on the replayed database: add a trigger returning null when
  -- `old.created_by is distinct from auth.uid()` and, with 0296 fully reverted
  -- to 0119, the child STILL touches 0 rows of `row_id` — while this probe
  -- printed OK. That is the family_keeps_a_manager() shape the audit already
  -- hit once. So the control repeats both verbs on THAT row.
  update public.family_credentials set secret = 'rotated-by-the-control' where id = row_id;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format(
      'CONTROL FAILED: with 0119''s is_family_member predicate restored the child UPDATED %s row(s) of the very credential the UPDATE assertion above targeted, so that refusal is not 0296''s role clause but something that refuses a child on another member''s row', n));
  end if;

  delete from public.family_credentials where id = row_id;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format(
      'CONTROL FAILED: with 0119''s is_family_member predicate restored the child DELETED %s row(s) of the very credential the DELETE assertion above targeted, so that refusal is not 0296''s role clause but something that refuses a child on another member''s row', n));
  end if;

  -- Put 0296 back before anything else runs, so an assertion added after this
  -- one is not quietly measured against the loosened policies.
  perform set_config('role','postgres', true);
  drop policy if exists family_credentials_select on public.family_credentials;
  create policy family_credentials_select on public.family_credentials
    for select using (public.can_manage_family(family_id));
  drop policy if exists family_credentials_insert on public.family_credentials;
  create policy family_credentials_insert on public.family_credentials
    for insert with check (public.can_manage_family(family_id));
  drop policy if exists family_credentials_update on public.family_credentials;
  create policy family_credentials_update on public.family_credentials
    for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
  drop policy if exists family_credentials_delete on public.family_credentials;
  create policy family_credentials_delete on public.family_credentials
    for delete using (public.can_manage_family(family_id));

  -- The control deleted `row_id` on purpose — that was the point — so refile it
  -- and leave the family holding exactly what the assertions above counted. ON
  -- CONFLICT rather than an unconditional insert, so a control whose DELETE did
  -- nothing is still caught by the count below instead of being papered over.
  insert into public.family_credentials (id, family_id, category, label, username, secret, created_by)
    values (row_id, fam, 'card', 'Family Debit Card', '4242 4242 4242 4242', 'PIN 9317', par_u)
    on conflict (id) do nothing;

  select array_agg(p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|' ||
                   coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' ||
                   coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|' || p.polroles::text
                   order by p.polname)
    into post_state
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'family_credentials';
  if post_state is distinct from pre_state then
    failures := array_append(failures, format(
      'CONTROL FAILED: the control did not put back the policies it found — before it ran the table carried [%s] and after it carries [%s]. The restore above writes 0296''s four policies literally, so this is what a later migration tightening family_credentials looks like: restore what was captured, not what 0296 said.',
      array_to_string(pre_state, ' ; '), array_to_string(post_state, ' ; ')));
  end if;

  select count(*) into n from public.family_credentials where family_id = fam;
  if n <> fixture_n then
    failures := array_append(failures, format(
      'CONTROL FAILED: the negative control left the family holding %s credentials instead of the %s it started with — it corrupted the fixture it was supposed to leave alone', n, fixture_n));
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'family credential write boundary failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK family credentials: the child is a real active member of this family who can_manage_family refuses (control), is refused read, insert, update and delete, and a parent is not; and with 0119''s is_family_member predicate restored that SAME child got all four verbs through the SAME four policies — including UPDATE and DELETE of the very row the assertions above targeted — so the refusals are 0296''s role clause and nothing else (O-02 closed by main 0296)';
end $$;

rollback;
