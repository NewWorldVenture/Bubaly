-- ============================================================================
-- Bubaly · SEED — feature-gap coverage for FK-parented tables that had no seed:
--   Medication Doses (500) and Kid Investing order history (500), plus the parent
--   rows they require (seed medications; an educational asset catalog + a child
--   investing wallet per member + starter holdings).
-- Guarded by to_regclass; idempotent (seed medications/assets carry markers and
-- deleting them cascades their children). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_members uuid[];
  v_meds    uuid[];
  v_assets  uuid[];
  v_wallets uuid[];
  n int := 500;
  v_price bigint; v_shares numeric; v_wid uuid; v_aid uuid;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Medication doses (500), on seed medications ──────────────────────────
  if to_regclass('public.medication_doses') is not null and to_regclass('public.medications') is not null then
    delete from public.medications where family_id = v_family and name like '[seed]%';  -- cascades doses
    insert into public.medications (family_id, member_id, name, dosage, instructions, is_active)
    select v_family,
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      '[seed] ' || (array['Vitamin D','Amoxicillin','Ibuprofen','Allergy tablet','Inhaler','Melatonin'])[1 + (g % 6)],
      (array['1 tablet','5 mL','200 mg','1 puff','10 mg','1 gummy'])[1 + (g % 6)],
      'Seeded medication for testing.', true
    from generate_series(1, 6) as g;
    select array_agg(id) into v_meds from public.medications where family_id = v_family and name like '[seed]%';

    insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status, taken_at, notes, created_at)
    select v_family,
      v_meds[1 + (g % array_length(v_meds,1))],
      case when v_members is null then null else v_members[1 + (g % array_length(v_members,1))] end,
      (now() - ((g % 90) || ' days')::interval - ((g % 3) * 8 || ' hours')::interval),
      (enum_range(null::dose_status))[1 + (g % array_length(enum_range(null::dose_status),1))]::dose_status,
      case when g % 5 < 3 then (now() - ((g % 90) || ' days')::interval) else null end,
      '[seed] dose',
      now() - ((g % 90) || ' days')::interval
    from generate_series(1, n) as g;
  end if;

  -- ── Kid investing: asset catalog + wallets + holdings + 500 orders ────────
  if to_regclass('public.invest_orders') is not null and v_members is not null then
    -- Educational asset catalog (global, unique by symbol; ZSEED* namespace).
    insert into public.invest_assets (symbol, name, kind, emoji, description, price_cents, risk_level, sort_order)
    select 'ZSEED' || lpad(g::text, 2, '0'),
      'Seed ' || (array['Fund','Stocks','Bonds','Basket'])[1 + (g % 4)] || ' ' || g,
      (array['fund','stocks','bonds','basket'])[1 + (g % 4)],
      (array['📈','💻','🏦','🧺','🌎','⚡'])[1 + (g % 6)],
      'Seeded educational asset.',
      (1000 + g * 250)::bigint,
      (array['low','medium','high'])[1 + (g % 3)],
      g
    from generate_series(1, 12) as g
    on conflict (symbol) do nothing;
    select array_agg(id) into v_assets from public.invest_assets where symbol like 'ZSEED%';

    -- A child investing wallet per member (idempotent).
    insert into public.child_wallets (family_id, member_id)
    select v_family, m from unnest(v_members) as m
    on conflict (family_id, member_id) do nothing;
    select array_agg(id) into v_wallets from public.child_wallets where family_id = v_family;

    -- Reset prior seed orders/holdings (scoped to the seed assets).
    delete from public.invest_orders   where family_id = v_family and asset_id = any(v_assets);
    delete from public.invest_holdings where family_id = v_family and asset_id = any(v_assets);

    -- Starter holdings: each wallet holds a few seed assets (capped by wallets×assets).
    insert into public.invest_holdings (family_id, child_wallet_id, asset_id, shares, avg_cost_cents)
    select v_family, w, a, (5 + (row_number() over () % 20))::numeric, (1000 + (row_number() over () % 40) * 250)::bigint
    from unnest(v_wallets) as w cross join unnest(v_assets) as a
    on conflict (child_wallet_id, asset_id) do nothing;

    -- 500 buy/sell orders across wallets × assets (order history — no unique cap).
    for g in 1..n loop
      v_wid   := v_wallets[1 + (g % array_length(v_wallets,1))];
      v_aid   := v_assets[1 + (g % array_length(v_assets,1))];
      v_price := (1000 + (g % 50) * 100)::bigint;
      v_shares:= (1 + (g % 20))::numeric;
      insert into public.invest_orders (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, created_at)
      values (v_family, v_wid, v_aid,
        (case when g % 3 = 0 then 'sell' else 'buy' end)::invest_order_side,
        v_shares, v_price, (v_shares * v_price)::bigint,
        (enum_range(null::invest_order_status))[1 + (g % array_length(enum_range(null::invest_order_status),1))]::invest_order_status,
        now() - ((g % 180) || ' days')::interval);
    end loop;
  end if;

  raise notice 'FK-parented feature-gap seed complete for family % (medication_doses 500, invest_orders 500).', v_family;
end $$;
