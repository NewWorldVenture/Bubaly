-- ============================================================================
-- seed_life_events_one_family.sql — ≥500 records to fully exercise T9
-- (Life & Milestones). Populates:
--   • life_event_plans (44) across all 6 templates, with past/future event
--     dates and a realistic mix of active / completed / archived status, plus
--   • life_event_plan_items (~530) — dated checklist steps with a done/undone
--     spread so progress bars, counts and completed states all render, plus
--   • family_facts (30) "what Bubaly has learned" so the learned surface is full.
--
-- TARGET: The Kramer Family. IDEMPOTENT: plans are tagged notes '[seed:t9]' and
-- deleted before re-insert (cascades to items); the learned facts are deleted by
-- their fixed labels. Scoped to this family only. Safe to re-run.
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then open
--   /dashboard/life-events.
-- ============================================================================

do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  g int; k int;
  v_plan   uuid;
  v_tmpl   text;
  v_title  text;
  v_count  int;
  v_status text;
  v_event  date;
  v_due    date;
  v_done   boolean;
  v_cat    text;
  tmpl_keys   text[] := array['new_baby','moving','school_start','vacation','new_pet','new_job'];
  tmpl_titles text[] := array['New Baby','Moving Home','School Start','Family Vacation','New Pet','New Job / Schedule Change'];
  cats     text[] := array['plan','buy','book','notify','document','health','home','celebrate'];
  verbs    text[] := array['Plan','Buy','Book','Notify about','Prepare documents for','Health check for','Set up','Celebrate'];
  labels   text[] := array['Friday tradition','Sunday dinner','Bedtime routine','Coffee order','Pizza night','Movie pick','Vacation style','Chore rhythm','Birthday tradition','Screen-time rule'];
  vals     text[] := array['Pizza & movie night','Roast at 6pm','Lights out 8:30','Oat-milk latte','Thin crust, extra cheese','Kids choose Fridays','Beach over city','Saturday reset','Breakfast in bed','1 hour weekdays'];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;

  -- ── clean prior seed (this family only) ──────────────────────────────────
  delete from public.life_event_plans where family_id = v_fam and notes = '[seed:t9]'; -- cascades to items
  delete from public.family_facts f
    where f.family_id = v_fam and exists (select 1 from unnest(labels) l where f.label like l || '%');

  -- ── 44 plans × their checklist items ─────────────────────────────────────
  for g in 1..44 loop
    v_tmpl  := tmpl_keys[1 + (g % 6)];
    v_title := tmpl_titles[1 + (g % 6)];
    v_count := case v_tmpl when 'new_baby' then 13 when 'moving' then 12 when 'school_start' then 12
                           when 'vacation' then 12 when 'new_pet' then 9 else 9 end;
    v_status := case when g % 5 = 0 then 'completed' when g % 7 = 0 then 'archived' else 'active' end;
    -- Active plans point to the future; completed/archived are in the past.
    v_event := case when v_status = 'active'
                    then current_date + ((g % 40) + 5)
                    else current_date - ((g % 30) + 5) end;

    insert into public.life_event_plans (family_id, template_key, title, event_date, status, notes, created_by)
    values (v_fam, v_tmpl, v_title, v_event, v_status, '[seed:t9]', v_uid)
    returning id into v_plan;

    for k in 1..v_count loop
      v_cat := cats[1 + (k % 8)];
      -- Steps lead up to the event (earliest first), last few land on/after it.
      v_due := v_event - ((v_count - k) * 3);
      v_done := case
        when v_status = 'completed' then true
        when v_status = 'archived'  then (k % 10) < 7            -- ~70% done
        else v_due < current_date or (k % 3 = 0)                 -- active: past-due + a few
      end;
      insert into public.life_event_plan_items
        (family_id, plan_id, title, category, due_on, is_done, sort, note, created_by)
      values
        (v_fam, v_plan,
         verbs[1 + (k % 8)] || ' — ' || v_title || ' · step ' || k,
         v_cat, v_due, v_done, k - 1,
         case when k = 1 then 'Kick-off step.' else null end,
         v_uid);
    end loop;
  end loop;

  -- ── 30 "what Bubaly has learned" facts (the learned surface) ─────────────
  insert into public.family_facts (family_id, category, label, value, notes, is_pinned, created_by)
  select v_fam,
    (array['preference','about','important'])[1 + (n % 3)],
    labels[1 + (n % 10)] || case when n > 10 then ' #' || n else '' end,
    vals[1 + (n % 10)],
    null,
    (n % 6 = 0),
    v_uid
  from generate_series(1, 30) as n;

  raise notice 'T9 life-events seed complete for family % (44 plans, ~530 items, 30 learned facts).', v_fam;
end $$;

-- ── Verify counts + status/progress spread ──────────────────────────────────
select 'life_event_plans' as tbl, count(*)::text as n from public.life_event_plans
  where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes = '[seed:t9]'
union all
select 'life_event_plan_items', count(*)::text from public.life_event_plan_items i
  where i.plan_id in (select id from public.life_event_plans where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes = '[seed:t9]')
union all
select 'items done', count(*)::text from public.life_event_plan_items i
  where i.is_done and i.plan_id in (select id from public.life_event_plans where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes = '[seed:t9]')
union all
select 'plans by status: ' || status, count(*)::text from public.life_event_plans
  where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and notes = '[seed:t9]' group by status
union all
select 'learned facts', count(*)::text from public.family_facts f
  where f.family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499'
    and exists (select 1 from unnest(array['Friday tradition','Sunday dinner','Bedtime routine','Coffee order','Pizza night','Movie pick','Vacation style','Chore rhythm','Birthday tradition','Screen-time rule']::text[]) l where f.label like l || '%')
order by tbl;
