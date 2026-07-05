-- ============================================================================
-- FamilyOS · SEED — Pillar #8: Design for Calm (calm inbox sources)
-- The calm inbox has no table of its own — it aggregates other sources. This
-- seeds 500 reminders due in the next 24h (the "For today" stream). Combine with
-- the #6 (agent_activity) and #7 (family_operating_index) seeds for the "Needs
-- you" action items. Idempotent via a '[seed:p8]' marker in notes.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  titles text[] := array['Pack lunches','Sign the permission slip','Call the dentist','Move the laundry',
                         'Water the plants','Take out recycling','RSVP to the party','Charge the tablet',
                         'Defrost dinner','Renew the library books','Pay the sitter','Refill prescriptions',
                         'Pick up dry cleaning','Feed the pets','Check the mail','Confirm the appointment'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.reminders where family_id = v_family and notes like '%[seed:p8]%';

  insert into public.reminders (family_id, title, notes, remind_at, is_done, member_id)
  select
    v_family,
    titles[1 + (g.i % array_length(titles, 1))] || ' #' || g.i,
    '[seed:p8]',
    now() + ((1 + floor(random() * 1439)) || ' minutes')::interval,   -- within the next ~24h
    false,
    case when v_members is null or random() < 0.4 then null else v_members[1 + floor(random()*array_length(v_members,1))::int] end
  from generate_series(1, n) as g(i);

  raise notice 'Pillar #8 (calm) seeded % reminders for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from public.reminders where remind_at between now() and now() + interval '24 hours' and is_done = false;
