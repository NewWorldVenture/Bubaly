-- ============================================================================
-- FamilyOS · SEED — Money-timeline insights (500 records).
-- Fills money_timeline_insights so the Financial Copilot list + acknowledge/
-- dismiss flow can be tested at volume: the 4 week-bearing insight kinds
-- (low_balance / heavy_week / goal_at_risk / set_aside) across 125 distinct ISO
-- weeks each = 500 rows, each with a realistic title/detail/severity/amount and
-- a spread of active / acknowledged / dismissed status.
-- Idempotent: tags rows meta->>'seed' = 'money_timeline' and clears its own
-- rows first, so the (family_id, dedupe_key) unique constraint never collides.
-- Resolves family by email. (Needs migration 0168 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  kinds    text[] := array['low_balance','heavy_week','goal_at_risk','set_aside'];
  sevs     text[] := array['urgent','watch','watch','info'];
  n_weeks  int := 125;
  base_mon date := date_trunc('week', now())::date;   -- Monday of the current week
  total    int := 0;
  ki       int;
  wi       int;
  k        text;
  sev      text;
  wk       date;
  amt      numeric(12,2);
  st       text;
  ttl      text;
  dtl      text;
begin
  if to_regclass('public.money_timeline_insights') is null then
    raise notice 'money_timeline_insights not present — apply migration 0168 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Clear this seed's prior rows (idempotent re-run).
  delete from public.money_timeline_insights
   where family_id = v_family and meta->>'seed' = 'money_timeline';

  for ki in 1..array_length(kinds, 1) loop
    k := kinds[ki];
    sev := sevs[ki];
    for wi in 0..(n_weeks - 1) loop
      -- Spread weeks from ~40 weeks back to ~85 weeks ahead for a full trend.
      wk := base_mon + ((wi - 40) * 7);
      amt := round((80 + random() * 2200)::numeric, 2);
      -- Status mix: ~70% active, ~18% acknowledged, ~12% dismissed.
      st := case when random() < 0.70 then 'active'
                 when random() < 0.60 then 'acknowledged'
                 else 'dismissed' end;

      if k = 'low_balance' then
        ttl := 'Balance runs thin';
        dtl := format('Your projected balance dips to about $%s the week of %s — keep a cushion or shift a bill.', round(amt), to_char(wk, 'Mon DD'));
      elsif k = 'heavy_week' then
        ttl := 'A heavy money week is coming';
        dtl := format('About $%s is due the week of %s across several items. A set-aside now smooths it.', round(amt), to_char(wk, 'Mon DD'));
      elsif k = 'goal_at_risk' then
        ttl := 'A savings goal needs attention';
        dtl := format('To stay on pace you need about $%s more before %s — automating it makes the goal quietly happen.', round(amt), to_char(wk, 'Mon DD'));
      else -- set_aside
        ttl := format('Set aside ~$%s/wk to smooth it', round(amt / 8));
        dtl := format('Putting a little aside each week until %s covers the spike without a scramble.', to_char(wk, 'Mon DD'));
      end if;

      insert into public.money_timeline_insights
        (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key, meta)
      values
        (v_family, k, ttl, dtl, sev, wk, amt, st, k || ':' || wk::text,
         jsonb_build_object('seed', 'money_timeline'))
      on conflict (family_id, dedupe_key) do update
        set title = excluded.title, detail = excluded.detail, severity = excluded.severity,
            amount = excluded.amount, status = excluded.status, meta = excluded.meta;

      total := total + 1;
    end loop;
  end loop;

  raise notice 'Seeded % money_timeline_insights for family %.', total, v_family;
end $$;
