-- ============================================================================
-- seed_group_decisions_one_family.sql — ≥500 records to fully exercise T6
-- (AI-facilitated group decisions) end-to-end: Group Voting polls that carry a
-- category, a budget cap and required (dietary) tags; options with real cost /
-- travel / tags; and biased votes so the consensus engine produces genuine
-- recommendations AND vote-vs-fit CONFLICTS (the crowd favorite is over budget
-- or misses a dietary requirement).
--
-- TARGET: The Kramer Family. IDEMPOTENT: every poll's question is prefixed
-- 'T6 · '; deleting those polls cascades to their options + votes (FK ON DELETE
-- CASCADE), so re-running is clean. Scoped to this family only.
--
-- VOLUME: 100 polls × 4 options = 500 option+poll rows, plus up to 8 votes per
-- poll (~700) → ≈1,200 records. Guarantees ≥500 even with no members.
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then open
--   /dashboard/voting.
-- ============================================================================

do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email   text := 'newworldventurellc@gmail.com';
  v_uid     uuid;
  v_members uuid[];
  v_mcount  int;
  g int; j int; k int;
  v_poll    uuid;
  v_opt     uuid;
  v_optids  uuid[];
  cats      text[] := array['meal','vacation','shopping','activity','general'];
  cat       text;
  v_budget  bigint;
  v_reqtags text[];
  v_cost    bigint;
  v_travel  int;
  v_tags    text[];
  v_pick    int;
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;
  v_mcount := coalesce(array_length(v_members, 1), 0);

  -- ── clean prior seed (cascades to options + votes) ───────────────────────
  delete from public.family_polls where family_id = v_fam and question like 'T6 · %';

  for g in 1..100 loop
    cat := cats[1 + (g % 5)];

    -- Per-category budget cap + dietary requirement (meal polls, every other one).
    v_budget  := case cat
                   when 'meal'     then 8000      -- $80
                   when 'vacation' then 300000    -- $3,000
                   when 'shopping' then 15000     -- $150
                   when 'activity' then 6000      -- $60
                   else null end;
    v_reqtags := case when cat = 'meal' and g % 2 = 0 then array['vegetarian'] else array[]::text[] end;

    insert into public.family_polls
      (family_id, question, description, kind, status, decision_category, budget_cents, required_tags, created_by)
    values
      (v_fam,
       'T6 · ' || initcap(cat) || ' choice ' || g,
       'Seeded facilitated decision — the family votes, Bubaly weighs budget + needs.',
       'single',
       case when g % 9 = 0 then 'closed' else 'open' end,
       cat, v_budget, v_reqtags, v_uid)
    returning id into v_poll;

    -- 4 options: costs rise A→D; option D is the pricey one (often over budget).
    -- Options B + D are vegetarian/gluten-free; A + C are not.
    v_optids := array[]::uuid[];
    for j in 1..4 loop
      v_cost   := (array[2500, 5000, 7500, 22000])[j] + (g % 5) * 100;
      v_travel := case cat when 'vacation' then 30 * j else null end;
      v_tags   := case when j in (2, 4) then array['vegetarian','gluten-free'] else array['meat'] end;
      insert into public.family_poll_options
        (family_id, poll_id, label, sort, cost_cents, travel_minutes, tags)
      values
        (v_fam, v_poll,
         (array['Option A','Option B','Option C','Option D'])[j] || ' · ' || g,
         j - 1, v_cost, v_travel, v_tags)
      returning id into v_opt;
      v_optids := v_optids || v_opt;
    end loop;

    -- Votes: on EVEN polls, bias the plurality toward option D (pricey → over
    -- budget) so a vote-vs-fit CONFLICT surfaces; on ODD polls spread the votes.
    if v_mcount > 0 then
      for k in 1..least(v_mcount, 8) loop
        if g % 2 = 0 then
          v_pick := case when k <= 4 then 4 else 1 + (k % 3) end;
        else
          v_pick := 1 + (k % 4);
        end if;
        insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
        values (v_fam, v_poll, v_optids[v_pick], v_members[k])
        on conflict (option_id, member_id) do nothing;
      end loop;
    end if;
  end loop;

  raise notice 'T6 group-decisions seed complete for family % (100 polls, 400 options, ~% votes).',
    v_fam, least(v_mcount, 8) * 100;
end $$;

-- ── Verify row counts (polls + options + votes for the seed) ────────────────
select 'family_polls' as tbl, count(*) from public.family_polls
  where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and question like 'T6 · %'
union all
select 'family_poll_options', count(*) from public.family_poll_options o
  where o.family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)
    and o.poll_id in (select id from public.family_polls where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and question like 'T6 · %')
union all
select 'family_poll_votes', count(*) from public.family_poll_votes v
  where v.family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)
    and v.poll_id in (select id from public.family_polls where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and question like 'T6 · %');
