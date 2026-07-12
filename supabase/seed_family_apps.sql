-- ============================================================================
-- SEED — Family App Store catalog (family_apps, 500 rows).
-- Reference data (no family scoping). Idempotent: seed rows use slug 'seed-app-%'
-- and are deleted + reinserted. Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  n int := 500;
  cats  text[] := array['calendar','meals','chores','school','sports','health','finance','travel','safety','home','ai_agents','other'];
  emos  text[] := array['🗓️','🍽️','🧹','🎒','⚽','🩺','💳','✈️','🛟','🏠','🤖','✨'];
  adjs  text[] := array['Smart','Auto','Family','Daily','Instant','AI','Pocket','Super','Bright','Calm','Swift','Prime'];
  nouns text[] := array['Planner','Assistant','Tracker','Coach','Organizer','Butler','Concierge','Radar','Copilot','Hub','Genie','Companion'];
  caps  text[] := array['reads_email','books_appointments','fills_forms','sends_reminders','summarizes','negotiates','predicts','auto_schedules','tracks_spend','answers_calls'];
  pubs  text[] := array['Bubaly','Bubaly Labs','Family Collective','OpenFamily','Hearth AI'];
begin
  delete from public.family_apps where slug like 'seed-app-%';

  insert into public.family_apps
    (slug, name, tagline, description, category, emoji, publisher, capabilities, is_official, is_ai, rating, install_count, status, sort_order)
  select
    'seed-app-' || g.i,
    adjs[1 + (g.i % array_length(adjs,1))] || ' ' || nouns[1 + ((g.i/3) % array_length(nouns,1))] || ' #' || g.i,
    'AI ' || nouns[1 + (g.i % array_length(nouns,1))] || ' for ' || cats[1 + (g.i % array_length(cats,1))] || ' — hands-free.',
    'A world-class AI extension that plugs into your family workflows to handle ' ||
      cats[1 + (g.i % array_length(cats,1))] || ' automatically. Installs in one tap, mobile-first.',
    cats[1 + (g.i % array_length(cats,1))],
    emos[1 + (g.i % array_length(emos,1))],
    pubs[1 + (g.i % array_length(pubs,1))],
    -- 2–4 capabilities, deterministic per row
    (select array_agg(distinct caps[1 + ((g.i + k) % array_length(caps,1))]) from generate_series(0, 2 + (g.i % 3)) k),
    (g.i % 4 = 0),                                   -- ~25% official
    true,
    round((35 + (g.i % 16)) / 10.0, 1),              -- 3.5–5.0
    (g.i * 37) % 5000,                               -- pseudo install counts
    (array['published','published','published','beta','coming_soon'])[1 + (g.i % 5)],
    g.i % 100
  from generate_series(1, n) as g(i);

  raise notice 'Family App Store seeded % catalog apps', n;
end $$;
