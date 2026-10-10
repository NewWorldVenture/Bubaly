-- Bubaly money boundary: read-only conservative metadata screening.
-- OPEN means a candidate requiring grants, role inheritance and helper review;
-- it is not proof of an exploitable production path. CLOSED assumes the direct
-- can_manage_family predicate has independently verified manager semantics.
-- Guards must cover every write command and every audience of each permission.
with money_tables(t) as (
  values ('family_wallets'),('child_wallets'),('wallet_buckets'),('wallet_transactions'),('wallet_rules'),('allowance_rules'),
         ('financial_accounts'),('transactions'),('budgets'),('bills'),('savings_goals')
), pol as (
  select m.t, c.oid as reg, c.relrowsecurity as rls_on,
         p.polname, p.polpermissive, p.polcmd, p.polroles,
         case p.polcmd
           when 'a' then coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
             in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
           when 'd' then coalesce(pg_get_expr(p.polqual, p.polrelid), '')
             in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
           else coalesce(pg_get_expr(p.polqual, p.polrelid), '')
             in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
             and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), '')
               in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
         end as manager_gated
  from money_tables m
  left join pg_class c on c.oid = to_regclass('public.' || m.t)
  left join pg_policy p on p.polrelid = c.oid and p.polcmd in ('a','w','d','*')
), coverage as (
  select w.*, not exists (
    select 1 from unnest(case when w.polcmd = '*' then array['a','w','d'] else array[w.polcmd::text] end) cmd,
                  unnest(w.polroles) audience
    where not exists (
      select 1 from pol g where g.t = w.t and not g.polpermissive and g.manager_gated
        and (g.polcmd = '*' or g.polcmd::text = cmd)
        and (0::oid = any(g.polroles) or audience = any(g.polroles))
    )
  ) as covered
  from pol w
)
select t as table_name, reg is not null as table_exists,
       coalesce(rls_on, false) as rls_enabled,
       count(*) filter (where not polpermissive and manager_gated) as restrictive_guards,
       count(*) filter (where polpermissive) as permissive_writes,
       count(*) filter (where polpermissive and not manager_gated) as ungated_permissive_writes,
       string_agg(polname, ', ' order by polname) filter (where polpermissive and not manager_gated and not covered) as offending_policies,
       case
         when reg is null then 'table absent'
         when not coalesce(rls_on, false) then '*** OPEN - RLS DISABLED ***'
         when count(*) filter (where polpermissive) = 0 then 'CLOSED - RLS on, no write policy grants access'
         when count(*) filter (where polpermissive and not manager_gated) = 0 then 'CLOSED - every write is manager-gated'
         when count(*) filter (where polpermissive and not manager_gated and not covered) = 0 then 'closed by restrictive guard'
         else '*** OPEN - non-manager can write ***'
       end as verdict
from coverage group by t, reg, rls_on order by t;
