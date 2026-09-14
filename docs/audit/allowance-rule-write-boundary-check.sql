-- Behavioural proof for 0298, run as real `authenticated` sessions under RLS.
--
-- 0217 narrowed writes to can_manage_family on five wallet tables and 0254/0275
-- re-assert that set with restrictive guards. SIX tables from the same 0088 loop
-- were never on the list and kept its permissive `FOR ALL … is_family_member`.
--
-- allowance_rules is the one that moves money, and the route around 0217 is one
-- level up rather than through it: a child cannot insert a wallet_transaction,
-- but they could insert a RULE — and app/api/cron/wallet-allowance runs under
-- the service role, bypasses RLS, and credits `rule.amount_cents`.
--
-- What a member may still DO is asserted alongside what they may not: reads stay
-- family-wide, because a child seeing their own allowance and savings goal is
-- the product working. A guard that blinded them would be a different bug.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'aaaa0000-0000-4000-8000-00000000000a';
  parent_uid uuid := 'a0000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'a0000000-0000-4000-8000-000000000002';
  child_mid  uuid;
  wallet     uuid;
  rule_id    uuid;
  goal_id    uuid;
  blocked    boolean;
  n          int;
  t          text;
begin
  -- Re-runnable: CI replays into a fresh database, but a probe a person cannot
  -- run twice is a probe they stop running.
  delete from public.allowance_rules where family_id = fam;
  delete from public.wallet_goals where family_id = fam;
  delete from public.gift_links where family_id = fam;
  delete from public.child_wallets where family_id = fam;
  delete from public.family_wallets where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Allowance') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'ap@example.test'), (child_uid, 'ac@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  insert into public.family_wallets (family_id) values (fam) on conflict do nothing;
  insert into public.child_wallets (family_id, member_id, is_active)
  values (fam, child_mid, true) returning id into wallet;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. The headline: a child cannot write themselves an allowance. Before 0298
  --    this returned INSERT 0 1, and the nightly cron paid it.
  blocked := false;
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 999999, 'weekly', true, current_date);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted an allowance rule';
  end if;

  -- 2. Nor the other five tables from the same loop.
  foreach t in array array['wallet_goals','gift_links','gift_payments','babysitter_profiles','babysitter_payments'] loop
    blocked := false;
    begin
      case t
        when 'wallet_goals' then
          insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents)
          values (fam, wallet, 'A pony', 500000);
        when 'gift_links' then
          insert into public.gift_links (family_id, child_wallet_id, token)
          values (fam, wallet, 'child-minted-token');
        when 'gift_payments' then
          insert into public.gift_payments (family_id, child_wallet_id, giver_name, amount_cents, status)
          values (fam, wallet, 'Nobody', 250000, 'completed');
        when 'babysitter_profiles' then
          insert into public.babysitter_profiles (family_id, name, rate_cents)
          values (fam, 'Me', 100000);
        when 'babysitter_payments' then
          insert into public.babysitter_payments (family_id, amount_cents, status)
          values (fam, 100000, 'completed');
      end case;
    exception when insufficient_privilege then blocked := true;
    end;
    if not blocked then
      raise exception 'a child inserted into %', t;
    end if;
  end loop;

  -- ── As the PARENT: the positive control ──────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
  values (fam, wallet, 500, 'weekly', true, current_date, parent_uid) returning id into rule_id;
  insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, created_by)
  values (fam, wallet, 'New bike', 12000, parent_uid) returning id into goal_id;

  update public.allowance_rules set amount_cents = 700 where id = rule_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer edit their own allowance rule (%)', n;
  end if;

  -- ── Back as the CHILD: reads stay, writes do not ─────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  select count(*) into n from public.allowance_rules where family_id = fam;
  if n <> 1 then
    raise exception 'a child can no longer SEE their own allowance rule (%)', n;
  end if;
  select count(*) into n from public.wallet_goals where family_id = fam;
  if n <> 1 then
    raise exception 'a child can no longer SEE their own savings goal (%)', n;
  end if;

  -- A child cannot raise a rule a parent wrote, nor delete it.
  update public.allowance_rules set amount_cents = 999999 where id = rule_id;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child raised their own allowance';
  end if;
  delete from public.wallet_goals where id = goal_id;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a savings goal';
  end if;

  -- ── No stray permissive write policy survives on any of the six ──────────
  reset role;
  select count(*) into n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname = any (array['allowance_rules','wallet_goals','gift_links',
                               'gift_payments','babysitter_profiles','babysitter_payments'])
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (c.relname || '_mng_insert', c.relname || '_mng_update', c.relname || '_mng_delete');
  if n <> 0 then
    raise exception '% stray permissive write policy(ies) on the allowance/gift tables', n;
  end if;

  raise notice 'OK allowance/gift writes: a child cannot write any of the six, a parent can, and a child still READS their own rule and goal';
end $$;
