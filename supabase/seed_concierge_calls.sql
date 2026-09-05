-- ============================================================================
-- Bubaly · SEED — AI Concierge Calls (500 records).
-- Fills concierge_calls so the outbound "Bubaly calls for you" module can be
-- tested at volume: every task_kind × category, the full status lifecycle
-- (draft/queued/calling/completed/failed/action_needed/cancelled), an
-- AI-generated brief on every row, and outcomes/transcripts on completed calls.
-- Idempotent: clears its own '[seed:call]' rows first, then inserts. Resolves
-- the family by email (falls back to the oldest family).
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0173 applied.)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_member  uuid;
  v_user    uuid;
  n int := 500;
  kinds     text[] := array['book','reschedule','cancel','confirm','inquire','follow_up','other'];
  cats      text[] := array['medical','dental','school','restaurant','service','utility','retail','government','other'];
  names     text[] := array[
    'Bright Smiles Dental','Dr. Alvarez Pediatrics','Lincoln Elementary Office','Nonna''s Trattoria',
    'GreenLeaf Lawn Care','City Power & Light','The Bike Shop','County Passport Office',
    'Sunrise Family Clinic','Ace Plumbing','Riverside Vet','Summit Orthodontics'];
  goals     text[] := array[
    'Book a cleaning for two kids on the same afternoon',
    'Reschedule Thursday''s appointment to next week',
    'Cancel the standing Friday slot and stop billing',
    'Confirm the reservation for 6 at 7pm Saturday',
    'Ask whether they take our insurance and the copay',
    'Follow up on the refund promised two weeks ago',
    'Get the earliest available new-patient opening'];
  priorities text[] := array['low','normal','normal','high','urgent'];
  -- status mix: mostly completed, with a realistic spread of the lifecycle.
  statuses   text[] := array[
    'completed','completed','completed','completed','completed','completed',
    'queued','queued','action_needed','failed','draft','cancelled','calling'];
  outcomes   text[] := array[
    'Booked. Tue 3:40pm, both kids back-to-back. Confirmation texted to the family.',
    'Moved to next Wednesday 10:15am. They''ll send a reminder the day before.',
    'Cancelled and confirmed no further charges. Final statement mailed.',
    'Reservation confirmed for 6 at 7:00pm under the family name.',
    'They''re in-network; copay is $25. New patients need the intake form first.',
    'Refund was reissued today; 3–5 business days to the card on file.'];
  transcripts text[] := array[
    'Reached the front desk, gave both children''s names and DOBs, took the first same-day pair.',
    'Spoke to scheduling; original slot released, new one held under the family name.',
    'Confirmed account number, requested cancellation, got a confirmation code.',
    'Confirmed party size, time, and seating preference; noted a nut allergy.',
    'Verified plan and member ID; asked about copay and new-patient steps.',
    'Referenced the ticket number; agent located it and pushed the refund through.'];
  ki int; ci int; si int; st text;
  is_done boolean;
begin
  if to_regclass('public.concierge_calls') is null then
    raise notice 'concierge_calls not present — apply migration 0173 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.id, fm.user_id into v_member, v_user
  from public.family_members fm where fm.family_id = v_family
  order by fm.created_at limit 1;

  delete from public.concierge_calls where family_id = v_family and goal like '%[seed:call]%';

  for i in 0..(n - 1) loop
    ki := 1 + (i % 7);
    ci := 1 + (i % 9);
    si := 1 + (i % array_length(statuses, 1));
    st := statuses[si];
    is_done := st = 'completed';

    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category,
       goal, details, brief, status, priority, scheduled_for,
       outcome, transcript_summary, duration_seconds, attempts, provider_ref,
       completed_at, created_by, created_at)
    values (
      v_family, v_member, kinds[ki],
      names[1 + (i % array_length(names, 1))],
      -- ~1 in 6 requests has no number yet (parks as draft-style intent).
      case when i % 6 = 5 then null else '+1206555' || lpad((1000 + (i % 9000))::text, 4, '0') end,
      cats[ci],
      goals[ki] || ' [seed:call]',
      jsonb_build_object(
        'memberName', (array['Ava','Liam','Noah','Mia','the family'])[1 + (i % 5)],
        'preferredTimes', (array['weekday afternoons','Saturday morning','after 5pm','any time next week'])[1 + (i % 4)],
        'referenceNumber', case when i % 3 = 0 then 'REF-' || (10000 + i)::text else null end
      ),
      jsonb_build_object(
        'opening', 'Hi, I''m calling on behalf of the family regarding ' || goals[ki] || '.',
        'keyPoints', jsonb_build_array(
          'Be polite and concise.',
          'State the goal: ' || goals[ki] || '.',
          'Confirm details before agreeing to anything.'),
        'questions', jsonb_build_array(
          'What is the earliest available option?',
          'Is there a confirmation number?'),
        'successCriteria', 'The goal is met and a confirmation is captured.',
        'fallback', 'If unavailable, ask for the next opening and a callback number.'),
      st,
      priorities[1 + (i % array_length(priorities, 1))],
      case when st in ('queued','calling') then now() + ((i % 72) || ' hours')::interval else null end,
      case when is_done then outcomes[1 + (i % array_length(outcomes, 1))] else null end,
      case when is_done then transcripts[1 + (i % array_length(transcripts, 1))] else null end,
      case when is_done then 45 + (i % 300) else null end,
      case when st in ('completed','failed','calling') then 1 + (i % 3) else 0 end,
      case when is_done then 'seed-' || substr(md5(i::text), 1, 12) else null end,
      case when is_done then now() - ((i % 240) || ' hours')::interval else null end,
      v_user,
      now() - ((i) || ' hours')::interval
    );
  end loop;

  raise notice 'Concierge calls seeded % rows for family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from concierge_calls where goal like '%[seed:call]%';        -- 500
--   select status, count(*) from concierge_calls group by status order by 2 desc;
--   select task_kind, count(*) from concierge_calls group by task_kind order by 2 desc;
