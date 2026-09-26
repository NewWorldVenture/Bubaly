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
-- policies are generated inside PL/pgSQL loops, e.g. 0328 —
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
  recorded text[] := array[
    -- Measured on a full 345-migration replay. A table joins this list when a
    -- migration narrows its UPDATE or DELETE; it leaves when one widens it. Do
    -- not edit by hand to make this probe pass — the probe IS the measurement,
    -- and a disagreement means the client guard's list needs the same change.
    'ai_conversations', 'ai_messages', 'allowance_rules', 'approval_requests',
    'assistant_links', 'babysitter_payments', 'babysitter_profiles', 'behavior_logs',
    'billing_customers', 'bills', 'budgets', 'call_logs', 'care_log', 'child_logins',
    'child_wallets', 'currency_transactions', 'documents', 'driver_licenses',
    'driving_trips', 'economy_redemptions', 'economy_rewards', 'emergency_sessions',
    'event_rsvps', 'family_ai_settings', 'family_automation_rules',
    'family_automation_runs', 'family_communications', 'family_credentials',
    'family_currencies', 'family_facts', 'family_members', 'family_places',
    'family_wallets', 'financial_accounts', 'front_desk_settings', 'gift_links',
    'gift_payments', 'grades', 'guardian_routing_rules', 'health_goals',
    'health_metrics', 'health_providers', 'health_visits', 'home_briefs',
    'immunizations', 'insurance_policies', 'invest_holdings', 'invest_orders',
    'invites', 'journal_entries', 'library_progress', 'location_events',
    'marketplace_listing_shares', 'marketplace_listings', 'marketplace_offers',
    'marketplace_orders', 'marketplace_stores', 'medical_profiles',
    'medication_schedules', 'medications', 'member_locations', 'notifications',
    'nutrition_logs', 'onboarding_progress', 'opportunities', 'parent_approvals',
    'permission_grants', 'push_devices', 'renewals', 'rewards', 'rides',
    'safety_check_ins', 'savings_goals', 'screen_time_limits', 'sleep_checkins',
    'sleep_logs', 'social_access_permissions', 'social_account_tokens',
    'subscriptions', 'support_tickets', 'symptom_logs', 'sync_tokens',
    'transactions', 'trip_items', 'trips', 'trust_delegations', 'trust_policies',
    'trust_scores', 'wallet_buckets', 'wallet_goals', 'wallet_rules',
    'wallet_transactions'
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
