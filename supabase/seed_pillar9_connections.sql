-- ============================================================================
-- FamilyOS · SEED — Pillar #9: Family API / Connections (family_connections)
-- 500 connection records across every provider + status so /dashboard/connections
-- and the underlying table can be fully tested. Idempotent: clears its own
-- 'seed-p9-%' rows first (matched on external_account_id), then reinserts.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0128 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;

  providers  text[] := array['google_calendar','apple_calendar','outlook_calendar','gmail','outlook_email',
                             'plaid','instacart','amazon_fresh','google_home','alexa','smartthings'];
  categories text[] := array['calendar','calendar','calendar','email','email',
                             'banking','grocery','grocery','smart_home','smart_home','smart_home'];
  statuses   text[] := array['connected','connected','connected','connected','syncing','error','disconnected'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_connections where family_id = v_family and external_account_id like 'seed-p9-%';

  -- Cycle providers + statuses with modulo (even spread; avoids the lateral
  -- random() constant-folding pitfall). external_account_id stays unique per row.
  insert into public.family_connections
    (family_id, provider, category, status, account_label, external_account_id, last_synced_at, error_message)
  select
    v_family,
    providers[1 + (g.i % array_length(providers, 1))],
    categories[1 + (g.i % array_length(categories, 1))],
    statuses[1 + (g.i % array_length(statuses, 1))],
    'Account #' || g.i,
    'seed-p9-' || g.i,
    case when statuses[1 + (g.i % array_length(statuses, 1))] in ('connected','syncing')
         then now() - (random() * 30 || ' days')::interval else null end,
    case when statuses[1 + (g.i % array_length(statuses, 1))] = 'error'
         then 'Reauthorize this connection' else null end
  from generate_series(1, n) as g(i);

  raise notice 'Pillar #9 (connections) seeded % records for family %', n, v_family;
end $$;

-- Verify:
--   select provider, count(*) from public.family_connections group by provider order by 2 desc;
--   select status, count(*) from public.family_connections group by status;
