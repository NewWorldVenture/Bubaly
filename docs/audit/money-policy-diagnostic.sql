-- Bubaly :: which money writes can a child actually make right now?
-- ----------------------------------------------------------------------------
-- Read-only. Changes nothing. Safe to run against production.
--
-- Paste this whole file into the Supabase SQL editor and run it. It is a plain
-- .sql file with no markdown fences, so it can be copied straight in — a fenced
-- block from a chat window pastes the ``` characters too and errors out.
--
-- WHY THIS EXISTS, AND WHY IT DOES NOT MATCH ON POLICY NAMES
--
-- The obvious version of this check lists the intended policy names and reports
-- anything else. That version passes production while production is broken:
--
--     bills | bills_insert | INSERT | PERMISSIVE | is_family_member(family_id)
--
-- `bills_insert` is exactly the name 0267 gives the intended manager-only
-- policy. The NAME is right and the RULE is wrong — `is_family_member`, not
-- `can_manage_family`. Membership, not role. A child has a real session in this
-- product (`/kid-login` is whitelisted in middleware.ts), so that policy lets a
-- minor turn off autopay on the mortgage or delete a budget.
--
-- So this matches on the policy EXPRESSION instead. Every row it returns is a
-- write a non-manager can currently make against the household's money.
--
-- WHAT A GOOD RESULT LOOKS LIKE: zero rows.

select
  c.relname                                   as table_name,
  p.polname                                   as policy_name,
  case p.polcmd
    when 'a' then 'INSERT' when 'w' then 'UPDATE'
    when 'd' then 'DELETE' when '*' then 'ALL (insert+update+delete+select)'
  end                                         as command,
  coalesce(pg_get_expr(p.polqual, p.polrelid), '(none)')      as using_expr,
  coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '(none)') as with_check_expr
from pg_policy p
join pg_class c     on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = any (array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
    'financial_accounts','transactions','budgets','bills','savings_goals'])
  -- Permissive policies OR together, so any one of them can grant a write on
  -- its own. Restrictive ones AND, so they can only ever take access away and
  -- are never the problem.
  and p.polpermissive
  -- Writes only. SELECT is deliberately membership-scoped on these tables; see
  -- migration 0267's header for why narrowing reads is a product decision
  -- rather than a security fix.
  and p.polcmd in ('a','w','d','*')
  -- The actual test: does this policy require manager role?
  and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
      coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') not like '%can_manage_family%'
order by c.relname, p.polcmd, p.polname;


-- ── Second question: are the restrictive guards in place? ───────────────────
--
-- These are the backstop. A restrictive policy ANDs with the union of the
-- permissive ones, so while these exist no permissive policy can grant past
-- them, whatever it is called. 0254 put them on the wallet tables; 0275 adds
-- them to the finance tables, which have never had any.
--
-- WHAT A GOOD RESULT LOOKS LIKE: 3 for every one of the ten tables
-- (insert + update + delete).

select
  t.table_name,
  count(p.polname) filter (where not p.polpermissive and p.polcmd in ('a','w','d')) as restrictive_write_guards,
  case
    when count(p.polname) filter (where not p.polpermissive and p.polcmd in ('a','w','d')) >= 3
      then 'guarded'
    else 'NO BACKSTOP'
  end as verdict
from (
  select unnest(array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
    'financial_accounts','transactions','budgets','bills','savings_goals']) as table_name
) t
left join pg_class c     on c.relname = t.table_name
left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
left join pg_policy p    on p.polrelid = c.oid
group by t.table_name
order by restrictive_write_guards, t.table_name;
