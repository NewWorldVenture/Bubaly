-- Which tables' RLS can FILTER a legitimate family member's UPDATE or DELETE,
-- asked of the replayed catalog rather than of the migration text.
--
-- ── Why this probe exists ────────────────────────────────────────────────────
--
-- `tests/a-filtered-delete-is-not-a-deletion.test.ts` enforces a client rule:
-- on a table whose policy bites, a write must be family-scoped and must read the
-- row back, because RLS FILTERS a write rather than refusing it and PostgREST
-- answers `error: null` either way. That rule is only as good as the list of
-- tables it is applied to — and that list was hand-written, so it lagged the
-- migrations that kept adding to it.
--
-- Deriving it from the migration SQL was tried three times and cannot work. The
-- third attempt failed STRUCTURALLY rather than by a bug: a large share of these
-- policies are generated inside PL/pgSQL loops, e.g. 0434 —
--
--   execute format('create policy %1$s_mng_update on public.%1$I for update
--                   to authenticated using (public.can_manage_family(family_id))', t);
--
-- so the table the policy applies to is a loop variable and appears nowhere in
-- the `create policy` text. No scanner over *.sql can enumerate them. (The two
-- earlier attempts failed for ordinary reasons worth recording too: a
-- non-greedy `\((.*?)\)` truncated every predicate at its first inner paren, and
-- an `auth.uid` match classed the INLINED spelling of plain family membership as
-- a restriction, which put `concierge_plans`, `trip_plans`, `reminder_lists` and
-- the relationship tables on a list they do not belong on.)
--
-- `pg_policies` on a database with all 345 migrations applied has no such
-- problem: the policy is there, its predicate is normalised, and `permissive`
-- says whether it is ORed or ANDed. This probe is that query, and it FAILS when
-- the answer drifts from the recorded list — which is what keeps the client-side
-- guard's list honest without anyone remembering to update it.
--
-- ── The classification ──────────────────────────────────────────────────────
--
-- A policy is PLAIN when its predicate is exactly "any active member of this
-- family", in either of the two spellings this schema uses: the
-- `is_family_member(family_id)` helper, or the inlined `EXISTS (SELECT 1 FROM
-- family_members …)` that the older migrations wrote by hand. A plain policy
-- cannot filter a legitimate member's write, so reporting success over one is
-- not a lie and demanding a readback there would prove nothing.
--
-- PERMISSIVE policies are ORed, so ONE plain permissive policy is enough to let
-- a member's write through. RESTRICTIVE policies are ANDed, so a narrowing one
-- filters even when a plain permissive policy sits beside it. Both halves are
-- needed: classing a table by "has a narrowing policy" alone would flag every
-- table that carries a manager-only policy next to a plain member one.

do $$
declare
  measured text[];
  -- Three measurements. The first two are this branch's own (92 tables, then 108
  -- after main 7e54596d was merged). The third was taken on the merge of main's
  -- 0344-0380 into PR #548, whose C1-K pass narrowed writes on 32 more —
  -- chore_assignments and chore_submissions, family_messages and
  -- family_conversations, kid_progress, the social_* set, the sync engine's
  -- tables and the rest — recorded here exactly as this probe demands, so the
  -- client guard in tests/a-filtered-delete-is-not-a-deletion.test.ts covers
  -- them too (its KNOWN_UNFIXED records the call sites that measurement
  -- revealed).
  recorded text[] := array[
    -- 0478 (goals) and 0479 (family_reminders, todo_items), 2026-10-10
    'family_reminders', 'goals', 'todo_items',
    -- rls sweep 2026-10-10 (0481)
    'dashboard_layout_events', 'dining_out', 'expense_split_shares', 'family_announcements', 'family_dates',
    'family_food_scores', 'family_poll_options', 'meal_nutrition', 'meal_vote_options', 'meal_votes',
    'medication_doses', 'trip_memories', 'wishlist_items',
    'ai_conversations', 'ai_messages', 'allowance_rules', 'announcement_reads',
    'approval_requests', 'assistant_links', 'autopilot_suggestions',
    'babysitter_payments', 'babysitter_profiles', 'behavior_logs', 'billing_customers',
    'bills', 'budgets', 'call_logs', 'care_log', 'child_logins', 'child_wallets',
    'chore_assignments', 'chore_disputes', 'chore_submissions', 'compliance_disclosures',
    'concierge_calls', 'currency_transactions', 'dashboard_layouts', 'documents',
    'driver_licenses', 'driving_trips', 'economy_redemptions', 'economy_rewards',
    'emergency_sessions', 'event_rsvps', 'family_ai_settings',
    'family_app_installs', 'family_automation_rules', 'family_automation_runs',
    'family_communications',
    'family_conversations', 'family_credentials', 'family_currencies',
    'family_dashboard_settings', 'family_digital_twin_profiles',
    'family_emergency_contacts', 'family_emergency_plans', 'family_facts',
    'family_insurance_policies',
    'family_members', 'family_messages', 'family_places',
    'family_playbook_suggestions', 'family_poll_votes', 'family_stress_predictions', 'family_wallets',
    'financial_accounts', 'front_desk_settings', 'gift_links', 'gift_payments',
    'grades', 'guardian_communications', 'guardian_contacts', 'guardian_member_profiles',
    'guardian_routing_rules', 'guardian_suggestions', 'health_goals', 'health_metrics',
    'health_providers', 'health_visits', 'home_assets', 'home_briefs',
    'household_info', 'immunizations',
    'independence_milestones', 'insurance_policies', 'invest_holdings',
    'invest_orders', 'invites', 'journal_entries', 'kid_progress', 'library_progress',
    'location_events', 'marketplace_follows', 'marketplace_handoffs', 'marketplace_listing_shares',
    'marketplace_listings', 'marketplace_offers', 'marketplace_orders',
    'marketplace_questions', 'marketplace_reviews', 'marketplace_saves',
    'marketplace_stores', 'meal_vote_ballots',
    'medical_profiles', 'medication_schedules', 'medications', 'member_badges',
    'member_locations', 'money_timeline_insights', 'network_consent', 'notifications',
    'nutrition_logs', 'onboarding_progress', 'opportunities', 'parent_approvals',
    'paperwork_items', 'pay_handles', 'permission_grants', 'push_devices', 'renewals',
    'reward_redemptions', 'rewards', 'rides', 'safety_check_ins', 'savings_goals',
    'screen_time_entries', 'screen_time_limits', 'sleep_checkins', 'sleep_logs',
    'social_access_permissions', 'social_accounts',
    'social_ai_generations', 'social_calendar_items', 'social_campaigns',
    'social_comments', 'social_content_templates', 'social_media_library',
    'social_post_assets', 'social_post_targets', 'social_post_variants',
    'social_posts', 'social_publish_jobs', 'social_publish_results',
    'social_schedules', 'social_settings', 'subscriptions', 'subscriptions_tracked', 'support_tickets',
    'symptom_logs', 'sync_accounts', 'sync_external_mappings', 'sync_tokens',
    'tax_documents',
    'transactions', 'trip_items', 'trips', 'trust_delegations', 'trust_policies',
    'trust_scores', 'vacation_activity_logs', 'vacation_activity_tickets',
    'vacation_audit_logs', 'vacation_checklists', 'vacation_destinations',
    'vacation_notifications', 'wallet_buckets', 'wallet_goals', 'wallet_rules',
    'wallet_transactions', 'watchlist_votes'
  ];
  added   text[];
  removed text[];
begin
  with fam as (
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'family_id'
                       and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  pol as (
    select p.tablename as tbl, p.cmd, p.permissive,
           (select bool_and(
              regexp_replace(coalesce(x, 'is_family_member(family_id)'), '\s+', ' ', 'g') ~*
                ('^\(?(is_family_member\(family_id\)|EXISTS \( SELECT 1 FROM family_members '
                 || 'WHERE \(\(family_members\.family_id = ' || p.tablename || '\.family_id\) '
                 || 'AND \(family_members\.user_id = auth\.uid\(\)\) AND family_members\.is_active\)\))\)?$')
            ) from (values (p.qual), (p.with_check)) as v(x)) as plain
    from pg_policies p
    join fam on fam.tbl = p.tablename
    where p.schemaname = 'public' and p.cmd in ('UPDATE', 'DELETE', 'ALL')
  ),
  per_cmd as (
    select tbl, cmd,
      bool_or(permissive = 'PERMISSIVE' and plain)          as has_plain_permissive,
      bool_or(permissive = 'RESTRICTIVE' and not plain)     as has_narrowing_restrictive,
      count(*) filter (where permissive = 'PERMISSIVE')     as permissive_count
    from pol group by tbl, cmd
  )
  select array_agg(distinct tbl order by tbl) into measured
  from per_cmd
  where (permissive_count > 0 and not has_plain_permissive) or has_narrowing_restrictive;

  -- Non-vacuity FIRST. A query that has stopped matching would otherwise report
  -- "no drift" over an empty measurement, which is the failure these probes exist
  -- to avoid — and it is the exact way the three text-scanner attempts went wrong.
  if measured is null or array_length(measured, 1) < 50 then
    raise exception 'Gated-write classification matched % tables, which cannot be right — the query has broken, not the schema.',
      coalesce(array_length(measured, 1), 0);
  end if;
  -- And the two spellings of plain membership must really be recognised, or every
  -- table would look restrictive and the list would be the whole schema.
  if 'concierge_plans' = any(measured) then
    raise exception 'concierge_plans is classed restrictive: the INLINED spelling of plain family membership is no longer recognised.';
  end if;
  if 'reminder_lists' = any(measured) or 'trip_plans' = any(measured) then
    raise exception 'A plain family-membership policy is being read as a restriction — check the helper spelling.';
  end if;

  select array_agg(t order by t) into added
  from unnest(measured) t where not (t = any(recorded));
  select array_agg(t order by t) into removed
  from unnest(recorded) t where not (t = any(measured));

  if added is not null then
    raise exception 'A migration narrowed writes on % table(s) that the client guard does not know about: %. Add them to GATED in tests/a-filtered-delete-is-not-a-deletion.test.ts and to `recorded` here, then give each write site .eq(''family_id'', …) and .select(''id'').',
      array_length(added, 1), array_to_string(added, ', ');
  end if;
  if removed is not null then
    raise exception 'These tables no longer filter a member''s write, so the client rule no longer applies to them: %. Remove them from `recorded` here and from GATED.',
      array_to_string(removed, ', ');
  end if;

  raise notice 'OK: % tables can filter a member''s UPDATE or DELETE, and the recorded list agrees exactly.',
    array_length(measured, 1);
end $$;
