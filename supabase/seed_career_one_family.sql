-- ============================================================================
-- seed_career_one_family.sql — Career Hub demo data for ONE family (TODO-0414)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • career_profiles  — 250 job searches across the family's members: one
--                        live search per member (adult roles first, first-job
--                        roles for the rest) plus archived past searches
--   • job_applications — 250 applications across every stage with dates,
--                        salaries, next steps (some overdue) and sources
--   • resume_versions  — 250 resume versions with keywords and ATS scores
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:career]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:career   REQUIRES: migration 0247
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  roles     text[] := array['Software Engineer','Data Analyst','Project Manager','Product Manager','Nurse','Teacher','Marketing Manager','Accountant','Sales Representative','Customer Support','Graphic Designer','Electrician','Barista','Lifeguard','Retail Associate','Babysitter'];
  role_kw   text[] := array['javascript|typescript|react|node.js|sql|git|testing|apis|cloud','sql|excel|python|tableau|statistics|dashboards|reporting|data cleaning','agile|scrum|stakeholders|roadmap|budget|risk management|jira|communication','roadmap|user research|metrics|prioritization|stakeholders|a/b testing|analytics','patient care|bls|medication administration|charting|epic|triage|acls','lesson planning|classroom management|assessment|differentiation|iep|parent communication','seo|content|campaigns|analytics|email marketing|brand|paid media|crm','gaap|reconciliation|excel|quickbooks|financial statements|audit|tax','prospecting|crm|salesforce|pipeline|negotiation|quota|demos','zendesk|ticketing|empathy|troubleshooting|sla|knowledge base','figma|adobe|typography|branding|layout|illustration|portfolio','nec code|wiring|troubleshooting|blueprints|safety|conduit|licensed','customer service|pos|espresso|cash handling|food safety|teamwork','cpr|first aid|lifeguard certification|swimming|safety|communication','customer service|pos|inventory|merchandising|cash handling|teamwork','cpr|first aid|childcare|reliability|communication|references'];
  companies text[] := array['Acme Logistics','Northwind Health','Riverbend School District','Bluebird Software','Harbor Coffee','Summit Analytics','Maple Credit Union','Lakeside YMCA','Orchard Retail','Pinecrest Clinic','Cedar Media','Granite Electric','Sunrise Bakery','Meadow Pediatrics','Beacon Insurance','Atlas Freight','Juniper Design','Willow Bank','Copper Kitchen','Horizon Telecom'];
  sources   text[] := array['LinkedIn','Indeed','Referral','Company site','Recruiter','Career fair','School board','Word of mouth'];
  stages    text[] := array['saved','applied','applied','screening','interview','applied','rejected','offer','applied','withdrawn','screening','interview','accepted','applied'];
  next_steps text[] := array['Send follow-up email','Phone screen','Panel interview','Send references','Take-home task','Negotiate offer','Thank-you note','Check portal'];
  cities    text[] := array['Austin, TX','Denver, CO','Remote','Portland, OR','Raleigh, NC','Madison, WI'];
  i         int;
  pid       uuid;
  r_idx     int;
  stg       text;
  applied   date;
  nxt_on    date;
  kw        text[];
  body      text;
  matched   text[];
  missing   text[];
  score     int;
  j         int;
  p_count   int;
begin
  if to_regclass('public.career_profiles') is null then
    raise notice 'career_profiles not present — apply migration 0247 first. Skipping.';
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

  delete from public.resume_versions where family_id = v_family and notes = '[seed:career]';
  delete from public.job_applications where family_id = v_family and notes = '[seed:career]';
  delete from public.career_profiles where family_id = v_family and notes = '[seed:career]';

  -- 1) 250 job searches: one live search per member, the rest archived history.
  create temp table seed_profiles (idx int primary key, id uuid not null, role_idx int not null, live boolean not null) on commit drop;
  for i in 1..n loop
    pid := gen_random_uuid();
    r_idx := 1 + ((i - 1) % array_length(roles, 1));
    insert into public.career_profiles (id, family_id, member_id, title, is_active, headline, summary, skills, target_roles, target_keywords, work_mode, employment_type, salary_target_cents, location, status, weekly_goal, notes, created_by)
    values (pid, v_family, v_members[1 + ((i - 1) % m_count)],
      case when i <= m_count then roles[r_idx] || ' search' else roles[r_idx] || ' search · ' || (2018 + (i % 8)) end,
      i <= m_count,
      roles[r_idx] || case when r_idx <= 12 then ' · ' || (3 + (i % 12)) || ' yrs' else ' · first job' end,
      'Looking for a ' || lower(roles[r_idx]) || ' role' || case when i % 3 = 0 then ' with a hybrid schedule around school pickup.' else '.' end,
      (string_to_array(role_kw[r_idx], '|'))[1:3 + (i % 4)],
      array[roles[r_idx], roles[1 + (r_idx % array_length(roles, 1))]],
      string_to_array(role_kw[r_idx], '|'),
      (array['any','remote','hybrid','onsite'])[1 + (i % 4)],
      case when r_idx > 12 then (array['part_time','first_job','internship'])[1 + (i % 3)] else (array['full_time','full_time','contract','part_time'])[1 + (i % 4)] end,
      case when r_idx > 12 then (12 + (i % 8)) * 100 else (55000 + (i * 1700) % 90000) * 100 end,
      cities[1 + (i % array_length(cities, 1))],
      case when i <= m_count then (array['active_search','interviewing','exploring'])[1 + (i % 3)] else (array['employed','paused','active_search','exploring','offer','interviewing'])[1 + (i % 6)] end,
      3 + (i % 8), '[seed:career]', v_user);
    insert into seed_profiles values (i, pid, r_idx, i <= m_count);
  end loop;
  p_count := n;

  -- 2) 250 applications: dense on the live profiles, spread over the rest -------------
  for i in 1..n loop
    if i <= 40 then j := 1 + ((i - 1) % m_count); else j := 1 + ((i * 7) % p_count); end if;
    select id, role_idx into pid, r_idx from seed_profiles where idx = j;
    stg := stages[1 + (i % array_length(stages, 1))];
    applied := case when stg = 'saved' then null else current_date - (1 + (i * 3) % 60) end;
    nxt_on := case when stg in ('applied','screening','interview','offer') and i % 3 <> 0 then current_date - 3 + (i % 9) else null end;
    insert into public.job_applications (family_id, profile_id, company, role_title, stage, source, url, location, work_mode, salary_min_cents, salary_max_cents, applied_on, last_activity_on, next_step, next_step_on, contact_name, excitement, notes, created_by)
    values (v_family, pid,
      companies[1 + (i % array_length(companies, 1))], roles[r_idx] || case when i % 5 = 0 then ' II' when i % 7 = 0 then ' (Senior)' else '' end,
      stg, sources[1 + (i % array_length(sources, 1))],
      'https://jobs.example.com/' || lower(replace(companies[1 + (i % array_length(companies, 1))], ' ', '-')) || '/' || i,
      cities[1 + ((i + 2) % array_length(cities, 1))], (array['remote','hybrid','onsite'])[1 + (i % 3)],
      case when i % 4 = 0 then null else (50000 + (i * 1300) % 80000) * 100 end,
      case when i % 4 = 0 then null else (70000 + (i * 1300) % 80000) * 100 end,
      applied,
      case when applied is null then null when stg in ('screening','interview','offer','accepted') then applied + 2 + (i % 8) when i % 4 = 0 then applied else applied + (i % 3) end,
      case when nxt_on is null then null else next_steps[1 + (i % array_length(next_steps, 1))] end, nxt_on,
      case when i % 3 = 0 then (array['Sam Ortiz','Priya Nair','Dana Whitfield','Lee Chen'])[1 + (i % 4)] else null end,
      case when i % 2 = 0 then 1 + (i % 5) else null end,
      '[seed:career]', v_user);
  end loop;

  -- 3) 250 resume versions with a deterministic ATS score ---------------------------------
  for i in 1..n loop
    if i <= 30 then j := 1 + ((i - 1) % m_count); else j := 1 + ((i * 11) % p_count); end if;
    select id, role_idx into pid, r_idx from seed_profiles where idx = j;
    kw := string_to_array(role_kw[r_idx], '|');
    -- Include the first k keywords in the body; the rest are "missing".
    matched := kw[1:(2 + (i % (array_length(kw, 1) - 1)))];
    missing := kw[(array_length(matched, 1) + 1):array_length(kw, 1)];
    body := 'Summary' || E'\n' || roles[r_idx] || ' with ' || (2 + (i % 10)) || ' years of experience delivering measurable results.' || E'\n\n' ||
            'Experience' || E'\n' || companies[1 + (i % array_length(companies, 1))] || ' — ' || roles[r_idx] || E'\n' ||
            '- Improved throughput 25% for a team of ' || (3 + (i % 9)) || ' people.' || E'\n' ||
            '- ' || array_to_string(matched, ', ') || ' used daily.' || E'\n\n' ||
            'Skills' || E'\n' || array_to_string(matched, ', ') || E'\n\n' || repeat('Detail ', 40 + (i % 60));
    score := round(array_length(matched, 1)::numeric / array_length(kw, 1) * 80) + 20;
    insert into public.resume_versions (family_id, profile_id, title, target_role, body, keywords, ats_score, matched_keywords, missing_keywords, is_primary, notes, created_by)
    values (v_family, pid,
      roles[r_idx] || ' — v' || (1 + (i % 4)), roles[r_idx], body, kw, least(100, score), matched, coalesce(missing, '{}'),
      i <= m_count, '[seed:career]', v_user);
  end loop;

  raise notice 'Seeded career hub for family %: % profiles, % applications, % resumes',
    v_family,
    (select count(*) from public.career_profiles where family_id = v_family and notes = '[seed:career]'),
    (select count(*) from public.job_applications where family_id = v_family and notes = '[seed:career]'),
    (select count(*) from public.resume_versions where family_id = v_family and notes = '[seed:career]');
end $$;
