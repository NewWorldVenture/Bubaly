-- ============================================================================
-- FamilyOS · SEED — AI Front Desk / Phone Concierge (call_logs 500).
-- Enables Front Desk for the family and fills the screened-call log with 500
-- calls spanning every status + classification, so /dashboard/front-desk renders
-- at real volume.
-- Idempotent: settings upserted; call_logs seed rows carry a '[seed]' ai_summary
-- prefix and are cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  names  text[] := array['Dr. Patel''s office','Lincoln Elementary','Coach Rivera','Unknown Caller',
                         'City Plumbing','Grandma','Amazon Delivery','Auto Warranty','Pharmacy','Soccer League',
                         'Neighbor','Insurance Agent'];
  dirs   text[] := array['inbound','inbound','inbound','outbound'];
  stats  text[] := array['screened','answered','voicemail','blocked','missed','forwarded'];
  clss   text[] := array['important','known','unknown','spam','robocall','telemarketer'];
  prio   text[] := array['low','normal','normal','high','urgent'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.front_desk_settings (family_id, enabled, screening_mode, voicemail_enabled, block_spam)
  values (v_family, true, 'smart', true, true)
  on conflict (family_id) do update set enabled = excluded.enabled, updated_at = now();

  delete from public.call_logs where family_id = v_family and ai_summary like '[seed]%';

  insert into public.call_logs
    (family_id, caller_name, caller_number, direction, status, classification, priority,
     ai_summary, duration_secs, is_read, received_at)
  select v_family,
    names[1 + (g.i % array_length(names,1))],
    '+1555' || lpad(((g.i * 7919) % 10000000)::text, 7, '0'),
    dirs[1 + (g.i % array_length(dirs,1))],
    stats[1 + (g.i % array_length(stats,1))],
    clss[1 + (g.i % array_length(clss,1))],
    prio[1 + (g.i % array_length(prio,1))],
    '[seed] Caller asked about scheduling; AI screened and logged the details.',
    (g.i % 600),
    (g.i % 3 = 0),
    now() - ((g.i * 41) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Front Desk seeded % call logs for family %', n, v_family;
end $$;
