-- ============================================================================
-- Bubaly · SEED — Email/Comms Concierge (family_communications 500).
-- The unified family inbox at real volume: calls, SMS, email, WhatsApp, school &
-- sports messages across every category, status and priority — so
-- /dashboard/inbox renders full.
-- Idempotent: seed rows carry a '[seed]' summary prefix; cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  chans  text[] := array['call','sms','email','whatsapp','instagram','school','sports','note','other'];
  cats   text[] := array['general','school','medical','sports','social','emergency','financial','legal','other'];
  stats  text[] := array['unread','unread','read','replied','archived','snoozed'];
  prio   text[] := array['low','normal','normal','high','urgent'];
  dirs   text[] := array['inbound','inbound','inbound','outbound'];
  subs   text[] := array['Field trip permission slip','Practice moved to 5pm','Invoice for after-school care',
                         'Playdate this Saturday?','Reminder: dentist Tuesday','Report card is ready',
                         'Carpool change this week','Fundraiser volunteers needed','Prescription ready for pickup',
                         'Photo day is Friday','Overdue library book','Season schedule attached'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_communications where family_id = v_family and summary like '[seed]%';

  insert into public.family_communications
    (family_id, channel, direction, subject, body, summary, category, status, priority, received_at)
  select v_family,
    chans[1 + (g.i % array_length(chans,1))],
    dirs[1 + (g.i % array_length(dirs,1))],
    subs[1 + (g.i % array_length(subs,1))] || ' #' || g.i,
    'Full message body captured by the family inbox for triage and one-tap reply.',
    '[seed] AI summary: needs a quick yes/no reply.',
    cats[1 + (g.i % array_length(cats,1))],
    stats[1 + (g.i % array_length(stats,1))],
    prio[1 + (g.i % array_length(prio,1))],
    now() - ((g.i * 53) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Communications seeded % messages for family %', n, v_family;
end $$;
