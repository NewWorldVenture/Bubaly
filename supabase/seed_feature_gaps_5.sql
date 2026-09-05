-- ============================================================================
-- Bubaly · SEED — feature-gap coverage (round 5): the last user-facing left-nav
-- tables with no seed rows. Covers: Loyalty (account + transactions + redemptions) ·
-- Weather saved locations · wallet Pay handles · Assistant chat history
-- (conversations + messages) · Concierge sessions · Opportunities.
--
-- Same conventions as rounds 3/4: family-by-email, to_regclass + parent guards,
-- enum_range for enums, idempotent via '[seed]' markers / "seed once when none".
-- PG16-validated. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_owner   uuid;
  v_members uuid[];
  v_conv    uuid;
  v_ci      int;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select u.id into v_owner from auth.users u where lower(u.email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  -- ── Loyalty account (1, upsert) + transactions (20) + redemptions (6) ────
  if to_regclass('public.loyalty_accounts') is not null then
    insert into public.loyalty_accounts (family_id, points_balance, lifetime_points, tier)
    values (v_family, 1250, 4300, 'silver')
    on conflict (family_id) do update set points_balance = excluded.points_balance;
  end if;
  if to_regclass('public.loyalty_transactions') is not null then
    delete from public.loyalty_transactions where family_id = v_family and reason like '[seed]%';
    insert into public.loyalty_transactions (family_id, points, kind, reason, source, balance_after, created_by, created_at)
    select v_family,
      case when g % 4 = 0 then -(50 + (g % 5) * 25) else (25 + (g % 6) * 20) end,
      case when g % 4 = 0 then 'redeem' else 'earn' end,
      '[seed] ' || (array['Welcome bonus','Referral reward','Left a review','Monthly bonus','Redeemed a perk','Purchase points'])[1 + (g % 6)],
      (array['signup','referral','review','manual','redemption','purchase'])[1 + (g % 6)],
      1000 + g * 15,
      v_owner,
      now() - ((g % 60) || ' days')::interval
    from generate_series(1, 20) g;
  end if;
  if to_regclass('public.loyalty_redemptions') is not null then
    delete from public.loyalty_redemptions where family_id = v_family and notes like '[seed]%';
    insert into public.loyalty_redemptions (family_id, reward_name, cost_points, status, code, notes, created_by, created_at)
    select v_family,
      (array['$5 gift card','Free month','Premium sticker pack','Movie rental','Coffee voucher','Charity donation'])[g],
      100 + g * 50,
      (array['pending','fulfilled','fulfilled','pending','fulfilled','cancelled'])[g],
      'RDM-' || lpad(g::text, 5, '0'),
      '[seed] redemption', v_owner,
      now() - ((g % 40) || ' days')::interval
    from generate_series(1, 6) g;
  end if;

  -- ── Weather saved locations (seed once — Home + 2 others) ────────────────
  if to_regclass('public.weather_locations') is not null
     and not exists (select 1 from public.weather_locations where family_id = v_family) then
    insert into public.weather_locations (family_id, name, admin1, country, latitude, longitude, is_default, sort_order, created_by)
    values
      (v_family, 'Home', 'California', 'US', 37.7749, -122.4194, true, 0, v_owner),
      (v_family, 'Grandma''s', 'Colorado', 'US', 39.7392, -104.9903, false, 1, v_owner),
      (v_family, 'Beach House', 'California', 'US', 36.9741, -122.0308, false, 2, v_owner);
  end if;

  -- ── Wallet pay handles (family-level + per child wallet; seed once) ───────
  if to_regclass('public.pay_handles') is not null
     and not exists (select 1 from public.pay_handles where family_id = v_family) then
    insert into public.pay_handles (family_id, child_wallet_id, handle, is_active, created_by)
    values (v_family, null, 'the_' || substr(md5(v_family::text), 1, 6) || '_family', true, v_owner);
    if to_regclass('public.child_wallets') is not null then
      insert into public.pay_handles (family_id, child_wallet_id, handle, is_active, created_by)
      select v_family, w.id, 'kid_' || substr(md5(w.id::text), 1, 8), true, v_owner
      from public.child_wallets w where w.family_id = v_family
      on conflict do nothing;
    end if;
  end if;

  -- ── Assistant chat history (2 conversations × a few messages; seed once) ─
  if to_regclass('public.ai_conversations') is not null and to_regclass('public.ai_messages') is not null
     and not exists (select 1 from public.ai_conversations where family_id = v_family and title like '[seed]%') then
    for v_ci in 1..2 loop
      v_conv := gen_random_uuid();
      insert into public.ai_conversations (id, family_id, user_id, title, provider, model)
      values (v_conv, v_family, v_owner, '[seed] ' || (array['Plan the week','Dinner ideas'])[v_ci], 'anthropic', 'claude-sonnet-5');
      insert into public.ai_messages (family_id, conversation_id, role, content, created_at)
      select v_family, v_conv,
        (enum_range(null::public.ai_role))[1 + (i % 2)]::public.ai_role,
        case when i % 2 = 1 then 'Can you help me organize this week?' else 'Absolutely — here is a plan for your family.' end,
        now() - ((6 - i) || ' hours')::interval
      from generate_series(1, 4) i;
    end loop;
  end if;

  -- ── Concierge sessions (5) ────────────────────────────────────────────────
  if to_regclass('public.concierge_sessions') is not null then
    delete from public.concierge_sessions where family_id = v_family and notes like '[seed]%';
    insert into public.concierge_sessions (family_id, created_by, title, kind, status, notes, ai_summary, created_at)
    select v_family, v_owner,
      (array['Plan Emma''s birthday','Book summer camp','Weekend getaway','Find a babysitter','Organize the move'])[g],
      (array['party','activity','travel','service','general'])[g],
      (array['planning','booked','confirmed','completed','planning'])[g],
      '[seed] concierge request',
      'A short AI summary of the request and next steps.',
      now() - ((g % 20) || ' days')::interval
    from generate_series(1, 5) g;
  end if;

  -- ── Opportunities (10) ────────────────────────────────────────────────────
  if to_regclass('public.opportunities') is not null then
    delete from public.opportunities where family_id = v_family and notes like '[seed]%';
    insert into public.opportunities (family_id, member_id, title, category, url, cost, opens_at, deadline, status, notes, created_by)
    select v_family,
      v_members[1 + (g % array_length(v_members,1))],
      (array['Summer coding camp','Soccer league','Art class','Robotics club','Swim lessons','Scout troop','Music lessons','Chess club','Drama camp','Science fair'])[g],
      (array['camp','sports','class','activity','class','activity','class','activity','camp','school'])[g],
      'https://example.com/opp/' || g,
      (50 + g * 25)::numeric,
      current_date + (g * 5), current_date + (g * 5 + 20),
      (enum_range(null::opportunity_status))[1 + (g % array_length(enum_range(null::opportunity_status),1))]::opportunity_status,
      '[seed] opportunity', v_owner
    from generate_series(1, 10) g;
  end if;

  raise notice 'Feature-gap round-5 seed complete for family %.', v_family;
end $$;
