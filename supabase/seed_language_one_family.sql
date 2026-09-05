-- ============================================================================
-- seed_language_one_family.sql — Language Practice demo data for ONE family (TODO-0415)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • language_goals    — 250 goals across members and languages: one live
--                         goal per member, the rest archived past goals
--   • language_sessions — 250 practice sessions (kinds, minutes, scores,
--                         corrections) forming streaks on the live goals
--   • vocab_cards       — 250 spaced-repetition cards in every SM-2 state:
--                         new, learning, mature, due today, suspended
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:language]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:language   REQUIRES: migration 0248
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  codes     text[] := array['es','fr','de','it','pt','ja','zh'];
  labels    text[] := array['Spanish','French','German','Italian','Portuguese','Japanese','Mandarin'];
  levels    text[] := array['A0','A1','A2','B1','B2'];
  kinds     text[] := array['vocab','conversation','listening','reading','writing','grammar','lesson','tutor','immersion'];
  topics    text[] := array['Ordering food','Past tense','Family words','Directions','Episode 3 with subtitles','Numbers and time','At the doctor','Weather small talk','Song lyrics','Homework chapter 4','School vocabulary','Weekend plans'];
  corr      text[] := array['“Tengo hambre”, not “soy hambre”','Use the subjunctive after “espero que”','Gender: la mano, el día','“Je suis allé” for movement verbs','Der/die/das: das Mädchen','Particle は vs が','Tone 3 sandhi: nǐ hǎo → ní hǎo','Plural: -i for masculine nouns','Ser vs estar for location'];
  words     text[] := array['hola|hello','gracias|thank you','agua|water','comer|to eat','casa|house','familia|family','hoy|today','mañana|tomorrow','escuela|school','amigo|friend','grande|big','pequeño|small','tener|to have','querer|to want','tiempo|time','bueno|good','ayudar|to help','juntos|together','libro|book','perro|dog','gato|cat','leche|milk','pan|bread','ciudad|city','calle|street','coche|car','trabajo|work','jugar|to play','leer|to read','escribir|to write','hablar|to speak','escuchar|to listen','rojo|red','azul|blue','verde|green','frío|cold','calor|heat','lluvia|rain','sol|sun','noche|night'];
  i         int;
  gid       uuid;
  g_count   int;
  reps      int;
  ival      int;
  lap       int;
  due       date;
  part      text[];
  k_idx     int;
begin
  if to_regclass('public.language_goals') is null then
    raise notice 'language_goals not present — apply migration 0248 first. Skipping.';
    return;
  end if;
  select f.id into v_family from public.families f
    join public.family_members fm on fm.family_id = f.id join auth.users u on u.id = fm.user_id
    where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_family and is_active;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'Family % has no active members.', v_family; end if;
  select fm.user_id into v_user from public.family_members fm where fm.family_id = v_family and fm.user_id is not null order by fm.created_at limit 1;

  delete from public.vocab_cards where family_id = v_family and notes = '[seed:language]';
  delete from public.language_sessions where family_id = v_family and notes = '[seed:language]';
  delete from public.language_goals where family_id = v_family and notes = '[seed:language]';

  -- 1) 250 goals: one live per member, then archived history ------------------------
  create temp table seed_goals (idx int primary key, id uuid not null, member_id uuid not null, live boolean not null) on commit drop;
  for i in 1..n loop
    gid := gen_random_uuid();
    insert into public.language_goals (id, family_id, member_id, language_code, language_label, current_level, target_level, weekly_minutes, reason, started_on, is_active, notes, created_by)
    values (gid, v_family, v_members[1 + ((i - 1) % m_count)],
      codes[1 + (i % array_length(codes, 1))], labels[1 + (i % array_length(codes, 1))],
      levels[1 + (i % 4)], levels[2 + (i % 4)],
      case when i <= m_count then 60 + 30 * (i % 3) else 30 + 15 * (i % 6) end,
      (array['Grandma speaks it','School exam in May','The trip next summer','Watching shows without subtitles','Work'])[1 + (i % 5)],
      case when i <= m_count then current_date - (30 + (i * 11) % 200) else current_date - (300 + (i * 17) % 1500) end,
      i <= m_count, '[seed:language]', v_user);
    insert into seed_goals values (i, gid, v_members[1 + ((i - 1) % m_count)], i <= m_count);
  end loop;
  g_count := n;

  -- 2) 250 sessions: a daily streak on the live goals, the rest historical ----------
  for i in 1..n loop
    if i <= 60 then
      select id into gid from seed_goals where idx = 1 + ((i - 1) % m_count);
      due := current_date - ((i - 1) / m_count);          -- consecutive days → streaks
    else
      select id into gid from seed_goals where idx = 1 + ((i * 7) % g_count);
      due := current_date - (30 + (i * 5) % 700);
    end if;
    k_idx := 1 + (i % array_length(kinds, 1));
    insert into public.language_sessions (family_id, goal_id, member_id, kind, minutes, score, topic, corrections, practiced_on, notes, created_by)
    select v_family, gid, sg.member_id, kinds[k_idx], 5 + (i * 7) % 40,
      case when kinds[k_idx] in ('vocab','grammar','tutor','lesson') then 55 + (i * 3) % 45 else null end,
      topics[1 + (i % array_length(topics, 1))],
      case when kinds[k_idx] in ('conversation','tutor','writing') then array[corr[1 + (i % array_length(corr, 1))], corr[1 + ((i + 3) % array_length(corr, 1))]] else '{}' end,
      due, '[seed:language]', v_user
    from seed_goals sg where sg.id = gid;
  end loop;

  -- 3) 250 cards in every SM-2 state, concentrated on the live goals ----------------
  for i in 1..n loop
    if i <= 120 then select id into gid from seed_goals where idx = 1 + ((i - 1) % m_count);
    else select id into gid from seed_goals where idx = 1 + ((i * 3) % g_count); end if;
    part := string_to_array(words[1 + (i % array_length(words, 1))], '|');
    reps := case when i % 5 = 0 then 0 when i % 5 = 1 then 1 when i % 5 = 2 then 2 when i % 5 = 3 then 4 else 7 end;
    lap  := case when i % 7 = 0 then 1 + (i % 3) else 0 end;
    ival := case reps when 0 then 0 when 1 then 1 when 2 then 6 when 4 then 15 else 40 end;
    due  := case when reps = 0 then current_date when i % 3 = 0 then current_date - (i % 4) when i % 3 = 1 then current_date else current_date + 1 + (i % ival + 1) end;
    insert into public.vocab_cards (family_id, goal_id, term, translation, example, part_of_speech, tags, ease, interval_days, repetitions, lapses, due_on, last_reviewed_on, is_suspended, notes, created_by)
    values (v_family, gid,
      part[1] || case when i > array_length(words, 1) then ' (' || (i / array_length(words, 1) + 1) || ')' else '' end,
      part[2], case when i % 4 = 0 then 'Ejemplo: ' || part[1] || '.' else null end,
      (array['noun','verb','adjective','phrase'])[1 + (i % 4)],
      case when i % 2 = 0 then array['starter'] else array['class', 'chapter ' || (1 + i % 6)] end,
      round((2.5 - 0.2 * lap + 0.05 * (i % 5))::numeric, 2), ival, reps, lap, due,
      case when reps + lap > 0 then due - greatest(ival, 1) else null end,
      i % 23 = 0, '[seed:language]', v_user);
  end loop;

  raise notice 'Seeded language practice for family %: % goals, % sessions, % cards',
    v_family,
    (select count(*) from public.language_goals where family_id = v_family and notes = '[seed:language]'),
    (select count(*) from public.language_sessions where family_id = v_family and notes = '[seed:language]'),
    (select count(*) from public.vocab_cards where family_id = v_family and notes = '[seed:language]');
end $$;
