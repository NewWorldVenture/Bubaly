-- 0515 — A child's money is read by a manager and by that child.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6109587749: the audit's open sensitive-table finding ("55 OPEN,
-- owner decision"), child-money group, "managers and that child".
--
-- Sixteen tables hold a child's money and read with
-- is_family_member(family_id), so a sibling, a caregiver or a guest reads
-- every child's balance, ledger, goals, allowance, cards, investments, gift
-- links and Pay-IDs:
--
--   by member:  child_wallets, wallet_cards, wallet_passes, wallet_rewards,
--               stripe_cardholders
--   by wallet:  stripe_issuing_cards, stripe_authorizations,
--               wallet_transactions, invest_holdings, invest_orders,
--               pay_handles, wallet_buckets, wallet_goals, wallet_rules,
--               allowance_rules, gift_links
--
-- lib/ai/context/policy.ts lists every one as sensitive.
--
-- The decision:
--   * a parent or adult reads every row;
--   * the child a wallet is for reads it and everything on it, and the member
--     a card, pass or reward belongs to reads it;
--   * a row on no member or no wallet is a manager's; nobody else reads a row.
--
--   by member:  is_family_member(family_id)
--               and (can_manage_family(family_id) or is_self_member(member_id))
--   by wallet:  is_family_member(family_id)
--               and (can_manage_family(family_id)
--                    or is_own_child_wallet_in_family(child_wallet_id, family_id))
--
-- is_own_child_wallet_in_family() reads child_wallets as its owner (SECURITY
-- DEFINER, pinned search_path), so the wallet case does not recurse into
-- child_wallets' own read, and it is pinned to the row's family: a row of one
-- household is never another household's child's because of a wallet id.
-- gift_payments is left alone (0483 §9 already narrows it).
--
-- Every permissive read on the sixteen tables is replaced. allowance_rules
-- carried one FOR ALL policy ("Members manage allowance_rules"), so its write
-- half is re-created first, per command, with that policy's own USING and
-- WITH CHECK: writes are exactly what they were. Every other write policy is
-- untouched, and the migration refuses to finish if a table's count of write
-- policies other than allowance_rules' changes. Restrictive policies already
-- there (the held 0509's guest guard on fifteen of them, the 0254/0275
-- manager guards) are kept.
--
-- Shipped with the source (lib/wallet/own-wallets.ts, the same rule): every
-- wallet page reads a non-manager's own wallet, narrowed in the query, and
-- says so; a sibling's wallet answers a child as one that is not there; the
-- treasury and the family coach are a parent's or adult's; a card, pass or
-- reward a teen adds is filed on them.
--
-- HELD: 0515, requested on #771 in comment 6109587749 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-childs-money-is-read-by-managers-and-that-child-check.sql
-- and .github/workflows/child-money-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.is_own_child_wallet_in_family(p_child_wallet_id uuid, p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.child_wallets w
     where w.id = p_child_wallet_id
       and w.family_id = p_family_id
       and public.is_self_member(w.member_id)
  );
$$;

comment on function public.is_own_child_wallet_in_family(uuid, uuid) is
  'True when the child wallet is in that family and is the caller''s own (0515). Reads child_wallets as its owner, so a wallet-keyed read does not recurse into child_wallets'' read.';

revoke all on function public.is_own_child_wallet_in_family(uuid, uuid) from public;
revoke all on function public.is_own_child_wallet_in_family(uuid, uuid) from anon;
grant execute on function public.is_own_child_wallet_in_family(uuid, uuid) to authenticated;

do $$
declare
  x record;
  p record;
  using_expr text;
  check_expr text;
  writes_before int;
  writes_after int;
begin
  if to_regprocedure('public.is_family_member(uuid)') is null or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0515 needs is_family_member, can_manage_family and is_self_member';
  end if;
  for x in select * from (values
             ('child_wallets', 'member'), ('wallet_cards', 'member'), ('wallet_passes', 'member'),
             ('wallet_rewards', 'member'), ('stripe_cardholders', 'member'),
             ('stripe_issuing_cards', 'wallet'), ('stripe_authorizations', 'wallet'), ('wallet_transactions', 'wallet'),
             ('invest_holdings', 'wallet'), ('invest_orders', 'wallet'), ('pay_handles', 'wallet'),
             ('wallet_buckets', 'wallet'), ('wallet_goals', 'wallet'), ('wallet_rules', 'wallet'),
             ('allowance_rules', 'wallet'), ('gift_links', 'wallet')) as v(t, rule) loop
    if to_regclass('public.' || x.t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t and column_name = 'family_id')
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t
                         and column_name = case x.rule when 'member' then 'member_id' else 'child_wallet_id' end) then
      raise exception '0515 needs public.% with the columns its rule reads', x.t;
    end if;
    if exists (select 1 from pg_policy where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd = '*')
       and x.t <> 'allowance_rules' then
      raise exception '0515: public.% carries a FOR ALL policy this migration does not expect', x.t;
    end if;
    select count(*) into writes_before from pg_policy where polrelid = ('public.' || x.t)::regclass and polcmd not in ('r', '*');
    for p in select polname, polcmd, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as chk
               from pg_policy
              where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd in ('r', '*') loop
      if p.polcmd = '*' then
        -- Keep the write half of a FOR ALL policy, verbatim, per command.
        using_expr := coalesce(p.qual, 'true');
        check_expr := coalesce(p.chk, p.qual, 'true');
        execute format('drop policy if exists %I on public.%I', 'Members add ' || x.t, x.t);
        execute format('drop policy if exists %I on public.%I', 'Members change ' || x.t, x.t);
        execute format('drop policy if exists %I on public.%I', 'Members remove ' || x.t, x.t);
        execute format('create policy %I on public.%I for insert to authenticated with check (%s)', 'Members add ' || x.t, x.t, check_expr);
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', 'Members change ' || x.t, x.t, using_expr, check_expr);
        execute format('create policy %I on public.%I for delete to authenticated using (%s)', 'Members remove ' || x.t, x.t, using_expr);
        writes_before := writes_before + 3;
      end if;
      execute format('drop policy %I on public.%I', p.polname, x.t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id) and (public.can_manage_family(family_id) or %s))',
      'A child''s money is read by a manager or that child', x.t,
      case x.rule when 'member' then 'public.is_self_member(member_id)'
                  else 'public.is_own_child_wallet_in_family(child_wallet_id, family_id)' end);
    select count(*) into writes_after from pg_policy where polrelid = ('public.' || x.t)::regclass and polcmd not in ('r', '*');
    if writes_after <> writes_before then
      raise exception '0515: public.% had % write policies and now has %', x.t, writes_before, writes_after;
    end if;
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['child_wallets', 'wallet_cards', 'wallet_passes', 'wallet_rewards', 'stripe_cardholders',
                           'stripe_issuing_cards', 'stripe_authorizations', 'wallet_transactions', 'invest_holdings',
                           'invest_orders', 'pay_handles', 'wallet_buckets', 'wallet_goals', 'wallet_rules',
                           'allowance_rules', 'gift_links'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'A child''s money is read by a manager or that child') then
      raise exception '0515: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception '0515: public.% has row security off', t;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.is_own_child_wallet_in_family(uuid,uuid)')
                  and p.prosecdef and p.proconfig is not null) then
    raise exception '0515: is_own_child_wallet_in_family is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
