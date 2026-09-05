-- ============================================================================
-- Bubaly · SEED — Notifications (500) for the partner-tone surfaces (T5).
-- Fills the bell + /dashboard/notifications with 500 notifications across every
-- type and read state so the partner-tone phrasing (notificationsLine / bellLabel)
-- can be exercised at real volume — from "all caught up" up to a full inbox.
-- Idempotent: seed rows carry related_type='seed'; cleared before re-insert.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  n int := 500;
  titles text[] := array['Soccer practice at 5pm','Amoxicillin due tonight','Dentist tomorrow 9am',
                         'Field trip form due Friday','Game moved to Saturday','HVAC filter change due',
                         'Milk running low','Passport expires next month','New family invite pending',
                         'Weekly digest is ready','Library book overdue','Car registration renewal',
                         'Recital this weekend','Grocery pickup at 4pm','Prescription ready'];
begin
  select f.id, fm.user_id into v_family, v_user
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.notifications where family_id = v_family and related_type = 'seed';

  insert into public.notifications (family_id, user_id, type, title, body, related_type, is_read, send_at, sent_at, created_at)
  select v_family,
    -- ~1/3 targeted at the resolved parent, the rest family-wide (null recipient)
    case when g.i % 3 = 0 then v_user else null end,
    -- Pick from the enum's ACTUAL labels (drift-proof): the live DB's
    -- notification_type may not carry every label this repo's migration defines,
    -- so read enum_range instead of hard-coding values that could be missing.
    (enum_range(null::public.notification_type))[1 + (g.i % array_length(enum_range(null::public.notification_type), 1))],
    titles[1 + (g.i % array_length(titles,1))],
    'Bubaly flagged this from your family''s schedule so nothing slips.',
    'seed',
    -- newest ~40 unread (so the surfaces show a live count), the rest read
    (g.i > 40),
    now() - ((g.i * 71) || ' minutes')::interval,
    now() - ((g.i * 71) || ' minutes')::interval,
    now() - ((g.i * 71) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Notifications seeded % rows (~40 unread) for family %', n, v_family;
end $$;
