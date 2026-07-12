-- ============================================================================
-- FamilyOS · SEED — Family Economy / Allowance (currency_transactions 500+).
-- Custom non-cash currencies (Stars ⭐, Screen-time ⏰, Chore Coins 🪙), a reward
-- catalog, an immutable 500-row token ledger, and ~120 redemptions — enough to
-- exercise /economy (Allowance) at real volume.
-- Idempotent: seed currencies carry a '[seed]' name prefix; deleting them
-- cascades their transactions / rewards / redemptions (FK ON DELETE CASCADE).
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_cur     uuid[];
  n int := 500;
  r_titles text[] := array['Movie night pick','30 min extra screen time','Choose dinner','Stay up 30 min late',
                           'Friend sleepover','Ice cream trip','Skip one chore','Pick the weekend outing',
                           'Control the playlist','Breakfast in bed','$5 toward a toy','Family game pick'];
  reasons  text[] := array['Chore completed','Bonus for kindness','Weekly allowance','Homework streak',
                           'Helped a sibling','Reward redemption','Manual award','Correction'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;
  if v_members is null then raise exception 'Family % has no members.', v_family; end if;

  -- Idempotent reset: dropping the seed currencies cascades everything below them.
  delete from public.family_currencies where family_id = v_family and name like '[seed]%';

  insert into public.family_currencies (family_id, name, emoji, unit_label, is_active, sort_order)
  values
    (v_family, '[seed] Stars', '⭐', 'star', true, 90),
    (v_family, '[seed] Screen Time', '⏰', 'minute', true, 91),
    (v_family, '[seed] Chore Coins', '🪙', 'coin', true, 92);
  select array_agg(id order by sort_order) into v_cur
  from public.family_currencies where family_id = v_family and name like '[seed]%';

  -- Reward catalog (~24 across the three currencies).
  insert into public.economy_rewards (family_id, currency_id, title, emoji, cost, stock, is_active, sort_order)
  select v_family,
    v_cur[1 + (g.i % 3)],
    r_titles[1 + (g.i % array_length(r_titles,1))],
    (array['🎬','📺','🍽️','🌙','🛌','🍦','🧹','🗺️','🎧','🥞','🧸','🎮'])[1 + (g.i % 12)],
    (5 + (g.i % 10) * 5)::bigint,
    case when g.i % 4 = 0 then null else 3 + (g.i % 8) end,
    true,
    g.i
  from generate_series(1, 24) as g(i);

  -- The immutable token ledger — 500 credits/debits across members + currencies.
  insert into public.currency_transactions (family_id, currency_id, member_id, direction, amount, reason, related_type, created_at)
  select v_family,
    v_cur[1 + (g.i % 3)],
    v_members[1 + (g.i % array_length(v_members,1))],
    (case when g.i % 3 = 0 then 'debit' else 'credit' end)::economy_direction,
    (1 + (g.i % 40))::bigint,
    reasons[1 + (g.i % array_length(reasons,1))],
    (array['chore_assignment','manual','redemption','reversal'])[1 + (g.i % 4)],
    now() - ((g.i % 180) || ' days')::interval
  from generate_series(1, n) as g(i);

  -- ~120 redemptions spanning statuses.
  insert into public.economy_redemptions (family_id, currency_id, member_id, title, cost, status, note, created_at)
  select v_family,
    v_cur[1 + (g.i % 3)],
    v_members[1 + (g.i % array_length(v_members,1))],
    r_titles[1 + (g.i % array_length(r_titles,1))],
    (5 + (g.i % 10) * 5)::bigint,
    -- economy redemptions never use the 'requested' state (that's a
    -- reward_redemptions value); some prod DBs carry a status CHECK that rejects
    -- it, so seed only the economy-valid lifecycle statuses.
    (array['pending','approved','fulfilled','rejected'])[1 + (g.i % 4)]::redemption_status,
    '[seed] redemption',
    now() - ((g.i % 120) || ' days')::interval
  from generate_series(1, 120) as g(i);

  raise notice 'Economy seeded: 3 currencies, 24 rewards, % transactions, 120 redemptions for family %', n, v_family;
end $$;
