
select pg_catalog.jsonb_build_object(
  'hasMigrationLedger', pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null,
  'publicFunctionDefaults', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'schema', coalesce(n.nspname, '*'), 'owner', pg_catalog.pg_get_userbyid(d.defaclrole),
    'grantee', case when a.grantee = 0 then 'public' else pg_catalog.pg_get_userbyid(a.grantee) end,
    'privilege', a.privilege_type))
    from pg_catalog.pg_default_acl d
    left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'f' and (d.defaclnamespace = 0 or n.nspname = 'public')), '[]'::jsonb),
  'workerRpc', (select pg_catalog.jsonb_build_object(
    'exists', oid is not null,
    'anonymousExecute', case when oid is not null then pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') else null end,
    'authenticatedExecute', case when oid is not null then pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') else null end,
    'serviceExecute', case when oid is not null then pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE') else null end)
    from (select pg_catalog.to_regprocedure('public.claim_ai_runs(integer,integer)') as oid) f),
  'tables', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', c.relname, 'rls', c.relrowsecurity) order by c.relname)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')), '[]'::jsonb),
  'columns', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', table_name, 'name', column_name, 'type', udt_name, 'nullable', is_nullable)
    order by table_name, ordinal_position)
    from information_schema.columns where table_schema = 'public'), '[]'::jsonb),
  'policies', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', tablename, 'name', policyname, 'command', cmd, 'roles', roles,
    'permissive', permissive, 'usingHash', pg_catalog.md5(coalesce(qual,'')),
    'checkHash', pg_catalog.md5(coalesce(with_check,''))) order by tablename, policyname)
    from pg_catalog.pg_policies where schemaname = 'public'), '[]'::jsonb),
  'functions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', p.proname, 'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
    'securityDefiner', p.prosecdef, 'definitionHash', pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)))
    order by p.proname, p.oid)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'), '[]'::jsonb),
  'constraints', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', c.relname, 'name', k.conname, 'type', k.contype,
    'definitionHash', pg_catalog.md5(pg_catalog.pg_get_constraintdef(k.oid))) order by c.relname, k.conname)
    from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'), '[]'::jsonb),
  -- Money write policies, resolved rather than hashed.
  --
  -- Every other policy in this snapshot is reported as md5(qual) / md5(with_check):
  -- catalog metadata only, no expressions. That is the right default, but on the
  -- money tables it produced a loop. A reader could see "wallet_transactions has a
  -- permissive INSERT policy" and could NOT see whether it required manager role,
  -- because a hash of can_manage_family(family_id) and a hash of
  -- is_family_member(family_id) are equally opaque. Those two differ by whether a
  -- child can mint money, so the only safe response was to escalate — which is
  -- exactly what happened, three releases running.
  --
  -- This resolves the one bit that decides it, and only that bit: a boolean for
  -- whether every applicable clause is a direct can_manage_family predicate. No expression text leaves the
  -- database, so the hashing posture above is unchanged. See docs/runbooks/LB-016.
  'moneyWritePolicies', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'table', c.relname, 'name', p.polname,
    'command', case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                             when 'd' then 'DELETE' when '*' then 'ALL' end,
    'permissive', p.polpermissive,
    'roles', (select pg_catalog.jsonb_agg(case when r.id = 0 then 'public' else pg_catalog.pg_get_userbyid(r.id) end order by r.id)
              from pg_catalog.unnest(p.polroles) as r(id)),
    -- Recognize only a direct manager predicate. Merely mentioning the helper
    -- (NOT, OR true, or only one UPDATE clause) does not prove a manager gate.
    'managerGated', case p.polcmd
      when 'a' then coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
        in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
      when 'd' then coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
      else coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)')
        and coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
          in ('can_manage_family(family_id)', 'public.can_manage_family(family_id)') end)
    order by c.relname, p.polname)
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and p.polcmd in ('a','w','d','*')
      and c.relname = any (array[
        'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules','allowance_rules',
        'financial_accounts','transactions','budgets','bills','savings_goals'])), '[]'::jsonb),
  'coreFunctions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'name', p.proname, 'definition', pg_catalog.pg_get_functiondef(p.oid)) order by p.proname)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in
      ('is_family_member','family_role','can_manage_family','is_family_admin',
       'set_updated_at','handle_new_user','handle_new_family')), '[]'::jsonb)
) as snapshot;
