-- ============================================================================
-- FamilyOS · SEED — Lead scores (500 records).
-- Fills crm_lead_scores so the admin Lead Scores view + ledger can be tested at
-- volume. Creates 500 seed crm_contacts leads (if needed) and gives each a
-- score/band plus an itemized factors ledger whose points sum to the score, so
-- the transparency ("expand to see why") is exercised across all four bands.
-- Idempotent: tags rows lead_source='seed_score' and clears its own rows first.
-- (Needs migration 0172 applied.) Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  n      int := 500;
  i      int;
  cid    uuid;
  sc     int;
  bnd    text;
  facs   jsonb;
  p_a    int;  -- sessions
  p_b    int;  -- conversions
  p_c    int;  -- remainder (other engagement)
  total  int := 0;
begin
  if to_regclass('public.crm_lead_scores') is null then
    raise notice 'crm_lead_scores not present — apply migration 0172 first. Skipping.';
    return;
  end if;

  delete from public.crm_lead_scores s using public.crm_contacts c
   where s.contact_id = c.id and c.lead_source = 'seed_score';
  delete from public.crm_contacts where lead_source = 'seed_score';

  for i in 0..(n - 1) loop
    insert into public.crm_contacts (email, lead_source, lead_status, lifecycle_stage, first_name)
    values ('score+' || i || '@seed.bubaly.app', 'seed_score', 'new', 'lead', 'Score ' || i)
    returning id into cid;

    -- Spread scores 4..96 across the four bands; build a ledger that sums to it.
    sc := 4 + (i % 24) * 4;                                  -- 4,8,...,96
    bnd := case when sc >= 75 then 'qualified' when sc >= 50 then 'hot'
                when sc >= 25 then 'warm' else 'cold' end;
    -- Ledger parts that sum EXACTLY to the score (like the real compute).
    p_a := least(sc, 20);                    -- sessions
    p_b := least(greatest(sc - 20, 0), 30);  -- conversions
    p_c := greatest(sc - 20 - 30, 0);        -- remainder
    facs := '[]'::jsonb;
    if p_a > 0 then facs := facs || jsonb_build_array(jsonb_build_object('key','sessions','label','Site engagement','points',p_a)); end if;
    if p_b > 0 then facs := facs || jsonb_build_array(jsonb_build_object('key','conversions','label','Converted','points',p_b)); end if;
    if p_c > 0 then facs := facs || jsonb_build_array(jsonb_build_object('key','demo','label','Tried the demo','points',p_c)); end if;

    insert into public.crm_lead_scores (contact_id, score, band, factors, computed_at)
    values (cid, sc, bnd, facs, now() - ((i % 30) || ' hours')::interval);

    total := total + 1;
  end loop;

  raise notice 'Seeded % crm_lead_scores (with seed contacts).', total;
end $$;
