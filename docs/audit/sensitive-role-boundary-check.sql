-- ── 0297: three sensitive tables answer to role, not just to membership ─────
--
-- lib/ai/context/policy.ts lists 66 tables a child must not see. The database
-- disagreed with that list on 58 of them. 0297 fixes the three that need no
-- product decision; this proves those three, and proves them the way the vault
-- probe had to be taught to prove things — by first checking that the
-- impersonation TOOK. A probe that cannot tell "denied because child" from
-- "denied because unauthenticated" passes against a broken policy too.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/sensitive-role-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
do $$
declare
  fam    uuid := 'f0297000-0000-4000-8000-00000000fa01';
  par    uuid := 'f0297000-0000-4000-8000-00000000c001';
  adult  uuid := 'f0297000-0000-4000-8000-00000000c002';
  kid    uuid := 'f0297000-0000-4000-8000-00000000c003';
  sib    uuid := 'f0297000-0000-4000-8000-00000000c004';
  par_m uuid; adult_m uuid; kid_m uuid; sib_m uuid;
  lic_par uuid; lic_kid uuid; acct uuid;
  n int; refused boolean;
begin
  insert into public.families (id, name) values (fam, '0297 boundary') on conflict do nothing;
  insert into auth.users (id, email) values
    (par,'p0297@example.test'), (adult,'a0297@example.test'),
    (kid,'k0297@example.test'), (sib,'s0297@example.test')
  on conflict do nothing;

  delete from public.driver_licenses       where family_id = fam;
  delete from public.social_account_tokens where family_id = fam;
  delete from public.social_accounts       where family_id = fam;
  delete from public.child_logins          where family_id = fam;
  delete from public.family_members        where family_id = fam;

  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,par,'Parent','parent',true)  returning id into par_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,adult,'Adult','adult',true)  returning id into adult_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,kid,'Kid','child',true)      returning id into kid_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,sib,'Sibling','child',true)  returning id into sib_m;

  insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state)
    values (fam, par_m, 'A Parent', 'PARENT-LICENCE-PII', 'CA') returning id into lic_par;
  insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state)
    values (fam, kid_m, 'A Teen',   'TEEN-LICENCE',       'CA') returning id into lic_kid;
  insert into public.social_accounts (family_id, user_id, platform, status, health, scopes)
    values (fam, par, 'instagram', 'connected', 'ok', '{}') returning id into acct;
  insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'seeded', 'SEEDED-OAUTH-TOKEN');
  insert into public.child_logins (family_id, member_id, user_id, username, created_by)
    values (fam, kid_m, kid, 'k0297-kid', par), (fam, sib_m, sib, 'k0297-sibling', par);

  -- ── as the child ────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    raise exception '0297: impersonation failed — auth.uid() is %, expected the child; this probe is not testing what it claims', auth.uid();
  end if;

  -- 1. A parent's licence number is not a child's to read. Their own still is.
  select count(*) into n from public.driver_licenses where id = lic_par;
  if n <> 0 then
    raise exception '0297: a child reads a PARENT driver licence (% row(s)) — licence numbers are plaintext', n;
  end if;
  select count(*) into n from public.driver_licenses where id = lic_kid;
  if n <> 1 then
    raise exception '0297: a teenager cannot read their OWN licence (% rows) — the fix went too far', n;
  end if;

  -- 2. A sibling's login row is not a child's to rewrite or delete. The child
  --    sign-in derives BOTH the synthetic email and the password from
  --    username, so a rename or a delete locks that sibling out for good.
  update public.child_logins set username = 'hijacked' where member_id = sib_m;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0297: a child rewrote % sibling login row(s) — that sibling can no longer sign in', n;
  end if;
  delete from public.child_logins where member_id = sib_m;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0297: a child deleted % sibling login row(s)', n;
  end if;

  -- 3. OAuth tokens for the family's social accounts are adults-only.
  -- One token row exists (seeded above as the owner). If this assertion ran
  -- against an empty table it would pass whatever the policy said, which is the
  -- defect class this whole pass is about — so the row is seeded deliberately.
  select count(*) into n from public.social_account_tokens where family_id = fam;
  if n <> 0 then
    raise exception '0297: a child can read % social OAuth token row(s)', n;
  end if;
  refused := false;
  begin
    insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'child-added', 'x');
  -- Only the RLS refusal counts. `when others` would let a renamed column here
  -- report the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0297: a child inserted a social OAuth token row';
  end if;

  -- ── as a non-parent adult: the fix must not lock the grown-ups out ──────
  perform set_config('request.jwt.claim.sub', adult::text, true);
  if auth.uid() is distinct from adult then
    raise exception '0297: impersonation failed — auth.uid() is %, expected the adult', auth.uid();
  end if;

  select count(*) into n from public.driver_licenses where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 driver licences — can_manage_family admits parent AND adult', n;
  end if;
  select count(*) into n from public.child_logins where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 child logins', n;
  end if;
  update public.child_logins set username = 'k0297-kid-renamed' where member_id = kid_m;
  if not found then
    raise exception '0297: an ADULT cannot manage a child login — the fix is too strict';
  end if;
  insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'adult-added', 'enc');
  select count(*) into n from public.social_account_tokens where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 social token rows (1 seeded + 1 they just added)', n;
  end if;

  reset role;
  raise notice '0297 OK: a child is refused a parent licence, a sibling login and the OAuth tokens; keeps their own licence; parent and adult keep everything';
end $$;
