select jsonb_build_object(
 'observed_at', clock_timestamp(),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.table_name,'column',c.column_name,'type',c.udt_name,'nullable',c.is_nullable,'default',c.column_default) order by c.table_name,c.ordinal_position) from information_schema.columns c where c.table_schema='public' and c.table_name in ('allowance_rules','invest_orders','invest_assets')),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid))) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and c.relname in ('allowance_rules','invest_orders','invest_assets') and not t.tgisinternal),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid))) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('invest_order_economics_guard','invest_decide_order') and p.prokind='f'),
 'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',p.conname,'definition',pg_get_constraintdef(p.oid))) from pg_constraint p join pg_class c on c.oid=p.conrelid where c.relnamespace='public'::regnamespace and c.relname in ('allowance_rules','invest_orders','invest_assets'))
) as review;
