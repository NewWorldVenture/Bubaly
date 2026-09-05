-- ============================================================================
-- Bubaly · SEED — Paperwork Inbox (500 records).
-- Fills paperwork_items so the triage inbox can be tested at volume: all 7
-- kinds × realistic titles/summaries/senders, a spread of urgency and status,
-- due dates from 30 days back to 90 days ahead, extracted-action JSON in the
-- exact shape the module renders (some already materialized).
-- Idempotent: tags rows meta->>'seed' = 'paperwork' and clears its own rows
-- first. Resolves family by email. (Needs migration 0169 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_user   uuid;
  kinds    text[] := array['permission_slip','school_notice','medical_form','sports','bill_or_payment','event_flyer','other'];
  titles   text[] := array[
    'Field trip permission slip','Picture day order form','Sports physical form',
    'Team registration packet','Activity fee invoice','Spring carnival flyer',
    'Library notice','Immunization record request','Fundraiser packet',
    'After-school program form','Yearbook order form','Band instrument rental'];
  senders  text[] := array['Lincoln Elementary','Coach Dana','Dr. Patel''s office','PTA','City League','Room 14',null];
  stats    text[] := array['needs_action','needs_action','needs_action','in_progress','done','archived'];
  n        int := 500;
  i        int;
  k        text;
  st       text;
  ttl      text;
  snd      text;
  due      date;
  urg      text;
  amt      numeric(12,2);
  acts     jsonb;
  total    int := 0;
begin
  if to_regclass('public.paperwork_items') is null then
    raise notice 'paperwork_items not present — apply migration 0169 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  delete from public.paperwork_items
   where family_id = v_family and meta->>'seed' = 'paperwork';

  for i in 0..(n - 1) loop
    k   := kinds[1 + (i % array_length(kinds, 1))];
    st  := stats[1 + (i % array_length(stats, 1))];
    ttl := titles[1 + (i % array_length(titles, 1))] || ' #' || i::text;
    snd := senders[1 + (i % array_length(senders, 1))];
    due := (current_date - 30 + (i % 120));
    amt := case when k in ('bill_or_payment','sports','permission_slip') then round((5 + random() * 250)::numeric, 2) else null end;
    urg := case when due <= current_date + 2 then 'urgent'
                when due <= current_date + 7 then 'soon'
                else 'normal' end;

    acts := jsonb_build_array(
      jsonb_build_object('kind','sign','label','Sign and return','due_on',due::text,'amount',null,
        'materialized_as', case when st in ('done','in_progress') then 'reminder' else null end,
        'materialized_id', case when st in ('done','in_progress') then gen_random_uuid()::text else null end),
      jsonb_build_object('kind', case when amt is not null then 'pay' else 'schedule' end,
        'label', case when amt is not null then 'Make the payment' else 'Put it on the calendar' end,
        'due_on', due::text, 'amount', amt,
        'materialized_as', case when st = 'done' then case when amt is not null then 'reminder' else 'calendar_event' end else null end,
        'materialized_id', case when st = 'done' then gen_random_uuid()::text else null end)
    );

    insert into public.paperwork_items
      (family_id, kind, title, summary, raw_text, sender, due_on, amount, urgency, status, actions, meta, created_by, created_at)
    values
      (v_family, k, ttl,
       initcap(replace(k, '_', ' ')) || ' · sign and return · due ' || due::text,
       'Seeded paperwork body for ' || ttl || '. Please sign and return by ' || due::text || '.',
       snd, due, amt, urg, st, acts,
       jsonb_build_object('seed', 'paperwork'),
       v_user, now() - ((i % 90) || ' days')::interval);

    total := total + 1;
  end loop;

  raise notice 'Seeded % paperwork_items for family %.', total, v_family;
end $$;
