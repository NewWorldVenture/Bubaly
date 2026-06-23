-- ============================================================================
-- FamilyOS / Bubaly — full database seed (fake data, >=500 rows per table)
-- Generated for local/dev/staging use. DO NOT run against production.
--
-- Strategy: one PL/pgSQL block. Parent tables are seeded first and their ids
-- captured into arrays so child foreign keys reference real rows. Every insert
-- is wrapped in its own sub-block so a single failure cannot abort the run, and
-- uses ON CONFLICT DO NOTHING so unique constraints are respected. Re-running is
-- safe: the preamble truncates all seeded tables first.
--
-- USAGE (local / staging only):
--   supabase db reset          # applies migrations, then run this file, OR
--   psql "$DATABASE_URL" -f supabase/seed_full.sql
-- Seeded login accounts: person<N>@seed.bubaly.test / Password123!
--
-- Coverage: 216 tables seeded with 500 rows each. Five tables hold fewer
-- rows by design and cannot reach 500: roles / social_providers / sync_providers
-- (enum-keyed lookup tables, bounded by enum cardinality) and loyalty_settings /
-- reputation_settings (singleton config tables).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- crypt()/gen_salt() for auth.users
SET session_replication_role = replica;  -- defer FK/trigger overhead during bulk load

-- Reset: clear all public tables and previously seeded auth users -----------
TRUNCATE TABLE public.ab_events, public.ab_experiments, public.admin_integrations, public.affiliate_referrals, public.affiliates, public.ai_conversations, public.ai_messages, public.announcement_reads, public.app_settings, public.appointments, public.audit_logs, public.auto_ai_logs, public.auto_insurance_policies, public.auto_service_records, public.badges, public.billing_customers, public.bills, public.blog_posts, public.budgets, public.calendar_events, public.calendar_feeds, public.care_log, public.case_studies, public.checkout_sessions, public.chore_ai_validations, public.chore_approval_events, public.chore_assignments, public.chore_disputes, public.chore_submissions, public.chores, public.crm_contacts, public.crm_deals, public.crm_quotes, public.display_layouts, public.documents, public.driver_licenses, public.event_rsvps, public.families, public.family_ai_recommendations, public.family_albums, public.family_announcements, public.family_automation_rules, public.family_automation_runs, public.family_contacts, public.family_conversations, public.family_dates, public.family_digital_twin_profiles, public.family_emergency_contacts, public.family_emergency_plans, public.family_knowledge_edges, public.family_knowledge_nodes, public.family_members, public.family_memories, public.family_messages, public.family_milestones, public.family_onboarding, public.family_photos, public.family_places, public.family_recipes, public.family_reminders, public.family_routines, public.family_stress_predictions, public.family_stress_signals, public.financial_accounts, public.game_results, public.goals, public.grades, public.grocery_items, public.grocery_lists, public.health_metrics, public.health_providers, public.health_visits, public.home_ai_logs, public.home_assets, public.home_contractors, public.home_service_records, public.home_warranties, public.homes, public.homework_assignments, public.insurance_policies, public.invites, public.kid_progress, public.location_events, public.loyalty_accounts, public.loyalty_redemptions, public.loyalty_rewards, public.loyalty_settings, public.loyalty_transactions, public.maintenance_tasks, public.marketing_ad_campaigns, public.marketing_aeo_questions, public.marketing_assets, public.marketing_audit_logs, public.marketing_automation_runs, public.marketing_automation_workflows, public.marketing_campaigns, public.marketing_content_items, public.marketing_email_campaigns, public.marketing_exit_intent, public.marketing_form_submissions, public.marketing_forms, public.marketing_funnels, public.marketing_landing_pages, public.marketing_personalization_rules, public.marketing_push_campaigns, public.marketing_segments, public.marketing_seo_keywords, public.marketing_seo_pages, public.marketing_settings, public.marketing_sms_campaigns, public.marketing_social_posts, public.marketing_suppressions, public.marketing_videos, public.meal_plans, public.meal_vote_ballots, public.meal_vote_options, public.meal_votes, public.meals, public.medical_profiles, public.medication_doses, public.medication_schedules, public.medications, public.member_badges, public.member_locations, public.mkt_sessions, public.mkt_touchpoints, public.mkt_visitors, public.notes, public.notifications, public.opportunities, public.permissions, public.profiles, public.push_devices, public.referral_codes, public.referrals, public.reminders, public.renewals, public.rental_cars, public.reputation_settings, public.reviews, public.reward_redemptions, public.rewards, public.rides, public.roles, public.savings_goals, public.school_classes, public.school_events, public.social_access_permissions, public.social_account_tokens, public.social_accounts, public.social_ai_generations, public.social_analytics_snapshots, public.social_audit_logs, public.social_calendar_items, public.social_campaigns, public.social_comments, public.social_content_templates, public.social_feed_items, public.social_media_library, public.social_messages, public.social_post_assets, public.social_post_targets, public.social_post_variants, public.social_posts, public.social_provider_errors, public.social_providers, public.social_publish_jobs, public.social_publish_results, public.social_schedules, public.social_settings, public.social_usage_events, public.social_webhook_events, public.sports_events, public.subscriptions, public.super_admins, public.support_tickets, public.survey_responses, public.surveys, public.sync_accounts, public.sync_audit_logs, public.sync_calendar_events, public.sync_calendar_shares, public.sync_calendars, public.sync_change_logs, public.sync_conflict_resolutions, public.sync_conflicts, public.sync_connections, public.sync_event_attendees, public.sync_external_mappings, public.sync_job_runs, public.sync_jobs, public.sync_note_folders, public.sync_notes, public.sync_provider_errors, public.sync_providers, public.sync_reminder_lists, public.sync_reminders, public.sync_settings, public.sync_tokens, public.sync_webhook_events, public.system_backups, public.teams, public.testimonials, public.todo_items, public.todo_lists, public.transactions, public.trip_items, public.trips, public.user_preferences, public.vehicle_inspections, public.vehicle_registrations, public.vehicles, public.weather_locations, public.wishlist_items, public.workout_logs RESTART IDENTITY CASCADE;
DELETE FROM auth.users WHERE email LIKE '%@seed.bubaly.test';

DO $$
DECLARE
  a_auth_users uuid[];
  a_affiliates uuid[];
  a_ai_conversations uuid[];
  a_badges text[];
  a_billing_customers uuid[];
  a_calendar_events uuid[];
  a_calendar_feeds uuid[];
  a_chore_assignments uuid[];
  a_chore_submissions uuid[];
  a_chores uuid[];
  a_crm_contacts uuid[];
  a_crm_deals uuid[];
  a_documents uuid[];
  a_families uuid[];
  a_family_albums uuid[];
  a_family_announcements uuid[];
  a_family_automation_rules uuid[];
  a_family_conversations uuid[];
  a_family_knowledge_nodes uuid[];
  a_family_members uuid[];
  a_family_messages uuid[];
  a_family_places uuid[];
  a_family_recipes uuid[];
  a_financial_accounts uuid[];
  a_grocery_lists uuid[];
  a_health_providers uuid[];
  a_home_assets uuid[];
  a_home_contractors uuid[];
  a_homes uuid[];
  a_loyalty_rewards uuid[];
  a_marketing_automation_workflows uuid[];
  a_marketing_campaigns uuid[];
  a_marketing_email_campaigns uuid[];
  a_marketing_forms uuid[];
  a_marketing_segments uuid[];
  a_meal_vote_options uuid[];
  a_meal_votes uuid[];
  a_meals uuid[];
  a_medication_schedules uuid[];
  a_medications uuid[];
  a_mkt_visitors uuid[];
  a_rewards uuid[];
  a_roles "member_role"[];
  a_school_classes uuid[];
  a_social_accounts uuid[];
  a_social_campaigns uuid[];
  a_social_feed_items uuid[];
  a_social_media_library uuid[];
  a_social_post_targets uuid[];
  a_social_posts uuid[];
  a_social_providers "social_platform"[];
  a_social_publish_jobs uuid[];
  a_survey_responses uuid[];
  a_surveys uuid[];
  a_sync_accounts uuid[];
  a_sync_calendar_events uuid[];
  a_sync_calendars uuid[];
  a_sync_conflicts uuid[];
  a_sync_jobs uuid[];
  a_sync_note_folders uuid[];
  a_sync_providers "sync_provider"[];
  a_sync_reminder_lists uuid[];
  a_teams uuid[];
  a_todo_lists uuid[];
  a_trips uuid[];
  a_vehicles uuid[];
BEGIN

  -- auth.users (login accounts) ------------------------------------------------
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
    SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'person'||g||'@seed.bubaly.test', crypt('Password123!', gen_salt('bf')), now(), now()-(random()*365||' days')::interval, now(),
           '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name','Test User '||g), false, false
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg(id) INTO a_auth_users FROM auth.users WHERE email LIKE '%@seed.bubaly.test';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip auth.users: %', SQLERRM; END;

  -- ab_events (6 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."ab_events" ("id", "experiment_key", "variant_key", "kind", "visitor_id", "created_at")
    SELECT gen_random_uuid(), ('ab_eve'||'-'||g||'-'||floor(random()*100000)::int), ('ab_eve'||'-'||g||'-'||floor(random()*100000)::int), (ARRAY['exposure','conversion'])[1+floor(random()*2)::int], ('visitor_id'||' '||g), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip ab_events: %', SQLERRM; END;

  -- ab_experiments (13 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."ab_experiments" ("id", "key", "name", "hypothesis", "status", "variants", "metric", "winner", "created_by", "updated_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('key'||'-'||g||'-'||'ab_e'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('hypothesis'||' '||g), (ARRAY['draft','running','paused','completed'])[1+floor(random()*4)::int], jsonb_build_object('seed', g, 'note', 'sample'), ('metric'||' '||g), ('winner'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip ab_experiments: %', SQLERRM; END;

  -- admin_integrations (12 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."admin_integrations" ("id", "key", "name", "description", "category", "status", "config", "last_sync_at", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('key'||'-'||g||'-'||'admi'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'admin integrations'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip admin_integrations: %', SQLERRM; END;

  -- affiliates (10 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."affiliates" ("id", "name", "email", "code", "commission_rate", "status", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('person'||g||'@example.com'), ('code'||'-'||g||'-'||'affi'), round((random()*5000)::numeric,2), (ARRAY['active','paused'])[1+floor(random()*2)::int], ('Sample '||'affiliates'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_affiliates FROM public."affiliates";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip affiliates: %', SQLERRM; END;

  -- app_settings (4 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."app_settings" ("key", "value", "updated_by", "updated_at")
    SELECT ('app_se'||'-'||g||'-'||floor(random()*100000)::int), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip app_settings: %', SQLERRM; END;

  -- badges (6 cols) ------------------------------------------------------
  BEGIN
    INSERT INTO public."badges" ("id", "name", "description", "icon", "sort", "created_at")
    SELECT ('id'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'badges'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), floor(random()*100)::int, (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_badges FROM public."badges";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip badges: %', SQLERRM; END;

  -- blog_posts (15 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."blog_posts" ("id", "slug", "title", "excerpt", "author", "published_at", "reading_minutes", "tags", "category", "featured", "accent_color", "body", "published", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('slug'||'-'||g||'-'||'blog'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('excerpt'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (current_date - (floor(random()*730)-365)::int), floor(random()*100)::int, ARRAY['item'||g, 'item'||(g+1)], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (random()<0.5), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], jsonb_build_object('seed', g, 'note', 'sample'), (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip blog_posts: %', SQLERRM; END;

  -- case_studies (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."case_studies" ("id", "title", "slug", "industry", "customer_name", "summary", "body", "result_metric", "is_published", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('slug'||'-'||g||'-'||'case'), ('industry'||' '||g), ('customer_name'||' '||g), ('Sample '||'case studies'||' content generated for testing purposes. Row '||g||'.'), ('Sample '||'case studies'||' content generated for testing purposes. Row '||g||'.'), ('result_metric'||' '||g), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip case_studies: %', SQLERRM; END;

  -- families (7 cols) ----------------------------------------------------
  BEGIN
    INSERT INTO public."families" ("id", "name", "avatar_url", "timezone", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'])[1+floor(random()*4)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_families FROM public."families";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip families: %', SQLERRM; END;

  -- loyalty_rewards (15 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."loyalty_rewards" ("id", "name", "description", "cost_points", "kind", "value_cents", "image_url", "stock", "is_active", "sort", "created_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'loyalty rewards'||' content generated for testing purposes. Row '||g||'.'), floor(random()*1000)::int, (ARRAY['credit','free_month','discount','swag','donation','custom'])[1+floor(random()*6)::int], floor(random()*500000)::int, ('https://picsum.photos/seed/'||g||'/400'), floor(random()*1000)::int, (random()<0.5), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_loyalty_rewards FROM public."loyalty_rewards";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip loyalty_rewards: %', SQLERRM; END;

  -- loyalty_settings (15 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."loyalty_settings" ("id", "singleton", "enabled", "program_name", "points_label", "earn_signup", "earn_referral", "earn_review", "earn_per_dollar", "tier_silver_at", "tier_gold_at", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), (random()<0.5), (random()<0.5), ('program_name'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, round((random()*1000)::numeric,2), floor(random()*1000)::int, floor(random()*1000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip loyalty_settings: %', SQLERRM; END;

  -- marketing_aeo_questions (13 cols) -------------------------------------
  BEGIN
    INSERT INTO public."marketing_aeo_questions" ("id", "question", "answer", "entity", "source_path", "pattern", "status", "clarity_score", "last_reviewed", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('question'||' '||g), ('answer'||' '||g), ('entity'||' '||g), ('source_path'||' '||g), (ARRAY['what_is','how_to','best_x_for_y','comparison','faq','local'])[1+floor(random()*6)::int], (ARRAY['opportunity','drafting','answered','published'])[1+floor(random()*4)::int], (0+floor(random()*101)::int), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_aeo_questions: %', SQLERRM; END;

  -- marketing_assets (15 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."marketing_assets" ("id", "name", "kind", "storage_path", "mime_type", "size_bytes", "width", "height", "alt_text", "tags", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['image','video','document','brand'])[1+floor(random()*4)::int], ('storage_path'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, ('Sample '||'marketing assets'||' content generated for testing purposes. Row '||g||'.'), ARRAY['item'||g, 'item'||(g+1)], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_assets: %', SQLERRM; END;

  -- marketing_audit_logs (8 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."marketing_audit_logs" ("id", "actor_id", "actor_email", "action", "resource", "resource_id", "metadata", "created_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('person'||g||'@example.com'), ('action'||' '||g), ('resource'||' '||g), ('resource_id'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_audit_logs: %', SQLERRM; END;

  -- marketing_automation_workflows (12 cols) ------------------------------
  BEGIN
    INSERT INTO public."marketing_automation_workflows" ("id", "name", "trigger", "steps", "status", "run_count", "metadata", "created_by", "updated_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('trigger'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['draft','active','paused','archived'])[1+floor(random()*4)::int], floor(random()*100)::int, jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_marketing_automation_workflows FROM public."marketing_automation_workflows";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_automation_workflows: %', SQLERRM; END;

  -- marketing_exit_intent (17 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."marketing_exit_intent" ("id", "name", "headline", "body", "cta_label", "cta_href", "match", "trigger_config", "priority", "status", "impressions", "conversions", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'marketing exit intent'||' content generated for testing purposes. Row '||g||'.'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('https://picsum.photos/seed/'||g||'/400'), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (1+floor(random()*5)::int), (ARRAY['active','paused'])[1+floor(random()*2)::int], floor(random()*1000)::int, floor(random()*1000)::int, jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_exit_intent: %', SQLERRM; END;

  -- marketing_funnels (9 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."marketing_funnels" ("id", "name", "steps", "status", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','archived'])[1+floor(random()*2)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_funnels: %', SQLERRM; END;

  -- marketing_personalization_rules (12 cols) -----------------------------
  BEGIN
    INSERT INTO public."marketing_personalization_rules" ("id", "name", "slot", "match", "variant", "priority", "status", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('slot'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (1+floor(random()*5)::int), (ARRAY['active','paused'])[1+floor(random()*2)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_personalization_rules: %', SQLERRM; END;

  -- marketing_segments (13 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."marketing_segments" ("id", "name", "description", "kind", "rules", "member_keys", "status", "metadata", "created_by", "updated_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'marketing segments'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['dynamic','static'])[1+floor(random()*2)::int], jsonb_build_object('seed', g, 'note', 'sample'), ARRAY['item'||g, 'item'||(g+1)], (ARRAY['active','archived'])[1+floor(random()*2)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_marketing_segments FROM public."marketing_segments";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_segments: %', SQLERRM; END;

  -- marketing_seo_keywords (10 cols) --------------------------------------
  BEGIN
    INSERT INTO public."marketing_seo_keywords" ("id", "keyword", "intent", "target_path", "source", "status", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('keyword'||'-'||g||'-'||'mark'), (ARRAY['informational','navigational','commercial','transactional'])[1+floor(random()*4)::int], ('target_path'||'-'||g||'-'||'mark'), (ARRAY['manual','ai_suggestion','search_console'])[1+floor(random()*3)::int], (ARRAY['idea','tracking','won','dropped'])[1+floor(random()*4)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_seo_keywords: %', SQLERRM; END;

  -- marketing_seo_pages (11 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."marketing_seo_pages" ("id", "path", "title", "meta_description", "issues", "score", "status", "last_audited_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('path'||'-'||g||'-'||'mark'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'marketing seo pages'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), (0+floor(random()*101)::int), (ARRAY['active','noindex','archived'])[1+floor(random()*3)::int], (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_seo_pages: %', SQLERRM; END;

  -- marketing_settings (4 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."marketing_settings" ("key", "value", "updated_by", "updated_at")
    SELECT ('market'||'-'||g||'-'||floor(random()*100000)::int), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_settings: %', SQLERRM; END;

  -- marketing_videos (17 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."marketing_videos" ("id", "title", "provider", "video_id", "url", "storage_path", "poster_url", "captions_url", "transcript", "duration_seconds", "status", "tags", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['youtube','vimeo','upload'])[1+floor(random()*3)::int], ('video_id'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('storage_path'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ('transcript'||' '||g), floor(random()*100)::int, (ARRAY['draft','published'])[1+floor(random()*2)::int], ARRAY['item'||g, 'item'||(g+1)], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_videos: %', SQLERRM; END;

  -- profiles (9 cols) ----------------------------------------------------
  BEGIN
    INSERT INTO public."profiles" ("id", "email", "full_name", "display_name", "avatar_url", "date_of_birth", "phone", "created_at", "updated_at")
    SELECT a_auth_users[g], ('person'||g||'@example.com'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), (current_date - (floor(random()*730)-365)::int), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip profiles: %', SQLERRM; END;

  -- reputation_settings (16 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."reputation_settings" ("id", "singleton", "google_url", "app_store_url", "play_store_url", "trustpilot_url", "request_headline", "request_message", "thank_you_high", "thank_you_low", "min_public_rating", "auto_approve_min", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), (random()<0.5), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'reputation settings'||' content generated for testing purposes. Row '||g||'.'), ('thank_you_high'||' '||g), ('thank_you_low'||' '||g), (1+floor(random()*5)::int), (1+floor(random()*5)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip reputation_settings: %', SQLERRM; END;

  -- roles (3 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."roles" ("role", "label", "description")
    SELECT (ARRAY['adult','parent','teen','child','caregiver'])[1+floor(random()*5)::int]::"member_role", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'roles'||' content generated for testing purposes. Row '||g||'.')
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("role") INTO a_roles FROM public."roles";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip roles: %', SQLERRM; END;

  -- social_providers (11 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."social_providers" ("platform", "label", "capabilities", "auth_method", "is_enabled", "needs_app_review", "char_limit", "docs_url", "notes", "created_at", "updated_at")
    SELECT (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), jsonb_build_object('seed', g, 'note', 'sample'), ('auth_method'||' '||g), (random()<0.5), (random()<0.5), floor(random()*1000)::int, ('https://picsum.photos/seed/'||g||'/400'), ('Sample '||'social providers'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("platform") INTO a_social_providers FROM public."social_providers";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_providers: %', SQLERRM; END;

  -- super_admins (2 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."super_admins" ("email", "created_at")
    SELECT ('person'||g||'@example.com'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip super_admins: %', SQLERRM; END;

  -- support_tickets (9 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."support_tickets" ("id", "name", "email", "subject", "message", "status", "source", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('person'||g||'@example.com'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'support tickets'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['open','pending','resolved','closed'])[1+floor(random()*4)::int], ('source'||' '||g), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip support_tickets: %', SQLERRM; END;

  -- surveys (18 cols) -----------------------------------------------------
  BEGIN
    INSERT INTO public."surveys" ("id", "slug", "name", "type", "question", "scale_min", "scale_max", "low_label", "high_label", "follow_up_question", "thank_you_message", "status", "audience", "created_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('slug'||'-'||g||'-'||'surv'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['nps','csat','ces','custom'])[1+floor(random()*4)::int], ('question'||' '||g), floor(random()*1000)::int, floor(random()*1000)::int, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('follow_up_question'||' '||g), ('Sample '||'surveys'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['draft','active','closed'])[1+floor(random()*3)::int], ('audience'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_surveys FROM public."surveys";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip surveys: %', SQLERRM; END;

  -- sync_providers (9 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."sync_providers" ("provider", "label", "capabilities", "auth_kind", "is_enabled", "docs_url", "notes", "created_at", "updated_at")
    SELECT (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (random()<0.5), ('https://picsum.photos/seed/'||g||'/400'), ('Sample '||'sync providers'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("provider") INTO a_sync_providers FROM public."sync_providers";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_providers: %', SQLERRM; END;

  -- system_backups (10 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."system_backups" ("id", "label", "kind", "status", "size_bytes", "location", "row_counts", "created_by", "created_at", "metadata")
    SELECT gen_random_uuid(), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*1000)::int, (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample')
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip system_backups: %', SQLERRM; END;

  -- testimonials (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."testimonials" ("id", "author_name", "author_role", "company", "quote", "rating", "avatar_url", "is_published", "sort_order", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('company'||' '||g), ('quote'||' '||g), (1+floor(random()*5)::int), ('https://picsum.photos/seed/'||g||'/400'), (random()<0.5), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip testimonials: %', SQLERRM; END;

  -- affiliate_referrals (10 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."affiliate_referrals" ("id", "affiliate_id", "referred_email", "family_id", "status", "amount_cents", "commission_cents", "converted_at", "paid_at", "created_at")
    SELECT gen_random_uuid(), a_affiliates[1+floor(random()*GREATEST(array_length(a_affiliates,1),1))::int], ('person'||g||'@example.com'), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, (ARRAY['pending','converted','paid','void'])[1+floor(random()*4)::int], floor(random()*500000)::int, floor(random()*500000)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip affiliate_referrals: %', SQLERRM; END;

  -- ai_conversations (8 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."ai_conversations" ("id", "family_id", "user_id", "title", "provider", "model", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('provider'||' '||g), ('model'||' '||g), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_ai_conversations FROM public."ai_conversations";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip ai_conversations: %', SQLERRM; END;

  -- audit_logs (8 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."audit_logs" ("id", "family_id", "actor_id", "action", "resource", "resource_id", "metadata", "created_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('action'||' '||g), ('resource'||' '||g), gen_random_uuid(), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip audit_logs: %', SQLERRM; END;

  -- billing_customers (6 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."billing_customers" ("id", "family_id", "provider", "customer_ref", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], ('provider'||' '||g), ('billin'||'-'||g||'-'||floor(random()*100000)::int), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_billing_customers FROM public."billing_customers";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip billing_customers: %', SQLERRM; END;

  -- bills (12 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."bills" ("id", "family_id", "name", "amount", "due_date", "is_recurring", "recurrence", "status", "category", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), round((random()*5000)::numeric,2), (current_date - (floor(random()*730)-365)::int), (random()<0.5), ('recurrence'||' '||g), (ARRAY['upcoming','paid','overdue'])[1+floor(random()*3)::int]::"bill_status", (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip bills: %', SQLERRM; END;

  -- budgets (8 cols) -----------------------------------------------------
  BEGIN
    INSERT INTO public."budgets" ("id", "family_id", "category", "amount", "period", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], round((random()*5000)::numeric,2), (ARRAY['weekly','monthly','yearly'])[1+floor(random()*3)::int]::"budget_period", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip budgets: %', SQLERRM; END;

  -- calendar_feeds (12 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."calendar_feeds" ("id", "family_id", "name", "url", "color", "last_status", "last_error", "last_synced_at", "event_count", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('last_error'||' '||g), (now() - (random()*365||' days')::interval), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_calendar_feeds FROM public."calendar_feeds";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip calendar_feeds: %', SQLERRM; END;

  -- checkout_sessions (10 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."checkout_sessions" ("id", "session_id", "family_id", "email", "name", "plan", "status", "created_at", "completed_at", "abandoned_at")
    SELECT gen_random_uuid(), ('session_id'||'-'||g||'-'||'chec'), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, ('person'||g||'@example.com'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('plan'||' '||g), (ARRAY['pending','completed','abandoned'])[1+floor(random()*3)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip checkout_sessions: %', SQLERRM; END;

  -- chores (28 cols) ------------------------------------------------------
  BEGIN
    INSERT INTO public."chores" ("id", "family_id", "title", "description", "points", "priority", "recurrence", "due_at", "requires_approval", "created_by", "created_at", "updated_at", "category", "difficulty", "est_minutes", "proof_required", "reward_mode", "cash_cents", "cash_min_cents", "cash_max_cents", "points_min", "points_max", "auto_approve_score", "safety_level", "instructions", "example_image_url", "icon", "is_active")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'chores'||' content generated for testing purposes. Row '||g||'.'), floor(random()*100)::int, (ARRAY['low','medium','high','urgent'])[1+floor(random()*4)::int]::"priority", (ARRAY['none','daily','weekly','monthly','yearly'])[1+floor(random()*5)::int]::"recurrence_freq", (now() + (random()*60||' days')::interval), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['easy','medium','hard'])[1+floor(random()*3)::int], floor(random()*100)::int, (ARRAY['none','photo','video','before_after'])[1+floor(random()*4)::int], (ARRAY['fixed_cash','fixed_points','ai_cash','ai_points','prize','responsibility'])[1+floor(random()*6)::int], floor(random()*500000)::int, floor(random()*500000)::int, floor(random()*500000)::int, floor(random()*100)::int, floor(random()*100)::int, (1+floor(random()*5)::int), (ARRAY['none','caution','parent_required'])[1+floor(random()*3)::int], ('instructions'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), (random()<0.5)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_chores FROM public."chores";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chores: %', SQLERRM; END;

  -- crm_contacts (15 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."crm_contacts" ("id", "first_name", "last_name", "email", "phone", "company", "lead_status", "lifecycle_stage", "lead_source", "family_id", "owner_id", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), (ARRAY['Liam','Olivia','Noah','Emma','Ava','Sophia','Mason','Ethan','Mia','Lucas','Amelia','Harper'])[1+floor(random()*12)::int], (ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Lopez','Wilson'])[1+floor(random()*10)::int], ('person'||g||'@example.com'), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('company'||' '||g), (ARRAY['new','working','qualified','unqualified','customer'])[1+floor(random()*5)::int], (ARRAY['subscriber','lead','mql','sql','opportunity','customer','evangelist'])[1+floor(random()*7)::int], ('lead_source'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('Sample '||'crm contacts'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_crm_contacts FROM public."crm_contacts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip crm_contacts: %', SQLERRM; END;

  -- display_layouts (6 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."display_layouts" ("id", "family_id", "tiles", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip display_layouts: %', SQLERRM; END;

  -- family_albums (11 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."family_albums" ("id", "family_id", "name", "description", "cover_url", "kind", "is_shared", "photo_count", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'family albums'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['general','vacation','school','sports','milestones','holiday','birthday','other'])[1+floor(random()*8)::int], (random()<0.5), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_albums FROM public."family_albums";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_albums: %', SQLERRM; END;

  -- family_automation_rules (16 cols) -------------------------------------
  BEGIN
    INSERT INTO public."family_automation_rules" ("id", "family_id", "name", "trigger_type", "trigger_config", "action_type", "action_config", "is_enabled", "requires_approval", "last_run_at", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), (random()<0.5), (random()<0.5), (now() - (random()*365||' days')::interval), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_automation_rules FROM public."family_automation_rules";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_automation_rules: %', SQLERRM; END;

  -- family_conversations (11 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."family_conversations" ("id", "family_id", "name", "kind", "avatar_emoji", "member_ids", "created_by", "last_message_at", "created_at", "updated_at", "participant_ids")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['group','direct'])[1+floor(random()*2)::int], ('https://picsum.photos/seed/'||g||'/400'), ARRAY[gen_random_uuid()], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), ARRAY[gen_random_uuid()]
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_conversations FROM public."family_conversations";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_conversations: %', SQLERRM; END;

  -- family_emergency_plans (14 cols) --------------------------------------
  BEGIN
    INSERT INTO public."family_emergency_plans" ("id", "family_id", "title", "plan_type", "content", "safe_location", "instructions", "is_active", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('Sample '||'family emergency plans'||' content generated for testing purposes. Row '||g||'.'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), ('instructions'||' '||g), (random()<0.5), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_emergency_plans: %', SQLERRM; END;

  -- family_members (10 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."family_members" ("id", "family_id", "user_id", "role", "display_name", "color", "birthday", "is_active", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], a_auth_users[1+((g-1+0) % GREATEST(array_length(a_auth_users,1),1))], (ARRAY['adult','parent','teen','child','caregiver'])[1+floor(random()*5)::int]::"member_role", ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], (current_date - (floor(random()*730)-365)::int), (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_members FROM public."family_members";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_members: %', SQLERRM; END;

  -- family_onboarding (16 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."family_onboarding" ("id", "family_id", "household_adults", "household_children", "child_ages", "region", "postal_code", "country", "goals", "referral_source", "referral_detail", "completed_at", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], (0+floor(random()*21)::int), (0+floor(random()*21)::int), ARRAY[floor(random()*100)::int], (ARRAY['CA','TX','NY','WA','CO','FL','IL','MA'])[1+floor(random()*8)::int], ('family'||'-'||g||'-'||floor(random()*100000)::int), (ARRAY['USA','Canada','UK','Australia'])[1+floor(random()*4)::int], ARRAY['item'||g, 'item'||(g+1)], (ARRAY['search','friend_family','social','app_store','blog','ad','podcast','other'])[1+floor(random()*8)::int], ('family'||'-'||g||'-'||floor(random()*100000)::int), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_onboarding: %', SQLERRM; END;

  -- family_places (11 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."family_places" ("id", "family_id", "name", "icon", "address", "latitude", "longitude", "radius_m", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), round((random()*180-90)::numeric,6), round((random()*360-180)::numeric,6), floor(random()*1000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_places FROM public."family_places";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_places: %', SQLERRM; END;

  -- family_recipes (33 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."family_recipes" ("id", "family_id", "name", "description", "category", "cuisine", "servings", "prep_time_mins", "cook_time_mins", "difficulty", "ingredients", "instructions", "notes", "photo_url", "tags", "allergy_flags", "is_favorite", "is_public", "rating", "times_made", "last_made_at", "source_url", "ai_generated", "estimated_cost_cents", "created_by", "created_at", "updated_at", "source_provider", "source_recipe_id", "attribution", "license_notes", "imported_at", "raw_payload")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'family recipes'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['breakfast','lunch','dinner','snack','dessert','drink','side','appetizer','other'])[1+floor(random()*9)::int], ('cuisine'||' '||g), floor(random()*100)::int, floor(random()*1000)::int, floor(random()*1000)::int, (ARRAY['easy','medium','hard'])[1+floor(random()*3)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('Sample '||'family recipes'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), ARRAY['item'||g, 'item'||(g+1)], ARRAY['item'||g, 'item'||(g+1)], (random()<0.5), (random()<0.5), (1+floor(random()*5)::int), floor(random()*1000)::int, (now() - (random()*365||' days')::interval), ('https://picsum.photos/seed/'||g||'/400'), (random()<0.5), floor(random()*500000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), ('source_provider'||' '||g), ('source_recipe_id'||' '||g), ('attribution'||' '||g), ('Sample '||'family recipes'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample')
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_recipes FROM public."family_recipes";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_recipes: %', SQLERRM; END;

  -- family_stress_predictions (12 cols) -----------------------------------
  BEGIN
    INSERT INTO public."family_stress_predictions" ("id", "family_id", "for_date", "score", "level", "factors", "suggestions", "status", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (current_date - (floor(random()*730)-365)::int), (1+floor(random()*5)::int), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_stress_predictions: %', SQLERRM; END;

  -- financial_accounts (11 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."financial_accounts" ("id", "family_id", "name", "type", "institution", "last_four", "balance", "currency", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['checking','savings','credit','investment','retirement'])[1+floor(random()*5)::int]::"account_type", ('institution'||' '||g), ('last_four'||' '||g), round((random()*5000)::numeric,2), (ARRAY['USD','EUR','GBP','CAD'])[1+floor(random()*4)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_financial_accounts FROM public."financial_accounts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip financial_accounts: %', SQLERRM; END;

  -- goals (10 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."goals" ("id", "family_id", "title", "description", "target_date", "progress", "is_complete", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'goals'||' content generated for testing purposes. Row '||g||'.'), (current_date - (floor(random()*730)-365)::int), floor(random()*1000)::int, (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip goals: %', SQLERRM; END;

  -- grocery_lists (12 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."grocery_lists" ("id", "family_id", "name", "is_archived", "created_by", "created_at", "updated_at", "store", "list_icon", "list_color", "sort_order", "archived_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), ('store'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], floor(random()*100)::int, (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_grocery_lists FROM public."grocery_lists";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip grocery_lists: %', SQLERRM; END;

  -- home_contractors (19 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."home_contractors" ("id", "family_id", "name", "trade", "company", "phone", "email", "website", "rating", "hourly_rate", "is_preferred", "last_used_on", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('trade'||' '||g), ('company'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('person'||g||'@example.com'), ('https://picsum.photos/seed/'||g||'/400'), (1+floor(random()*5)::int), round((random()*5000)::numeric,2), (random()<0.5), (current_date - (floor(random()*730)-365)::int), ('Sample '||'home contractors'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_home_contractors FROM public."home_contractors";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip home_contractors: %', SQLERRM; END;

  -- homes (18 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."homes" ("id", "family_id", "name", "address", "home_type", "year_built", "square_feet", "bedrooms", "bathrooms", "purchase_date", "is_primary", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (2015+floor(random()*12)::int), floor(random()*1000)::int, floor(random()*1000)::int, round((random()*1000)::numeric,2), (current_date - (floor(random()*730)-365)::int), (random()<0.5), ('Sample '||'homes'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_homes FROM public."homes";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip homes: %', SQLERRM; END;

  -- invites (11 cols) -----------------------------------------------------
  BEGIN
    INSERT INTO public."invites" ("id", "family_id", "email", "role", "token", "status", "invited_by", "expires_at", "accepted_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ('person'||g||'@example.com'), (ARRAY['adult','parent','teen','child','caregiver'])[1+floor(random()*5)::int]::"member_role", ('token'||'-'||g||'-'||'invi'), (ARRAY['pending','accepted','expired','revoked'])[1+floor(random()*4)::int]::"invite_status", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() + (random()*60||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip invites: %', SQLERRM; END;

  -- loyalty_accounts (9 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."loyalty_accounts" ("id", "family_id", "points_balance", "lifetime_points", "tier", "joined_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], floor(random()*500000)::int, floor(random()*100)::int, ('tier'||' '||g), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip loyalty_accounts: %', SQLERRM; END;

  -- loyalty_redemptions (14 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."loyalty_redemptions" ("id", "family_id", "reward_id", "reward_name", "cost_points", "status", "code", "fulfilled_at", "fulfilled_by", "notes", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_loyalty_rewards[1+floor(random()*GREATEST(array_length(a_loyalty_rewards,1),1))::int] END, ('reward_name'||' '||g), floor(random()*500000)::int, (ARRAY['pending','fulfilled','cancelled'])[1+floor(random()*3)::int], ('loyalt'||'-'||g||'-'||floor(random()*100000)::int), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('Sample '||'loyalty redemptions'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip loyalty_redemptions: %', SQLERRM; END;

  -- loyalty_transactions (12 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."loyalty_transactions" ("id", "family_id", "points", "kind", "reason", "source", "balance_after", "reward_id", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], floor(random()*100)::int, (ARRAY['earn','redeem','adjust','expire'])[1+floor(random()*4)::int], ('Sample '||'loyalty transactions'||' content generated for testing purposes. Row '||g||'.'), ('source'||' '||g), floor(random()*500000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_loyalty_rewards[1+floor(random()*GREATEST(array_length(a_loyalty_rewards,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip loyalty_transactions: %', SQLERRM; END;

  -- marketing_automation_runs (6 cols) -----------------------------------
  BEGIN
    INSERT INTO public."marketing_automation_runs" ("id", "workflow_id", "status", "subject_key", "metadata", "created_at")
    SELECT gen_random_uuid(), a_marketing_automation_workflows[1+floor(random()*GREATEST(array_length(a_marketing_automation_workflows,1),1))::int], (ARRAY['running','completed','failed'])[1+floor(random()*3)::int], ('market'||'-'||g||'-'||floor(random()*100000)::int), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_automation_runs: %', SQLERRM; END;

  -- marketing_campaigns (18 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."marketing_campaigns" ("id", "name", "objective", "channel", "type", "status", "segment_id", "budget_cents", "starts_at", "ends_at", "notes", "kpis", "metadata", "created_by", "updated_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('objective'||' '||g), (ARRAY['email','sms','social','ads','seo','aeo','content','referral','multi'])[1+floor(random()*9)::int], (ARRAY['campaign','launch','re_engagement','win_back','referral','fundraising','retargeting'])[1+floor(random()*7)::int], (ARRAY['draft','scheduled','active','paused','completed','archived'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_segments[1+floor(random()*GREATEST(array_length(a_marketing_segments,1),1))::int] END, floor(random()*1000)::int, (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), ('Sample '||'marketing campaigns'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_marketing_campaigns FROM public."marketing_campaigns";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_campaigns: %', SQLERRM; END;

  -- marketing_push_campaigns (18 cols) ------------------------------------
  BEGIN
    INSERT INTO public."marketing_push_campaigns" ("id", "title", "body", "url", "segment_id", "audience", "status", "recipients", "sent", "failed", "skipped", "clicked", "sent_at", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'marketing push campaigns'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_segments[1+floor(random()*GREATEST(array_length(a_marketing_segments,1),1))::int] END, (ARRAY['all_optedin','segment'])[1+floor(random()*2)::int], (ARRAY['draft','sending','sent','failed'])[1+floor(random()*4)::int], floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_push_campaigns: %', SQLERRM; END;

  -- meal_votes (12 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."meal_votes" ("id", "family_id", "created_by", "title", "meal_date", "meal_type", "status", "deadline", "allow_maybe", "winner_option_id", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (current_date - (floor(random()*730)-365)::int), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['open','closed'])[1+floor(random()*2)::int], (now() - (random()*365||' days')::interval), (random()<0.5), gen_random_uuid(), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_meal_votes FROM public."meal_votes";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip meal_votes: %', SQLERRM; END;

  -- meals (10 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."meals" ("id", "family_id", "name", "meal_type", "recipe_url", "ingredients", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['breakfast','lunch','dinner','snack'])[1+floor(random()*4)::int]::"meal_type", ('https://picsum.photos/seed/'||g||'/400'), jsonb_build_object('seed', g, 'note', 'sample'), ('Sample '||'meals'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_meals FROM public."meals";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip meals: %', SQLERRM; END;

  -- notes (9 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."notes" ("id", "family_id", "title", "body", "is_pinned", "checklist", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'notes'||' content generated for testing purposes. Row '||g||'.'), (random()<0.5), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip notes: %', SQLERRM; END;

  -- notifications (13 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."notifications" ("id", "family_id", "user_id", "type", "title", "body", "related_type", "related_id", "is_read", "send_at", "sent_at", "created_at", "pushed_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (ARRAY['reminder','chore','calendar','invite','system','billing'])[1+floor(random()*6)::int]::"notification_type", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'notifications'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], gen_random_uuid(), (random()<0.5), (now() + (random()*60||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip notifications: %', SQLERRM; END;

  -- permissions (7 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."permissions" ("id", "role", "resource", "can_create", "can_read", "can_update", "can_delete")
    SELECT gen_random_uuid(), a_roles[1+((g-1+0) % GREATEST(array_length(a_roles,1),1))], ('resource'||'-'||g||'-'||'perm'), (random()<0.5), (random()<0.5), (random()<0.5), (random()<0.5)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip permissions: %', SQLERRM; END;

  -- push_devices (18 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."push_devices" ("id", "user_id", "family_id", "platform", "provider", "endpoint", "p256dh", "auth", "token", "device_key", "user_agent", "enabled", "last_seen_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_auth_users[1+((g-1+0) % GREATEST(array_length(a_auth_users,1),1))], CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, ('platform'||' '||g), ('provider'||' '||g), ('endpoint'||' '||g), ('p256dh'||' '||g), ('auth'||' '||g), ('push_d'||'-'||g||'-'||floor(random()*100000)::int), ('device_key'||'-'||g||'-'||'push'), ('user_agent'||' '||g), (random()<0.5), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip push_devices: %', SQLERRM; END;

  -- referral_codes (6 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."referral_codes" ("id", "family_id", "code", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], ('code'||'-'||g||'-'||'refe'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip referral_codes: %', SQLERRM; END;

  -- referrals (15 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."referrals" ("id", "code", "referrer_family_id", "referred_family_id", "referred_email", "status", "source", "referrer_reward_cents", "referred_reward_cents", "signed_up_at", "converted_at", "rewarded_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('referr'||'-'||g||'-'||floor(random()*100000)::int), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], a_families[1+((g-1+1) % GREATEST(array_length(a_families,1),1))], ('person'||g||'@example.com'), (ARRAY['pending','signed_up','converted','rewarded','void'])[1+floor(random()*5)::int], ('source'||' '||g), floor(random()*1000)::int, floor(random()*1000)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip referrals: %', SQLERRM; END;

  -- savings_goals (10 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."savings_goals" ("id", "family_id", "name", "target_amount", "current_amount", "target_date", "emoji", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), round((random()*5000)::numeric,2), round((random()*5000)::numeric,2), (current_date - (floor(random()*730)-365)::int), (ARRAY['🎉','📌','✅','🏠','🍎','📅','⭐','💡'])[1+floor(random()*8)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip savings_goals: %', SQLERRM; END;

  -- social_accounts (21 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."social_accounts" ("id", "family_id", "user_id", "platform", "account_type", "provider_account_id", "handle", "display_name", "avatar_url", "profile_url", "status", "health", "scopes", "last_synced_at", "last_error", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int], a_social_providers[1+((g-1+0) % GREATEST(array_length(a_social_providers,1),1))], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('provider_account_id'||'-'||g||'-'||'soci'), ('social'||'-'||g||'-'||floor(random()*100000)::int), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['pending','connected','error','expired','disconnected','revoked','requires_setup'])[1+floor(random()*7)::int]::"social_account_status", ('health'||' '||g), ARRAY['item'||g, 'item'||(g+1)], (now() - (random()*365||' days')::interval), ('last_error'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_accounts FROM public."social_accounts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_accounts: %', SQLERRM; END;

  -- social_audit_logs (14 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."social_audit_logs" ("id", "family_id", "actor_id", "action", "entity_type", "entity_id", "summary", "before", "after", "ip", "occurred_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('action'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], gen_random_uuid(), ('Sample '||'social audit logs'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('ip'||' '||g), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_audit_logs: %', SQLERRM; END;

  -- social_campaigns (16 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."social_campaigns" ("id", "family_id", "user_id", "name", "description", "status", "goal", "color", "starts_on", "ends_on", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'social campaigns'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('goal'||' '||g), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_campaigns FROM public."social_campaigns";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_campaigns: %', SQLERRM; END;

  -- social_content_templates (15 cols) ------------------------------------
  BEGIN
    INSERT INTO public."social_content_templates" ("id", "family_id", "user_id", "name", "kind", "body", "platforms", "hashtags", "status", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['text','image','video','audio','short','carousel','thread','poll','link','announcement'])[1+floor(random()*10)::int]::"social_post_kind", ('Sample '||'social content templates'||' content generated for testing purposes. Row '||g||'.'), ARRAY['item'||g, 'item'||(g+1)], ARRAY['item'||g, 'item'||(g+1)], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_content_templates: %', SQLERRM; END;

  -- social_media_library (23 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."social_media_library" ("id", "family_id", "user_id", "kind", "title", "url", "storage_path", "mime_type", "width", "height", "duration_ms", "size_bytes", "alt_text", "tags", "source", "status", "usage_count", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (ARRAY['image','video','audio','document','thumbnail'])[1+floor(random()*5)::int]::"social_asset_kind", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('https://picsum.photos/seed/'||g||'/400'), ('storage_path'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*100)::int, floor(random()*1000)::int, ('Sample '||'social media library'||' content generated for testing purposes. Row '||g||'.'), ARRAY['item'||g, 'item'||(g+1)], ('source'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_media_library FROM public."social_media_library";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_media_library: %', SQLERRM; END;

  -- social_settings (13 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."social_settings" ("id", "family_id", "default_timezone", "default_platforms", "require_approval", "auto_hashtags", "signature", "ai_tone", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], (ARRAY['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'])[1+floor(random()*4)::int], ARRAY['item'||g, 'item'||(g+1)], (random()<0.5), (random()<0.5), ('signature'||' '||g), ('ai_tone'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_settings: %', SQLERRM; END;

  -- social_usage_events (11 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."social_usage_events" ("id", "family_id", "user_id", "platform", "kind", "quantity", "unit", "occurred_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*100)::int, ('unit'||' '||g), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_usage_events: %', SQLERRM; END;

  -- survey_responses (12 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."survey_responses" ("id", "survey_id", "score", "comment", "respondent_email", "respondent_family_id", "channel", "user_agent", "submitted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_surveys[1+floor(random()*GREATEST(array_length(a_surveys,1),1))::int], (1+floor(random()*5)::int), ('Sample '||'survey responses'||' content generated for testing purposes. Row '||g||'.'), ('person'||g||'@example.com'), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, ('channel'||' '||g), ('user_agent'||' '||g), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_survey_responses FROM public."survey_responses";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip survey_responses: %', SQLERRM; END;

  -- sync_accounts (15 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."sync_accounts" ("id", "user_id", "family_id", "provider", "external_id", "display_name", "sync_direction", "sync_status", "scopes", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_auth_users[1+((g-1+0) % GREATEST(array_length(a_auth_users,1),1))], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_sync_providers[1+((g-1+0) % GREATEST(array_length(a_sync_providers,1),1))], ('external_id'||'-'||g||'-'||'sync'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ARRAY['item'||g, 'item'||(g+1)], (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_accounts FROM public."sync_accounts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_accounts: %', SQLERRM; END;

  -- sync_audit_logs (18 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."sync_audit_logs" ("id", "user_id", "family_id", "provider", "external_id", "action", "item_type", "target_id", "sync_direction", "sync_status", "ip_redacted", "detail", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ('action'||' '||g), (ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]::"sync_item_type", gen_random_uuid(), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('ip_redacted'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_audit_logs: %', SQLERRM; END;

  -- sync_change_logs (19 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."sync_change_logs" ("id", "user_id", "family_id", "provider", "external_id", "item_type", "local_id", "operation", "origin", "sync_direction", "sync_status", "before", "after", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]::"sync_item_type", gen_random_uuid(), ('operation'||' '||g), ('origin'||' '||g), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_change_logs: %', SQLERRM; END;

  -- sync_settings (17 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."sync_settings" ("family_id", "user_id", "provider", "external_id", "default_direction", "sync_interval_mins", "auto_resolve", "calendars_enabled", "reminders_enabled", "notes_enabled", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", floor(random()*1000)::int, (ARRAY['keep_local','keep_remote','merge','duplicate','manual'])[1+floor(random()*5)::int]::"sync_conflict_resolution", (random()<0.5), (random()<0.5), (random()<0.5), (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_settings: %', SQLERRM; END;

  -- trips (12 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."trips" ("id", "family_id", "name", "destination", "start_date", "end_date", "status", "traveler_ids", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('destination'||' '||g), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), (ARRAY['planning','booked','active','completed','cancelled'])[1+floor(random()*5)::int]::"trip_status", ARRAY[gen_random_uuid()], ('Sample '||'trips'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_trips FROM public."trips";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip trips: %', SQLERRM; END;

  -- user_preferences (10 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."user_preferences" ("user_id", "theme", "push_enabled", "email_enabled", "expo_push_token", "active_family_id", "notification_prefs", "created_at", "updated_at", "default_dashboard")
    SELECT a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int], (ARRAY['light','dark','system'])[1+floor(random()*3)::int]::"theme_pref", (random()<0.5), (random()<0.5), ('user_p'||'-'||g||'-'||floor(random()*100000)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (ARRAY['personal','family'])[1+floor(random()*2)::int]
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip user_preferences: %', SQLERRM; END;

  -- weather_locations (12 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."weather_locations" ("id", "family_id", "name", "admin1", "country", "latitude", "longitude", "is_default", "sort_order", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('admin1'||' '||g), (ARRAY['USA','Canada','UK','Australia'])[1+floor(random()*4)::int], g::numeric, g::numeric, (random()<0.5), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip weather_locations: %', SQLERRM; END;

  -- ai_messages (8 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."ai_messages" ("id", "family_id", "conversation_id", "role", "content", "tool_calls", "tool_results", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_ai_conversations[1+floor(random()*GREATEST(array_length(a_ai_conversations,1),1))::int], (ARRAY['user','assistant','system','tool'])[1+floor(random()*4)::int]::"ai_role", ('Sample '||'ai messages'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip ai_messages: %', SQLERRM; END;

  -- appointments (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."appointments" ("id", "family_id", "member_id", "title", "provider", "location", "starts_at", "ends_at", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('provider'||' '||g), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), ('Sample '||'appointments'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip appointments: %', SQLERRM; END;

  -- calendar_events (17 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."calendar_events" ("id", "family_id", "title", "description", "location", "category", "starts_at", "ends_at", "all_day", "recurrence", "recurrence_until", "assignee_id", "created_by", "created_at", "updated_at", "feed_id", "external_uid")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'calendar events'||' content generated for testing purposes. Row '||g||'.'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (ARRAY['general','school','sports','medical','family','work'])[1+floor(random()*6)::int]::"event_category", (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), (random()<0.5), (ARRAY['none','daily','weekly','monthly','yearly'])[1+floor(random()*5)::int]::"recurrence_freq", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_calendar_feeds[1+floor(random()*GREATEST(array_length(a_calendar_feeds,1),1))::int] END, ('external_uid'||' '||g)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_calendar_events FROM public."calendar_events";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip calendar_events: %', SQLERRM; END;

  -- care_log (11 cols) ----------------------------------------------------
  BEGIN
    INSERT INTO public."care_log" ("id", "family_id", "member_id", "log_type", "occurred_at", "wellbeing", "note", "logged_by", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], (ARRAY['check_in','visit','call','meal','medication','appointment','incident','note'])[1+floor(random()*8)::int]::"care_log_type", (now() - (random()*365||' days')::interval), (1+floor(random()*5)::int), ('Sample '||'care log'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip care_log: %', SQLERRM; END;

  -- chore_assignments (15 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."chore_assignments" ("id", "family_id", "chore_id", "member_id", "status", "due_at", "submitted_at", "approved_at", "approved_by", "points_awarded", "created_at", "updated_at", "ai_score", "cash_awarded_cents", "disputed")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_chores[1+floor(random()*GREATEST(array_length(a_chores,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], (ARRAY['todo','in_progress','done','approved','rejected'])[1+floor(random()*5)::int]::"task_status", (now() + (random()*60||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, floor(random()*100)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (1+floor(random()*5)::int), floor(random()*500000)::int, (random()<0.5)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_chore_assignments FROM public."chore_assignments";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chore_assignments: %', SQLERRM; END;

  -- crm_deals (12 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."crm_deals" ("id", "contact_id", "name", "amount_cents", "currency", "stage", "close_date", "owner_id", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_crm_contacts[1+floor(random()*GREATEST(array_length(a_crm_contacts,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), floor(random()*500000)::int, (ARRAY['USD','EUR','GBP','CAD'])[1+floor(random()*4)::int], (ARRAY['lead','qualified','proposal','negotiation','won','lost'])[1+floor(random()*6)::int], (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('Sample '||'crm deals'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_crm_deals FROM public."crm_deals";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip crm_deals: %', SQLERRM; END;

  -- documents (12 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."documents" ("id", "family_id", "title", "category", "storage_path", "mime_type", "size_bytes", "expires_at", "member_id", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('storage_path'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*1000)::int, (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_documents FROM public."documents";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip documents: %', SQLERRM; END;

  -- family_ai_recommendations (15 cols) -----------------------------------
  BEGIN
    INSERT INTO public."family_ai_recommendations" ("id", "family_id", "member_id", "category", "title", "body", "priority", "cta_href", "source", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family ai recommendations'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('https://picsum.photos/seed/'||g||'/400'), ('source'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_ai_recommendations: %', SQLERRM; END;

  -- family_announcements (9 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."family_announcements" ("id", "family_id", "author_id", "author_member_id", "title", "body", "is_pinned", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family announcements'||' content generated for testing purposes. Row '||g||'.'), (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_announcements FROM public."family_announcements";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_announcements: %', SQLERRM; END;

  -- family_automation_runs (13 cols) --------------------------------------
  BEGIN
    INSERT INTO public."family_automation_runs" ("id", "family_id", "rule_id", "trigger_type", "status", "summary", "result", "approved_by", "approved_at", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_automation_rules[1+floor(random()*GREATEST(array_length(a_family_automation_rules,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('Sample '||'family automation runs'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_automation_runs: %', SQLERRM; END;

  -- family_contacts (21 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."family_contacts" ("id", "family_id", "name", "relationship", "category", "phone", "phone_alt", "email", "address", "notes", "photo_url", "is_emergency", "birthday_month", "birthday_day", "tags", "linked_member_id", "specialty", "organization", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('relationship'||' '||g), (ARRAY['emergency','family','doctor','dentist','teacher','coach','babysitter','neighbor','work','friend','other'])[1+floor(random()*11)::int], ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('person'||g||'@example.com'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), ('Sample '||'family contacts'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), (random()<0.5), (1+floor(random()*12)::int), (1+floor(random()*31)::int), ARRAY['item'||g, 'item'||(g+1)], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('specialty'||' '||g), ('organization'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_contacts: %', SQLERRM; END;

  -- family_dates (11 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."family_dates" ("id", "family_id", "member_id", "title", "kind", "event_date", "notes", "remind_days", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['birthday','anniversary','holiday','other'])[1+floor(random()*4)::int]::"celebration_kind", (current_date - (floor(random()*730)-365)::int), ('Sample '||'family dates'||' content generated for testing purposes. Row '||g||'.'), floor(random()*1000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_dates: %', SQLERRM; END;

  -- family_digital_twin_profiles (15 cols) --------------------------------
  BEGIN
    INSERT INTO public."family_digital_twin_profiles" ("id", "family_id", "member_id", "preferences", "responsibilities", "strengths", "notes", "ai_insights", "stress_baseline", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('strengths'||' '||g), ('Sample '||'family digital twin profiles'||' content generated for testing purposes. Row '||g||'.'), ('ai_insights'||' '||g), floor(random()*1000)::int, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_digital_twin_profiles: %', SQLERRM; END;

  -- family_emergency_contacts (19 cols) -----------------------------------
  BEGIN
    INSERT INTO public."family_emergency_contacts" ("id", "family_id", "member_id", "name", "relationship", "phone", "alt_phone", "email", "address", "is_primary", "can_pickup", "priority", "notes", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('relationship'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('person'||g||'@example.com'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (random()<0.5), (random()<0.5), (1+floor(random()*5)::int), ('Sample '||'family emergency contacts'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_emergency_contacts: %', SQLERRM; END;

  -- family_knowledge_nodes (13 cols) --------------------------------------
  BEGIN
    INSERT INTO public."family_knowledge_nodes" ("id", "family_id", "member_id", "node_type", "label", "ref_table", "ref_id", "weight", "status", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('family'||'-'||g||'-'||floor(random()*100000)::int), gen_random_uuid(), round((random()*1000)::numeric,2), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_knowledge_nodes FROM public."family_knowledge_nodes";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_knowledge_nodes: %', SQLERRM; END;

  -- family_memories (17 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."family_memories" ("id", "family_id", "member_id", "title", "body", "kind", "memory_date", "media_path", "tags", "is_favorite", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family memories'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (current_date - (floor(random()*730)-365)::int), ('media_path'||' '||g), ARRAY['item'||g, 'item'||(g+1)], (random()<0.5), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_memories: %', SQLERRM; END;

  -- family_messages (17 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."family_messages" ("id", "conversation_id", "family_id", "sender_id", "sender_name", "sender_avatar", "content", "kind", "attachment_url", "attachment_name", "attachment_mime", "reply_to_id", "reactions", "read_by", "is_pinned", "deleted_at", "created_at")
    SELECT gen_random_uuid(), a_family_conversations[1+floor(random()*GREATEST(array_length(a_family_conversations,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('https://picsum.photos/seed/'||g||'/400'), ('Sample '||'family messages'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['text','image','file','voice','poll','announcement'])[1+floor(random()*6)::int], ('https://picsum.photos/seed/'||g||'/400'), ('attachment_name'||' '||g), ('attachment_mime'||' '||g), NULL, jsonb_build_object('seed', g, 'note', 'sample'), ARRAY[gen_random_uuid()], (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_family_messages FROM public."family_messages";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_messages: %', SQLERRM; END;

  -- family_milestones (13 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."family_milestones" ("id", "family_id", "member_id", "title", "description", "milestone_date", "category", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family milestones'||' content generated for testing purposes. Row '||g||'.'), (current_date - (floor(random()*730)-365)::int), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_milestones: %', SQLERRM; END;

  -- family_photos (17 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."family_photos" ("id", "family_id", "album_id", "uploaded_by", "storage_path", "url", "thumbnail_url", "caption", "taken_at", "width", "height", "size_bytes", "tags", "member_tags", "is_favorite", "metadata", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_albums[1+floor(random()*GREATEST(array_length(a_family_albums,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('storage_path'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ('caption'||' '||g), (now() - (random()*365||' days')::interval), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, ARRAY['item'||g, 'item'||(g+1)], ARRAY[gen_random_uuid()], (random()<0.5), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_photos: %', SQLERRM; END;

  -- family_reminders (21 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."family_reminders" ("id", "family_id", "created_by", "assigned_to_id", "member_id", "title", "notes", "kind", "remind_at", "location_name", "recurrence", "recurrence_time", "recurrence_days", "priority", "status", "completed_at", "snoozed_until", "ai_suggested", "tags", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family reminders'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['time','location','recurring','medication','bill','school','chore'])[1+floor(random()*7)::int], (now() - (random()*365||' days')::interval), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (ARRAY['none','daily','weekdays','weekly','biweekly','monthly','yearly'])[1+floor(random()*7)::int], (time '00:00' + (floor(random()*86400)||' seconds')::interval), ARRAY[floor(random()*100)::int], (ARRAY['low','medium','high','urgent'])[1+floor(random()*4)::int], (ARRAY['active','snoozed','completed','dismissed'])[1+floor(random()*4)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (random()<0.5), ARRAY['item'||g, 'item'||(g+1)], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_reminders: %', SQLERRM; END;

  -- family_routines (15 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."family_routines" ("id", "family_id", "member_id", "title", "description", "category", "time_of_day", "days_of_week", "status", "metadata", "created_by", "updated_by", "created_at", "updated_at", "deleted_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'family routines'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('time_of_day'||' '||g), ARRAY[floor(random()*100)::int], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_routines: %', SQLERRM; END;

  -- family_stress_signals (13 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."family_stress_signals" ("id", "family_id", "member_id", "signal_type", "weight", "source", "occurred_on", "notes", "status", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], round((random()*1000)::numeric,2), ('source'||' '||g), (current_date - (floor(random()*730)-365)::int), ('Sample '||'family stress signals'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_stress_signals: %', SQLERRM; END;

  -- grocery_items (16 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."grocery_items" ("id", "family_id", "list_id", "name", "quantity", "category", "is_checked", "source_meal_id", "created_by", "created_at", "updated_at", "quantity_unit", "price_cents", "assigned_to_id", "note", "sort_order")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_grocery_lists[1+floor(random()*GREATEST(array_length(a_grocery_lists,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('quantity'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_meals[1+floor(random()*GREATEST(array_length(a_meals,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), ('quantity_unit'||' '||g), floor(random()*500000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, ('Sample '||'grocery items'||' content generated for testing purposes. Row '||g||'.'), floor(random()*100)::int
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip grocery_items: %', SQLERRM; END;

  -- health_metrics (8 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."health_metrics" ("id", "family_id", "member_id", "type", "value", "unit", "recorded_at", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], (ARRAY['steps','sleep_hours','heart_rate','calories','active_minutes','distance','weight','water_cups'])[1+floor(random()*8)::int]::"metric_type", round((random()*1000)::numeric,2), ('unit'||' '||g), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip health_metrics: %', SQLERRM; END;

  -- health_providers (16 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."health_providers" ("id", "family_id", "member_id", "kind", "name", "specialty", "practice_name", "phone", "fax", "email", "address", "is_primary", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['medical','dental'])[1+floor(random()*2)::int]::"record_kind", ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('specialty'||' '||g), ('practice_name'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('fax'||' '||g), ('person'||g||'@example.com'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (random()<0.5), ('Sample '||'health providers'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_health_providers FROM public."health_providers";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip health_providers: %', SQLERRM; END;

  -- home_assets (21 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."home_assets" ("id", "family_id", "name", "category", "location", "brand", "model", "purchased_on", "warranty_until", "notes", "created_by", "created_at", "updated_at", "home_id", "serial_number", "installed_on", "filter_size", "purchase_price", "expected_life_years", "condition", "last_serviced_on")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), ('brand'||' '||g), ('model'||' '||g), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), ('Sample '||'home assets'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_homes[1+floor(random()*GREATEST(array_length(a_homes,1),1))::int] END, ('serial_number'||' '||g), (current_date - (floor(random()*730)-365)::int), ('filter_size'||' '||g), round((random()*5000)::numeric,2), (2015+floor(random()*12)::int), ('condition'||' '||g), (current_date - (floor(random()*730)-365)::int)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_home_assets FROM public."home_assets";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip home_assets: %', SQLERRM; END;

  -- homework_assignments (12 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."homework_assignments" ("id", "family_id", "member_id", "subject", "title", "details", "due_at", "status", "completed_at", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'homework assignments'||' content generated for testing purposes. Row '||g||'.'), (now() + (random()*60||' days')::interval), (ARRAY['assigned','in_progress','done','submitted'])[1+floor(random()*4)::int]::"homework_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip homework_assignments: %', SQLERRM; END;

  -- insurance_policies (21 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."insurance_policies" ("id", "family_id", "member_id", "kind", "insurer", "plan_name", "plan_type", "policy_number", "group_number", "rx_bin", "rx_pcn", "rx_group", "customer_service_phone", "front_image_path", "back_image_path", "effective_date", "is_primary", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['medical','dental'])[1+floor(random()*2)::int]::"record_kind", ('insurer'||' '||g), ('plan_name'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('policy_number'||' '||g), ('group_number'||' '||g), ('rx_bin'||' '||g), ('rx_pcn'||' '||g), ('rx_group'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), (current_date - (floor(random()*730)-365)::int), (random()<0.5), ('Sample '||'insurance policies'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip insurance_policies: %', SQLERRM; END;

  -- kid_progress (10 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."kid_progress" ("id", "family_id", "member_id", "xp", "level", "current_streak", "longest_streak", "last_activity", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], floor(random()*1000)::int, (1+floor(random()*5)::int), floor(random()*100)::int, floor(random()*100)::int, (current_date - (floor(random()*730)-365)::int), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip kid_progress: %', SQLERRM; END;

  -- location_events (10 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."location_events" ("id", "family_id", "member_id", "place_id", "place_name", "event_type", "latitude", "longitude", "occurred_at", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_places[1+floor(random()*GREATEST(array_length(a_family_places,1),1))::int] END, (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (ARRAY['arrived','left','ping'])[1+floor(random()*3)::int]::"location_event_type", round((random()*180-90)::numeric,6), round((random()*360-180)::numeric,6), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip location_events: %', SQLERRM; END;

  -- marketing_ad_campaigns (17 cols) --------------------------------------
  BEGIN
    INSERT INTO public."marketing_ad_campaigns" ("id", "campaign_id", "platform", "name", "objective", "budget_cents", "spend_cents", "impressions", "clicks", "conversions", "utm", "status", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, (ARRAY['meta','google','linkedin','tiktok','x'])[1+floor(random()*5)::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('objective'||' '||g), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['planned','active','paused','completed'])[1+floor(random()*4)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_ad_campaigns: %', SQLERRM; END;

  -- marketing_content_items (15 cols) -------------------------------------
  BEGIN
    INSERT INTO public."marketing_content_items" ("id", "campaign_id", "title", "kind", "channel", "brief", "body", "status", "publish_at", "metadata", "created_by", "updated_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['blog','landing','social','email','ad','seo_brief','aeo_brief'])[1+floor(random()*7)::int], ('channel'||' '||g), ('brief'||' '||g), ('Sample '||'marketing content items'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['idea','brief','drafting','review','approved','published'])[1+floor(random()*6)::int], (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_content_items: %', SQLERRM; END;

  -- marketing_email_campaigns (21 cols) -----------------------------------
  BEGIN
    INSERT INTO public."marketing_email_campaigns" ("id", "campaign_id", "segment_id", "subject", "preview_text", "body_html", "from_name", "status", "scheduled_at", "sent_at", "recipients", "opens", "clicks", "bounces", "unsubscribes", "provider_ref", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_segments[1+floor(random()*GREATEST(array_length(a_marketing_segments,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'marketing email campaigns'||' content generated for testing purposes. Row '||g||'.'), ('Sample '||'marketing email campaigns'||' content generated for testing purposes. Row '||g||'.'), ('from_name'||' '||g), (ARRAY['draft','scheduled','sending','sent','failed'])[1+floor(random()*5)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, ('market'||'-'||g||'-'||floor(random()*100000)::int), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_marketing_email_campaigns FROM public."marketing_email_campaigns";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_email_campaigns: %', SQLERRM; END;

  -- marketing_forms (10 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."marketing_forms" ("id", "campaign_id", "name", "fields", "status", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','archived'])[1+floor(random()*2)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_marketing_forms FROM public."marketing_forms";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_forms: %', SQLERRM; END;

  -- marketing_landing_pages (16 cols) -------------------------------------
  BEGIN
    INSERT INTO public."marketing_landing_pages" ("id", "campaign_id", "slug", "title", "headline", "subhead", "body", "status", "published", "views", "conversions", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, ('slug'||'-'||g||'-'||'mark'), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('subhead'||' '||g), ('Sample '||'marketing landing pages'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['draft','published','archived'])[1+floor(random()*3)::int], (random()<0.5), floor(random()*1000)::int, floor(random()*1000)::int, jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_landing_pages: %', SQLERRM; END;

  -- marketing_sms_campaigns (17 cols) -------------------------------------
  BEGIN
    INSERT INTO public."marketing_sms_campaigns" ("id", "campaign_id", "segment_id", "message", "status", "scheduled_at", "sent_at", "recipients", "delivered", "replies", "opt_outs", "provider_ref", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_segments[1+floor(random()*GREATEST(array_length(a_marketing_segments,1),1))::int] END, ('Sample '||'marketing sms campaigns'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['draft','scheduled','sending','sent','failed'])[1+floor(random()*5)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, ('market'||'-'||g||'-'||floor(random()*100000)::int), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_sms_campaigns: %', SQLERRM; END;

  -- marketing_social_posts (12 cols) --------------------------------------
  BEGIN
    INSERT INTO public."marketing_social_posts" ("id", "campaign_id", "platform", "content", "link", "status", "scheduled_at", "metadata", "created_by", "deleted_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_campaigns,1),1))::int] END, (ARRAY['facebook','instagram','linkedin','tiktok','x','youtube'])[1+floor(random()*6)::int], ('Sample '||'marketing social posts'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['draft','scheduled','published'])[1+floor(random()*3)::int], (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_social_posts: %', SQLERRM; END;

  -- meal_plans (8 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."meal_plans" ("id", "family_id", "meal_id", "plan_date", "meal_type", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_meals[1+floor(random()*GREATEST(array_length(a_meals,1),1))::int] END, (current_date - (floor(random()*730)-365)::int), (ARRAY['breakfast','lunch','dinner','snack'])[1+floor(random()*4)::int]::"meal_type", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip meal_plans: %', SQLERRM; END;

  -- meal_vote_options (7 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."meal_vote_options" ("id", "vote_id", "family_id", "recipe_id", "label", "photo_url", "created_at")
    SELECT gen_random_uuid(), a_meal_votes[1+floor(random()*GREATEST(array_length(a_meal_votes,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_recipes[1+floor(random()*GREATEST(array_length(a_family_recipes,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('https://picsum.photos/seed/'||g||'/400'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_meal_vote_options FROM public."meal_vote_options";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip meal_vote_options: %', SQLERRM; END;

  -- medical_profiles (19 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."medical_profiles" ("id", "family_id", "member_id", "blood_type", "allergies", "conditions", "current_medications", "primary_physician", "preferred_pharmacy", "pharmacy_phone", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relation", "immunizations", "dental_notes", "notes", "updated_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('allergies'||' '||g), ('conditions'||' '||g), ('current_medications'||' '||g), ('primary_physician'||' '||g), ('medica'||'-'||g||'-'||floor(random()*100000)::int), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('emergency_contact_relation'||' '||g), ('immunizations'||' '||g), ('Sample '||'medical profiles'||' content generated for testing purposes. Row '||g||'.'), ('Sample '||'medical profiles'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip medical_profiles: %', SQLERRM; END;

  -- medications (10 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."medications" ("id", "family_id", "member_id", "name", "dosage", "instructions", "is_active", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('dosage'||' '||g), ('instructions'||' '||g), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_medications FROM public."medications";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip medications: %', SQLERRM; END;

  -- member_badges (5 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."member_badges" ("id", "family_id", "member_id", "badge_id", "awarded_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], a_badges[1+((g-1+0) % GREATEST(array_length(a_badges,1),1))], (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip member_badges: %', SQLERRM; END;

  -- member_locations (11 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."member_locations" ("id", "family_id", "member_id", "latitude", "longitude", "accuracy_m", "battery", "place_id", "is_sharing", "updated_at", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], round((random()*180-90)::numeric,6), round((random()*360-180)::numeric,6), round((random()*1000)::numeric,2), floor(random()*1000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_family_places[1+floor(random()*GREATEST(array_length(a_family_places,1),1))::int] END, (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip member_locations: %', SQLERRM; END;

  -- mkt_visitors (10 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."mkt_visitors" ("id", "anonymous_id", "contact_id", "device_type", "country", "first_seen", "last_seen", "session_count", "created_at", "updated_at")
    SELECT gen_random_uuid(), ('anonymous_id'||'-'||g||'-'||'mkt_'), CASE WHEN random()<0.1 THEN NULL ELSE a_crm_contacts[1+floor(random()*GREATEST(array_length(a_crm_contacts,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['USA','Canada','UK','Australia'])[1+floor(random()*4)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), floor(random()*100)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_mkt_visitors FROM public."mkt_visitors";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip mkt_visitors: %', SQLERRM; END;

  -- opportunities (14 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."opportunities" ("id", "family_id", "member_id", "title", "category", "url", "cost", "opens_at", "deadline", "status", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('https://picsum.photos/seed/'||g||'/400'), round((random()*5000)::numeric,2), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), (ARRAY['interested','registered','waitlisted','passed','missed'])[1+floor(random()*5)::int]::"opportunity_status", ('Sample '||'opportunities'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip opportunities: %', SQLERRM; END;

  -- reminders (13 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."reminders" ("id", "family_id", "title", "notes", "remind_at", "recurrence", "is_done", "member_id", "related_type", "related_id", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'reminders'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), (ARRAY['none','daily','weekly','monthly','yearly'])[1+floor(random()*5)::int]::"recurrence_freq", (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip reminders: %', SQLERRM; END;

  -- renewals (14 cols) ----------------------------------------------------
  BEGIN
    INSERT INTO public."renewals" ("id", "family_id", "member_id", "title", "category", "expires_at", "reminder_days", "cost", "url", "status", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (current_date - (floor(random()*730)-365)::int), (1+floor(random()*28)::int), round((random()*5000)::numeric,2), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['active','renewed','expired','cancelled'])[1+floor(random()*4)::int]::"renewal_status", ('Sample '||'renewals'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip renewals: %', SQLERRM; END;

  -- reviews (18 cols) -----------------------------------------------------
  BEGIN
    INSERT INTO public."reviews" ("id", "rating", "title", "body", "author_name", "author_email", "source", "status", "reply", "replied_at", "replied_by", "family_id", "survey_response_id", "submitted_at", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), (1+floor(random()*5)::int), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'reviews'||' content generated for testing purposes. Row '||g||'.'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('person'||g||'@example.com'), (ARRAY['internal','google','app_store','trustpilot','nps','import'])[1+floor(random()*6)::int], (ARRAY['pending','approved','featured','rejected'])[1+floor(random()*4)::int], ('reply'||' '||g), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_survey_responses[1+floor(random()*GREATEST(array_length(a_survey_responses,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip reviews: %', SQLERRM; END;

  -- rewards (10 cols) -----------------------------------------------------
  BEGIN
    INSERT INTO public."rewards" ("id", "family_id", "title", "description", "cost_points", "redeemed_by", "redeemed_at", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'rewards'||' content generated for testing purposes. Row '||g||'.'), floor(random()*500000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_rewards FROM public."rewards";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip rewards: %', SQLERRM; END;

  -- school_classes (13 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."school_classes" ("id", "family_id", "member_id", "subject", "teacher", "room", "time_slot", "day_of_week", "school_name", "created_by", "created_at", "updated_at", "week_pattern")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('teacher'||' '||g), ('room'||' '||g), ('time_slot'||' '||g), (1+floor(random()*28)::int), ('school_name'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (ARRAY['all','a','b'])[1+floor(random()*3)::int]::"week_pattern"
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_school_classes FROM public."school_classes";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip school_classes: %', SQLERRM; END;

  -- school_events (13 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."school_events" ("id", "family_id", "member_id", "school_name", "title", "event_type", "starts_at", "ends_at", "notes", "source", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('school_name'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), ('Sample '||'school events'||' content generated for testing purposes. Row '||g||'.'), ('source'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip school_events: %', SQLERRM; END;

  -- social_access_permissions (12 cols) -----------------------------------
  BEGIN
    INSERT INTO public."social_access_permissions" ("id", "family_id", "user_id", "member_id", "social_role", "status", "granted_by", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+((g-1+0) % GREATEST(array_length(a_families,1),1))], a_auth_users[1+((g-1+0) % GREATEST(array_length(a_auth_users,1),1))], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['owner','admin','marketing_manager','social_manager','content_creator','approver','analyst','read_only'])[1+floor(random()*8)::int]::"social_role", (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_access_permissions: %', SQLERRM; END;

  -- social_account_tokens (15 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."social_account_tokens" ("id", "account_id", "family_id", "platform", "provider_account_id", "access_token_enc", "refresh_token_enc", "token_type", "scope", "expires_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('provider_account_id'||' '||g), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('scope'||' '||g), (now() + (random()*60||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_account_tokens: %', SQLERRM; END;

  -- social_feed_items (22 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."social_feed_items" ("id", "family_id", "account_id", "platform", "provider_object_id", "author_name", "author_handle", "author_avatar_url", "permalink_url", "body", "media_type", "media", "metrics", "posted_at", "fetched_at", "status", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_social_accounts[1+((g-1+0) % GREATEST(array_length(a_social_accounts,1),1))], (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('provider_object_id'||'-'||g||'-'||'soci'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('https://picsum.photos/seed/'||g||'/400'), ('https://picsum.photos/seed/'||g||'/400'), ('Sample '||'social feed items'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_feed_items FROM public."social_feed_items";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_feed_items: %', SQLERRM; END;

  -- social_messages (19 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."social_messages" ("id", "family_id", "account_id", "platform", "provider_object_id", "thread_id", "direction", "author_name", "author_handle", "body", "status", "assigned_to", "posted_at", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('provider_object_id'||' '||g), ('thread_id'||' '||g), ('direction'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('Sample '||'social messages'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['open','resolved','ignored','snoozed'])[1+floor(random()*4)::int]::"social_inbox_status", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_messages: %', SQLERRM; END;

  -- social_posts (20 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."social_posts" ("id", "family_id", "user_id", "campaign_id", "title", "body", "kind", "status", "link", "scheduled_for", "published_at", "approval_status", "approved_by", "approved_at", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_campaigns[1+floor(random()*GREATEST(array_length(a_social_campaigns,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'social posts'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['text','image','video','audio','short','carousel','thread','poll','link','announcement'])[1+floor(random()*10)::int]::"social_post_kind", (ARRAY['draft','scheduled','publishing','published','partially_published','failed','canceled'])[1+floor(random()*7)::int]::"social_post_status", ('https://picsum.photos/seed/'||g||'/400'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (ARRAY['not_required','pending','approved','rejected','changes_requested'])[1+floor(random()*5)::int]::"social_approval_status", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_posts FROM public."social_posts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_posts: %', SQLERRM; END;

  -- social_provider_errors (13 cols) --------------------------------------
  BEGIN
    INSERT INTO public."social_provider_errors" ("id", "family_id", "account_id", "platform", "scope", "error_code", "error_message", "context", "occurred_at", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('scope'||' '||g), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('Sample '||'social provider errors'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_provider_errors: %', SQLERRM; END;

  -- social_webhook_events (14 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."social_webhook_events" ("id", "family_id", "account_id", "platform", "provider_object_id", "event_type", "payload", "signature_ok", "processed", "processed_at", "received_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('provider_object_id'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), (random()<0.5), (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_webhook_events: %', SQLERRM; END;

  -- sports_events (15 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."sports_events" ("id", "family_id", "member_id", "sport", "team", "title", "event_type", "location", "starts_at", "ends_at", "recurrence", "recurrence_until", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('sport'||' '||g), ('team'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), (ARRAY['none','daily','weekly','monthly','yearly'])[1+floor(random()*5)::int]::"recurrence_freq", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sports_events: %', SQLERRM; END;

  -- subscriptions (10 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."subscriptions" ("id", "family_id", "billing_customer_id", "plan", "status", "provider_ref", "current_period_end", "seats", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_billing_customers[1+floor(random()*GREATEST(array_length(a_billing_customers,1),1))::int] END, ('plan'||' '||g), (ARRAY['trialing','active','past_due','canceled','incomplete'])[1+floor(random()*5)::int]::"subscription_status", ('subscr'||'-'||g||'-'||floor(random()*100000)::int), (now() + (random()*60||' days')::interval), floor(random()*1000)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip subscriptions: %', SQLERRM; END;

  -- sync_calendars (23 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."sync_calendars" ("id", "user_id", "family_id", "account_id", "provider", "external_id", "name", "description", "color", "timezone", "is_primary", "is_owned_locally", "feed_token", "feed_enabled", "sync_direction", "sync_status", "sync_token", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('Sample '||'sync calendars'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], (ARRAY['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'])[1+floor(random()*4)::int], (random()<0.5), (random()<0.5), ('feed_token'||'-'||g||'-'||'sync'), (random()<0.5), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('sync_c'||'-'||g||'-'||floor(random()*100000)::int), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_calendars FROM public."sync_calendars";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_calendars: %', SQLERRM; END;

  -- sync_conflicts (20 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."sync_conflicts" ("id", "user_id", "family_id", "account_id", "provider", "external_id", "item_type", "local_id", "conflict_kind", "local_snapshot", "remote_snapshot", "status", "sync_direction", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]::"sync_item_type", gen_random_uuid(), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['open','resolved','ignored'])[1+floor(random()*3)::int]::"sync_conflict_status", (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_conflicts FROM public."sync_conflicts";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_conflicts: %', SQLERRM; END;

  -- sync_connections (17 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."sync_connections" ("id", "account_id", "user_id", "family_id", "provider", "external_id", "item_types", "sync_direction", "sync_status", "health", "last_error", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int], a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ARRAY[(ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]]::"sync_item_type"[], (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('health'||' '||g), ('last_error'||' '||g), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_connections: %', SQLERRM; END;

  -- sync_external_mappings (17 cols) --------------------------------------
  BEGIN
    INSERT INTO public."sync_external_mappings" ("id", "user_id", "family_id", "account_id", "provider", "item_type", "local_id", "external_id", "external_etag", "sync_direction", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_sync_accounts[1+((g-1+0) % GREATEST(array_length(a_sync_accounts,1),1))], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", (ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]::"sync_item_type", gen_random_uuid(), ('external_id'||'-'||g||'-'||'sync'), ('external_etag'||' '||g), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_external_mappings: %', SQLERRM; END;

  -- sync_jobs (23 cols) ---------------------------------------------------
  BEGIN
    INSERT INTO public."sync_jobs" ("id", "user_id", "family_id", "account_id", "provider", "external_id", "item_type", "kind", "sync_direction", "sync_status", "status", "scheduled_for", "attempts", "max_attempts", "next_attempt_at", "idempotency_key", "last_error", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['calendar','event','reminder_list','reminder','note','note_folder'])[1+floor(random()*6)::int]::"sync_item_type", (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (ARRAY['queued','running','succeeded','failed','dead_letter','cancelled'])[1+floor(random()*6)::int]::"sync_job_status", (now() - (random()*365||' days')::interval), floor(random()*1000)::int, floor(random()*100)::int, (now() + (random()*60||' days')::interval), ('idempotency_key'||'-'||g||'-'||'sync'), ('last_error'||' '||g), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_jobs FROM public."sync_jobs";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_jobs: %', SQLERRM; END;

  -- sync_note_folders (17 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."sync_note_folders" ("id", "user_id", "family_id", "account_id", "provider", "external_id", "name", "parent_id", "is_owned_locally", "sync_direction", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), NULL, (random()<0.5), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_note_folders FROM public."sync_note_folders";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_note_folders: %', SQLERRM; END;

  -- sync_provider_errors (17 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."sync_provider_errors" ("id", "family_id", "account_id", "provider", "external_id", "code", "message_redacted", "http_status", "is_fatal", "sync_status", "occurred_at", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ('sync_p'||'-'||g||'-'||floor(random()*100000)::int), ('Sample '||'sync provider errors'||' content generated for testing purposes. Row '||g||'.'), floor(random()*1000)::int, (random()<0.5), (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_provider_errors: %', SQLERRM; END;

  -- sync_reminder_lists (18 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."sync_reminder_lists" ("id", "user_id", "family_id", "account_id", "provider", "external_id", "name", "color", "is_owned_locally", "sync_direction", "sync_status", "sync_token", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], (random()<0.5), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('sync_r'||'-'||g||'-'||floor(random()*100000)::int), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_reminder_lists FROM public."sync_reminder_lists";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_reminder_lists: %', SQLERRM; END;

  -- sync_tokens (19 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."sync_tokens" ("id", "account_id", "user_id", "family_id", "provider", "external_id", "access_token_enc", "refresh_token_enc", "token_type", "scope", "expires_at", "sync_direction", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_accounts[1+((g-1+0) % GREATEST(array_length(a_sync_accounts,1),1))], a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ('sync_t'||'-'||g||'-'||floor(random()*100000)::int), ('sync_t'||'-'||g||'-'||floor(random()*100000)::int), ('sync_t'||'-'||g||'-'||floor(random()*100000)::int), ('scope'||' '||g), (now() + (random()*60||' days')::interval), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_tokens: %', SQLERRM; END;

  -- sync_webhook_events (18 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."sync_webhook_events" ("id", "family_id", "account_id", "provider", "external_id", "resource", "payload", "signature_ok", "processed", "sync_status", "received_at", "processed_at", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_sync_accounts[1+floor(random()*GREATEST(array_length(a_sync_accounts,1),1))::int] END, (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ('resource'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), (random()<0.5), (random()<0.5), (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_webhook_events: %', SQLERRM; END;

  -- teams (11 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."teams" ("id", "family_id", "member_id", "sport", "team_name", "season", "coach", "is_active", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('sport'||' '||g), ('team_name'||' '||g), ('season'||' '||g), ('coach'||' '||g), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_teams FROM public."teams";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip teams: %', SQLERRM; END;

  -- todo_lists (11 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."todo_lists" ("id", "family_id", "created_by", "name", "color", "icon", "is_shared", "sort_order", "archived_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], ('https://picsum.photos/seed/'||g||'/400'), (random()<0.5), floor(random()*100)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_todo_lists FROM public."todo_lists";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip todo_lists: %', SQLERRM; END;

  -- transactions (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."transactions" ("id", "family_id", "account_id", "name", "amount", "category", "date", "type", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_financial_accounts[1+floor(random()*GREATEST(array_length(a_financial_accounts,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), round((random()*5000)::numeric,2), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (current_date - (floor(random()*730)-365)::int), (ARRAY['income','expense','transfer'])[1+floor(random()*3)::int]::"transaction_type", ('Sample '||'transactions'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip transactions: %', SQLERRM; END;

  -- trip_items (13 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."trip_items" ("id", "family_id", "trip_id", "kind", "label", "details", "assignee_id", "is_done", "due_at", "sort_order", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_trips[1+floor(random()*GREATEST(array_length(a_trips,1),1))::int], (ARRAY['packing','todo','reservation','document'])[1+floor(random()*4)::int]::"trip_item_kind", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'trip items'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (random()<0.5), (now() + (random()*60||' days')::interval), floor(random()*100)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip trip_items: %', SQLERRM; END;

  -- vehicles (25 cols) ----------------------------------------------------
  BEGIN
    INSERT INTO public."vehicles" ("id", "family_id", "nickname", "make", "model", "year", "trim", "color", "vin", "license_plate", "plate_state", "body_type", "fuel_type", "mileage", "purchase_date", "primary_driver", "status", "photo_url", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ('nickname'||' '||g), ('make'||' '||g), ('model'||' '||g), (2015+floor(random()*12)::int), ('trim'||' '||g), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], ('vin'||' '||g), ('license_plate'||' '||g), (ARRAY['CA','TX','NY','WA','CO','FL','IL','MA'])[1+floor(random()*8)::int], ('Sample '||'vehicles'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], floor(random()*1000)::int, (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('https://picsum.photos/seed/'||g||'/400'), ('Sample '||'vehicles'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_vehicles FROM public."vehicles";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip vehicles: %', SQLERRM; END;

  -- wishlist_items (14 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."wishlist_items" ("id", "family_id", "member_id", "title", "url", "price", "priority", "notes", "claimed_by", "claimed_at", "is_purchased", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('https://picsum.photos/seed/'||g||'/400'), round((random()*5000)::numeric,2), (ARRAY['low','medium','high'])[1+floor(random()*3)::int]::"wish_priority", ('Sample '||'wishlist items'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (now() - (random()*365||' days')::interval), (random()<0.5), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip wishlist_items: %', SQLERRM; END;

  -- workout_logs (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."workout_logs" ("id", "family_id", "member_id", "activity", "duration_minutes", "calories", "distance", "notes", "recorded_at", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], ('activity'||' '||g), floor(random()*100)::int, floor(random()*100)::int, round((random()*1000)::numeric,2), ('Sample '||'workout logs'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip workout_logs: %', SQLERRM; END;

  -- announcement_reads (5 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."announcement_reads" ("id", "announcement_id", "family_id", "member_id", "read_at")
    SELECT gen_random_uuid(), a_family_announcements[1+((g-1+0) % GREATEST(array_length(a_family_announcements,1),1))], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip announcement_reads: %', SQLERRM; END;

  -- auto_ai_logs (13 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."auto_ai_logs" ("id", "family_id", "user_id", "vehicle_id", "kind", "input", "output", "model", "status", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_vehicles[1+floor(random()*GREATEST(array_length(a_vehicles,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('model'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip auto_ai_logs: %', SQLERRM; END;

  -- auto_insurance_policies (28 cols) -------------------------------------
  BEGIN
    INSERT INTO public."auto_insurance_policies" ("id", "family_id", "vehicle_id", "provider", "policy_number", "naic", "coverage_summary", "liability_limits", "deductible_collision", "deductible_comprehensive", "agent_name", "agent_phone", "claims_phone", "roadside_phone", "effective_on", "expires_on", "premium", "premium_period", "document_id", "is_active", "status", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_vehicles[1+floor(random()*GREATEST(array_length(a_vehicles,1),1))::int] END, ('provider'||' '||g), ('policy_number'||' '||g), ('naic'||' '||g), ('Sample '||'auto insurance policies'||' content generated for testing purposes. Row '||g||'.'), ('liability_limits'||' '||g), round((random()*1000)::numeric,2), round((random()*1000)::numeric,2), ('agent_name'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), round((random()*1000)::numeric,2), ('premium_period'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, (random()<0.5), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('Sample '||'auto insurance policies'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip auto_insurance_policies: %', SQLERRM; END;

  -- auto_service_records (17 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."auto_service_records" ("id", "family_id", "vehicle_id", "title", "service_date", "provider", "cost", "mileage", "description", "next_due_on", "next_due_mileage", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_vehicles[1+floor(random()*GREATEST(array_length(a_vehicles,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (current_date - (floor(random()*730)-365)::int), ('provider'||' '||g), round((random()*5000)::numeric,2), floor(random()*1000)::int, ('Sample '||'auto service records'||' content generated for testing purposes. Row '||g||'.'), (current_date - (floor(random()*730)-365)::int), floor(random()*1000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip auto_service_records: %', SQLERRM; END;

  -- chore_submissions (12 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."chore_submissions" ("id", "family_id", "assignment_id", "chore_id", "member_id", "kind", "media_paths", "note", "status", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_chore_assignments[1+floor(random()*GREATEST(array_length(a_chore_assignments,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_chores[1+floor(random()*GREATEST(array_length(a_chores,1),1))::int] END, a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], (ARRAY['none','photo','video','before_after'])[1+floor(random()*4)::int], ARRAY['item'||g, 'item'||(g+1)], ('Sample '||'chore submissions'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['pending','ai_reviewed','approved','needs_improvement','rejected','parent_review','disputed'])[1+floor(random()*7)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_chore_submissions FROM public."chore_submissions";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chore_submissions: %', SQLERRM; END;

  -- crm_quotes (14 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."crm_quotes" ("id", "contact_id", "deal_id", "title", "status", "amount_cents", "currency", "valid_until", "notes", "sent_at", "responded_at", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_crm_contacts[1+floor(random()*GREATEST(array_length(a_crm_contacts,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_crm_deals[1+floor(random()*GREATEST(array_length(a_crm_deals,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['draft','sent','accepted','declined','expired'])[1+floor(random()*5)::int], floor(random()*500000)::int, (ARRAY['USD','EUR','GBP','CAD'])[1+floor(random()*4)::int], (current_date - (floor(random()*730)-365)::int), ('Sample '||'crm quotes'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip crm_quotes: %', SQLERRM; END;

  -- driver_licenses (20 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."driver_licenses" ("id", "family_id", "member_id", "holder_name", "license_number", "state", "license_class", "endorsements", "restrictions", "issued_on", "expires_on", "status", "document_id", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('holder_name'||' '||g), ('license_number'||' '||g), (ARRAY['CA','TX','NY','WA','CO','FL','IL','MA'])[1+floor(random()*8)::int], ('license_class'||' '||g), ('endorsements'||' '||g), ('restrictions'||' '||g), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, ('Sample '||'driver licenses'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip driver_licenses: %', SQLERRM; END;

  -- event_rsvps (7 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."event_rsvps" ("id", "event_id", "family_id", "member_id", "status", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_calendar_events[1+((g-1+0) % GREATEST(array_length(a_calendar_events,1),1))], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], (ARRAY['accepted','declined','maybe'])[1+floor(random()*3)::int]::"rsvp_status", (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip event_rsvps: %', SQLERRM; END;

  -- family_knowledge_edges (11 cols) --------------------------------------
  BEGIN
    INSERT INTO public."family_knowledge_edges" ("id", "family_id", "source_id", "target_id", "relation", "weight", "status", "metadata", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_knowledge_nodes[1+floor(random()*GREATEST(array_length(a_family_knowledge_nodes,1),1))::int], a_family_knowledge_nodes[1+floor(random()*GREATEST(array_length(a_family_knowledge_nodes,1),1))::int], ('relation'||' '||g), round((random()*1000)::numeric,2), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip family_knowledge_edges: %', SQLERRM; END;

  -- game_results (12 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."game_results" ("id", "family_id", "team_id", "opponent", "our_score", "their_score", "date", "result", "notes", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_teams[1+floor(random()*GREATEST(array_length(a_teams,1),1))::int], ('opponent'||' '||g), (1+floor(random()*5)::int), (1+floor(random()*5)::int), (current_date - (floor(random()*730)-365)::int), (ARRAY['win','loss','tie'])[1+floor(random()*3)::int]::"game_result", ('Sample '||'game results'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip game_results: %', SQLERRM; END;

  -- grades (14 cols) ------------------------------------------------------
  BEGIN
    INSERT INTO public."grades" ("id", "family_id", "member_id", "class_id", "subject", "title", "grade", "grade_type", "score", "max_score", "date", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_school_classes[1+floor(random()*GREATEST(array_length(a_school_classes,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('grade'||' '||g), (ARRAY['test','quiz','homework','project','final','participation','other'])[1+floor(random()*7)::int]::"grade_type", round((random()*1000)::numeric,2), round((random()*1000)::numeric,2), (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip grades: %', SQLERRM; END;

  -- health_visits (16 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."health_visits" ("id", "family_id", "member_id", "provider_id", "kind", "title", "provider_name", "location", "visit_date", "reason", "outcome", "follow_up_date", "cost_cents", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_health_providers[1+floor(random()*GREATEST(array_length(a_health_providers,1),1))::int] END, (ARRAY['medical','dental','vision','mental_health','specialist','vaccination','therapy','urgent_care','other'])[1+floor(random()*9)::int]::"health_visit_kind", ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('provider_name'||' '||g), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (current_date - (floor(random()*730)-365)::int), ('Sample '||'health visits'||' content generated for testing purposes. Row '||g||'.'), ('Sample '||'health visits'||' content generated for testing purposes. Row '||g||'.'), (current_date - (floor(random()*730)-365)::int), floor(random()*500000)::int, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip health_visits: %', SQLERRM; END;

  -- home_ai_logs (13 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."home_ai_logs" ("id", "family_id", "user_id", "asset_id", "kind", "input", "output", "model", "status", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_home_assets[1+floor(random()*GREATEST(array_length(a_home_assets,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('model'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip home_ai_logs: %', SQLERRM; END;

  -- home_service_records (17 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."home_service_records" ("id", "family_id", "home_id", "asset_id", "contractor_id", "title", "service_date", "provider", "cost", "description", "next_due_on", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_homes[1+floor(random()*GREATEST(array_length(a_homes,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_home_assets[1+floor(random()*GREATEST(array_length(a_home_assets,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_home_contractors[1+floor(random()*GREATEST(array_length(a_home_contractors,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (current_date - (floor(random()*730)-365)::int), ('provider'||' '||g), round((random()*5000)::numeric,2), ('Sample '||'home service records'||' content generated for testing purposes. Row '||g||'.'), (current_date - (floor(random()*730)-365)::int), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip home_service_records: %', SQLERRM; END;

  -- home_warranties (25 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."home_warranties" ("id", "family_id", "home_id", "asset_id", "name", "provider", "warranty_type", "policy_number", "coverage", "starts_on", "expires_on", "cost", "premium_period", "claim_phone", "claim_url", "claim_email", "document_id", "status", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_homes[1+floor(random()*GREATEST(array_length(a_homes,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_home_assets[1+floor(random()*GREATEST(array_length(a_home_assets,1),1))::int] END, ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('provider'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('policy_number'||' '||g), ('coverage'||' '||g), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), round((random()*5000)::numeric,2), ('premium_period'||' '||g), ('+1'||lpad((floor(random()*1e10))::bigint::text,10,'0')), ('https://picsum.photos/seed/'||g||'/400'), ('person'||g||'@example.com'), CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('Sample '||'home warranties'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip home_warranties: %', SQLERRM; END;

  -- maintenance_tasks (15 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."maintenance_tasks" ("id", "family_id", "asset_id", "title", "description", "status", "priority", "recurrence", "interval_days", "due_at", "completed_at", "assignee_id", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_home_assets[1+floor(random()*GREATEST(array_length(a_home_assets,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'maintenance tasks'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['todo','in_progress','done','approved','rejected'])[1+floor(random()*5)::int]::"task_status", (ARRAY['low','medium','high','urgent'])[1+floor(random()*4)::int]::"priority", (ARRAY['none','daily','weekly','monthly','yearly'])[1+floor(random()*5)::int]::"recurrence_freq", (1+floor(random()*28)::int), (now() + (random()*60||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip maintenance_tasks: %', SQLERRM; END;

  -- marketing_form_submissions (6 cols) ----------------------------------
  BEGIN
    INSERT INTO public."marketing_form_submissions" ("id", "form_id", "email", "data", "source", "created_at")
    SELECT gen_random_uuid(), a_marketing_forms[1+floor(random()*GREATEST(array_length(a_marketing_forms,1),1))::int], ('person'||g||'@example.com'), jsonb_build_object('seed', g, 'note', 'sample'), ('source'||' '||g), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_form_submissions: %', SQLERRM; END;

  -- marketing_suppressions (4 cols) --------------------------------------
  BEGIN
    INSERT INTO public."marketing_suppressions" ("email", "reason", "campaign_id", "created_at")
    SELECT ('person'||g||'@example.com'), (ARRAY['unsubscribe','bounce','complaint','manual'])[1+floor(random()*4)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_marketing_email_campaigns[1+floor(random()*GREATEST(array_length(a_marketing_email_campaigns,1),1))::int] END, (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip marketing_suppressions: %', SQLERRM; END;

  -- meal_vote_ballots (8 cols) -------------------------------------------
  BEGIN
    INSERT INTO public."meal_vote_ballots" ("id", "vote_id", "option_id", "family_id", "member_id", "choice", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_meal_votes[1+floor(random()*GREATEST(array_length(a_meal_votes,1),1))::int], a_meal_vote_options[1+((g-1+0) % GREATEST(array_length(a_meal_vote_options,1),1))], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_family_members[1+((g-1+0) % GREATEST(array_length(a_family_members,1),1))], (ARRAY['yes','no','maybe'])[1+floor(random()*3)::int], (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip meal_vote_ballots: %', SQLERRM; END;

  -- medication_schedules (10 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."medication_schedules" ("id", "family_id", "medication_id", "time_of_day", "days_of_week", "starts_on", "ends_on", "last_taken_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_medications[1+floor(random()*GREATEST(array_length(a_medications,1),1))::int], (time '00:00' + (floor(random()*86400)||' seconds')::interval), ARRAY[floor(random()*100)::int], (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_medication_schedules FROM public."medication_schedules";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip medication_schedules: %', SQLERRM; END;

  -- mkt_sessions (8 cols) ------------------------------------------------
  BEGIN
    INSERT INTO public."mkt_sessions" ("id", "visitor_id", "source", "medium", "campaign", "landing_path", "page_views", "started_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_mkt_visitors[1+floor(random()*GREATEST(array_length(a_mkt_visitors,1),1))::int] END, ('source'||' '||g), ('medium'||' '||g), ('campaign'||' '||g), ('landing_path'||' '||g), floor(random()*1000)::int, (now() - (random()*60||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip mkt_sessions: %', SQLERRM; END;

  -- mkt_touchpoints (7 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."mkt_touchpoints" ("id", "visitor_id", "source", "medium", "campaign", "kind", "occurred_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_mkt_visitors[1+floor(random()*GREATEST(array_length(a_mkt_visitors,1),1))::int] END, ('source'||' '||g), ('medium'||' '||g), ('campaign'||' '||g), (ARRAY['touch','conversion'])[1+floor(random()*2)::int], (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip mkt_touchpoints: %', SQLERRM; END;

  -- rental_cars (22 cols) -------------------------------------------------
  BEGIN
    INSERT INTO public."rental_cars" ("id", "family_id", "company", "confirmation_number", "pickup_location", "dropoff_location", "pickup_at", "return_at", "vehicle_desc", "daily_rate", "total_cost", "coverage", "driver_member_id", "status", "document_id", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ('company'||' '||g), ('confirmation_number'||' '||g), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), ('Sample '||'rental cars'||' content generated for testing purposes. Row '||g||'.'), round((random()*5000)::numeric,2), round((random()*5000)::numeric,2), ('coverage'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, ('Sample '||'rental cars'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip rental_cars: %', SQLERRM; END;

  -- reward_redemptions (12 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."reward_redemptions" ("id", "family_id", "reward_id", "member_id", "reward_title", "cost_points", "status", "note", "decided_by", "decided_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_rewards[1+floor(random()*GREATEST(array_length(a_rewards,1),1))::int] END, a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), floor(random()*500000)::int, (ARRAY['requested','approved','fulfilled','rejected'])[1+floor(random()*4)::int]::"redemption_status", ('Sample '||'reward redemptions'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip reward_redemptions: %', SQLERRM; END;

  -- rides (16 cols) -------------------------------------------------------
  BEGIN
    INSERT INTO public."rides" ("id", "family_id", "title", "ride_date", "pickup_time", "dropoff_time", "pickup_location", "dropoff_location", "driver_id", "rider_ids", "status", "notes", "event_id", "created_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (current_date - (floor(random()*730)-365)::int), (time '00:00' + (floor(random()*86400)||' seconds')::interval), (time '00:00' + (floor(random()*86400)||' seconds')::interval), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ARRAY[gen_random_uuid()], (ARRAY['planned','confirmed','completed','cancelled'])[1+floor(random()*4)::int]::"ride_status", ('Sample '||'rides'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_calendar_events[1+floor(random()*GREATEST(array_length(a_calendar_events,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip rides: %', SQLERRM; END;

  -- social_ai_generations (16 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."social_ai_generations" ("id", "family_id", "user_id", "post_id", "kind", "platform", "prompt", "input", "output", "model", "tokens", "status", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('prompt'||' '||g), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), ('model'||' '||g), floor(random()*1000)::int, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_ai_generations: %', SQLERRM; END;

  -- social_analytics_snapshots (22 cols) ----------------------------------
  BEGIN
    INSERT INTO public."social_analytics_snapshots" ("id", "family_id", "account_id", "post_id", "platform", "captured_for", "impressions", "reach", "likes", "comments", "shares", "saves", "clicks", "views", "watch_time_seconds", "followers", "engagement_rate", "metrics", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", (current_date - (floor(random()*730)-365)::int), floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*100)::int, floor(random()*1000)::int, round((random()*5000)::numeric,2), jsonb_build_object('seed', g, 'note', 'sample'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_analytics_snapshots: %', SQLERRM; END;

  -- social_calendar_items (13 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."social_calendar_items" ("id", "family_id", "post_id", "campaign_id", "title", "platform", "scheduled_for", "status", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_campaigns[1+floor(random()*GREATEST(array_length(a_social_campaigns,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", (now() - (random()*365||' days')::interval), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_calendar_items: %', SQLERRM; END;

  -- social_comments (21 cols) ---------------------------------------------
  BEGIN
    INSERT INTO public."social_comments" ("id", "family_id", "account_id", "platform", "provider_object_id", "feed_item_id", "parent_provider_id", "kind", "author_name", "author_handle", "body", "permalink_url", "status", "assigned_to", "posted_at", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('provider_object_id'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_social_feed_items[1+floor(random()*GREATEST(array_length(a_social_feed_items,1),1))::int] END, ('parent_provider_id'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('Sample '||'social comments'||' content generated for testing purposes. Row '||g||'.'), ('https://picsum.photos/seed/'||g||'/400'), (ARRAY['open','resolved','ignored','snoozed'])[1+floor(random()*4)::int]::"social_inbox_status", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_comments: %', SQLERRM; END;

  -- social_post_assets (11 cols) ------------------------------------------
  BEGIN
    INSERT INTO public."social_post_assets" ("id", "post_id", "family_id", "asset_id", "platform", "position", "role", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_social_media_library[1+floor(random()*GREATEST(array_length(a_social_media_library,1),1))::int], (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", floor(random()*100)::int, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_post_assets: %', SQLERRM; END;

  -- social_post_targets (16 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."social_post_targets" ("id", "post_id", "family_id", "account_id", "platform", "status", "provider_object_id", "permalink_url", "error", "scheduled_for", "published_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", (ARRAY['pending','publishing','published','failed','skipped','canceled'])[1+floor(random()*6)::int]::"social_target_status", ('provider_object_id'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('error'||' '||g), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_post_targets FROM public."social_post_targets";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_post_targets: %', SQLERRM; END;

  -- social_post_variants (14 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."social_post_variants" ("id", "post_id", "family_id", "platform", "body", "hashtags", "mentions", "char_count", "status", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_posts[1+((g-1+0) % GREATEST(array_length(a_social_posts,1),1))], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", ('Sample '||'social post variants'||' content generated for testing purposes. Row '||g||'.'), ARRAY['item'||g, 'item'||(g+1)], ARRAY['item'||g, 'item'||(g+1)], floor(random()*100)::int, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_post_variants: %', SQLERRM; END;

  -- social_publish_jobs (15 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."social_publish_jobs" ("id", "post_id", "family_id", "status", "scheduled_for", "attempts", "max_attempts", "next_attempt_at", "idempotency_key", "last_error", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['queued','running','succeeded','failed','dead_letter','canceled'])[1+floor(random()*6)::int]::"social_job_status", (now() - (random()*365||' days')::interval), floor(random()*1000)::int, floor(random()*100)::int, (now() + (random()*60||' days')::interval), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('last_error'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_social_publish_jobs FROM public."social_publish_jobs";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_publish_jobs: %', SQLERRM; END;

  -- social_schedules (12 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."social_schedules" ("id", "post_id", "family_id", "scheduled_for", "timezone", "recurrence", "status", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (now() - (random()*365||' days')::interval), (ARRAY['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'])[1+floor(random()*4)::int], ('recurrence'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_schedules: %', SQLERRM; END;

  -- sync_calendar_events (30 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."sync_calendar_events" ("id", "calendar_id", "user_id", "family_id", "provider", "external_id", "uid", "title", "description", "location", "starts_at", "ends_at", "all_day", "timezone", "recurrence_rule", "recurrence_id", "color", "reminders", "status", "etag", "deleted_at", "sync_direction", "sync_status", "content_hash", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_calendars[1+floor(random()*GREATEST(array_length(a_sync_calendars,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ('uid'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'sync calendar events'||' content generated for testing purposes. Row '||g||'.'), (floor(random()*9999)::int||' '||(ARRAY['Main St','Oak Ave','Maple Dr','Elm St','Cedar Ln','Park Rd'])[1+floor(random()*6)::int]), (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), (random()<0.5), (ARRAY['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'])[1+floor(random()*4)::int], ('recurrence_rule'||' '||g), ('recurrence_id'||' '||g), (ARRAY['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'])[1+floor(random()*7)::int], jsonb_build_object('seed', g, 'note', 'sample'), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('etag'||' '||g), (now() - (random()*365||' days')::interval), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('Sample '||'sync calendar events'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
    SELECT array_agg("id") INTO a_sync_calendar_events FROM public."sync_calendar_events";
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_calendar_events: %', SQLERRM; END;

  -- sync_calendar_shares (18 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."sync_calendar_shares" ("id", "calendar_id", "user_id", "family_id", "provider", "external_id", "shared_with_member", "shared_with_email", "permission", "sync_direction", "sync_status", "revoked_at", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_calendars[1+floor(random()*GREATEST(array_length(a_sync_calendars,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('person'||g||'@example.com'), ('permission'||' '||g), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_calendar_shares: %', SQLERRM; END;

  -- sync_conflict_resolutions (17 cols) -----------------------------------
  BEGIN
    INSERT INTO public."sync_conflict_resolutions" ("id", "conflict_id", "user_id", "family_id", "provider", "external_id", "resolution", "resolved_by", "sync_direction", "sync_status", "result_snapshot", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_conflicts[1+floor(random()*GREATEST(array_length(a_sync_conflicts,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['keep_local','keep_remote','merge','duplicate','manual'])[1+floor(random()*5)::int]::"sync_conflict_resolution", CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_conflict_resolutions: %', SQLERRM; END;

  -- sync_job_runs (22 cols) -----------------------------------------------
  BEGIN
    INSERT INTO public."sync_job_runs" ("id", "job_id", "user_id", "family_id", "provider", "external_id", "status", "sync_status", "items_imported", "items_exported", "items_skipped", "conflicts_found", "started_at", "finished_at", "duration_ms", "error", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_jobs[1+floor(random()*GREATEST(array_length(a_sync_jobs,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), (ARRAY['queued','running','succeeded','failed','dead_letter','cancelled'])[1+floor(random()*6)::int]::"sync_job_status", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, floor(random()*1000)::int, (now() - (random()*60||' days')::interval), (now() + (random()*60||' days')::interval), floor(random()*100)::int, ('error'||' '||g), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_job_runs: %', SQLERRM; END;

  -- sync_notes (23 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."sync_notes" ("id", "folder_id", "user_id", "family_id", "provider", "external_id", "title", "body_markdown", "body_html", "checklist", "tags", "version", "etag", "deleted_at", "sync_direction", "sync_status", "content_hash", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_sync_note_folders[1+floor(random()*GREATEST(array_length(a_sync_note_folders,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'sync notes'||' content generated for testing purposes. Row '||g||'.'), ('Sample '||'sync notes'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), ARRAY['item'||g, 'item'||(g+1)], floor(random()*1000)::int, ('etag'||' '||g), (now() - (random()*365||' days')::interval), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('Sample '||'sync notes'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_notes: %', SQLERRM; END;

  -- sync_reminders (27 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."sync_reminders" ("id", "list_id", "user_id", "family_id", "provider", "external_id", "title", "notes", "due_at", "all_day", "recurrence_rule", "priority", "is_completed", "completed_at", "assigned_member", "reminders", "etag", "deleted_at", "sync_direction", "sync_status", "content_hash", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_reminder_lists[1+floor(random()*GREATEST(array_length(a_sync_reminder_lists,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'sync reminders'||' content generated for testing purposes. Row '||g||'.'), (now() + (random()*60||' days')::interval), (random()<0.5), ('recurrence_rule'||' '||g), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (random()<0.5), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), ('etag'||' '||g), (now() - (random()*365||' days')::interval), (ARRAY['import','export','two_way','manual','disabled'])[1+floor(random()*5)::int]::"sync_direction", (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", ('Sample '||'sync reminders'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_reminders: %', SQLERRM; END;

  -- todo_items (15 cols) --------------------------------------------------
  BEGIN
    INSERT INTO public."todo_items" ("id", "family_id", "list_id", "created_by", "assigned_to_id", "title", "notes", "is_done", "priority", "due_date", "tags", "sort_order", "completed_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_todo_lists[1+floor(random()*GREATEST(array_length(a_todo_lists,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ((ARRAY['Weekly','Family','Quick','Important','Monthly','Special','Annual','Daily'])[1+floor(random()*8)::int]||' '||(ARRAY['update','note','plan','reminder','task','review','summary','event'])[1+floor(random()*8)::int]||' #'||g), ('Sample '||'todo items'||' content generated for testing purposes. Row '||g||'.'), (random()<0.5), (ARRAY['low','medium','high','urgent'])[1+floor(random()*4)::int], (current_date - (floor(random()*730)-365)::int), ARRAY['item'||g, 'item'||(g+1)], floor(random()*100)::int, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip todo_items: %', SQLERRM; END;

  -- vehicle_inspections (16 cols) -----------------------------------------
  BEGIN
    INSERT INTO public."vehicle_inspections" ("id", "family_id", "vehicle_id", "inspection_type", "station", "inspected_on", "expires_on", "result", "document_id", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_vehicles[1+floor(random()*GREATEST(array_length(a_vehicles,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('station'||' '||g), (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), ('result'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, ('Sample '||'vehicle inspections'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip vehicle_inspections: %', SQLERRM; END;

  -- vehicle_registrations (17 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."vehicle_registrations" ("id", "family_id", "vehicle_id", "plate", "state", "registered_on", "expires_on", "fee", "document_id", "status", "notes", "created_by", "updated_by", "deleted_at", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_vehicles[1+floor(random()*GREATEST(array_length(a_vehicles,1),1))::int] END, ('plate'||' '||g), (ARRAY['CA','TX','NY','WA','CO','FL','IL','MA'])[1+floor(random()*8)::int], (current_date - (floor(random()*730)-365)::int), (current_date - (floor(random()*730)-365)::int), round((random()*5000)::numeric,2), CASE WHEN random()<0.1 THEN NULL ELSE a_documents[1+floor(random()*GREATEST(array_length(a_documents,1),1))::int] END, (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], ('Sample '||'vehicle registrations'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip vehicle_registrations: %', SQLERRM; END;

  -- chore_ai_validations (17 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."chore_ai_validations" ("id", "family_id", "submission_id", "status", "quality_score", "confidence", "recommended_reward_type", "recommended_reward_amount", "kid_feedback", "parent_summary", "detected_issues", "safety_flags", "needs_parent_review", "model", "is_fallback", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_chore_submissions[1+floor(random()*GREATEST(array_length(a_chore_submissions,1),1))::int], (ARRAY['approved','needs_improvement','unclear','rejected','parent_review_required'])[1+floor(random()*5)::int], (1+floor(random()*5)::int), floor(random()*1000)::int, (ARRAY['cash','points','prize','none'])[1+floor(random()*4)::int], round((random()*5000)::numeric,2), ('kid_feedback'||' '||g), ('Sample '||'chore ai validations'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), jsonb_build_object('seed', g, 'note', 'sample'), (random()<0.5), ('model'||' '||g), (random()<0.5), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chore_ai_validations: %', SQLERRM; END;

  -- chore_approval_events (10 cols) ---------------------------------------
  BEGIN
    INSERT INTO public."chore_approval_events" ("id", "family_id", "assignment_id", "submission_id", "actor_id", "action", "points_awarded", "cash_cents", "note", "created_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_chore_assignments[1+floor(random()*GREATEST(array_length(a_chore_assignments,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_chore_submissions[1+floor(random()*GREATEST(array_length(a_chore_submissions,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (ARRAY['submit','ai_validate','approve','adjust','reject','redo','dispute','resolve','auto_approve'])[1+floor(random()*9)::int], floor(random()*100)::int, floor(random()*500000)::int, ('Sample '||'chore approval events'||' content generated for testing purposes. Row '||g||'.'), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chore_approval_events: %', SQLERRM; END;

  -- chore_disputes (11 cols) ----------------------------------------------
  BEGIN
    INSERT INTO public."chore_disputes" ("id", "family_id", "submission_id", "member_id", "reason", "status", "resolution", "resolved_by", "resolved_at", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_chore_submissions[1+floor(random()*GREATEST(array_length(a_chore_submissions,1),1))::int], a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int], ('Sample '||'chore disputes'||' content generated for testing purposes. Row '||g||'.'), (ARRAY['open','resolved','cancelled'])[1+floor(random()*3)::int], ('resolution'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip chore_disputes: %', SQLERRM; END;

  -- medication_doses (12 cols) --------------------------------------------
  BEGIN
    INSERT INTO public."medication_doses" ("id", "family_id", "medication_id", "schedule_id", "member_id", "scheduled_for", "status", "taken_at", "notes", "logged_by", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], a_medications[1+floor(random()*GREATEST(array_length(a_medications,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_medication_schedules[1+floor(random()*GREATEST(array_length(a_medication_schedules,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, (now() - (random()*365||' days')::interval), (ARRAY['taken','skipped','missed'])[1+floor(random()*3)::int]::"dose_status", (now() - (random()*365||' days')::interval), ('Sample '||'medication doses'||' content generated for testing purposes. Row '||g||'.'), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip medication_doses: %', SQLERRM; END;

  -- social_publish_results (18 cols) --------------------------------------
  BEGIN
    INSERT INTO public."social_publish_results" ("id", "job_id", "target_id", "post_id", "family_id", "account_id", "platform", "status", "provider_object_id", "permalink_url", "error_code", "error_message", "raw_response", "attempted_at", "created_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), CASE WHEN random()<0.1 THEN NULL ELSE a_social_publish_jobs[1+floor(random()*GREATEST(array_length(a_social_publish_jobs,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_social_post_targets[1+floor(random()*GREATEST(array_length(a_social_post_targets,1),1))::int] END, a_social_posts[1+floor(random()*GREATEST(array_length(a_social_posts,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], CASE WHEN random()<0.1 THEN NULL ELSE a_social_accounts[1+floor(random()*GREATEST(array_length(a_social_accounts,1),1))::int] END, (ARRAY['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'])[1+floor(random()*9)::int]::"social_platform", (ARRAY['pending','publishing','published','failed','skipped','canceled'])[1+floor(random()*6)::int]::"social_target_status", ('provider_object_id'||' '||g), ('https://picsum.photos/seed/'||g||'/400'), ('social'||'-'||g||'-'||floor(random()*100000)::int), ('Sample '||'social publish results'||' content generated for testing purposes. Row '||g||'.'), jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip social_publish_results: %', SQLERRM; END;

  -- sync_event_attendees (17 cols) ----------------------------------------
  BEGIN
    INSERT INTO public."sync_event_attendees" ("id", "event_id", "family_id", "provider", "external_id", "member_id", "email", "display_name", "response_status", "is_organizer", "sync_status", "last_synced_at", "created_by", "updated_by", "metadata", "created_at", "updated_at")
    SELECT gen_random_uuid(), a_sync_calendar_events[1+floor(random()*GREATEST(array_length(a_sync_calendar_events,1),1))::int], a_families[1+floor(random()*GREATEST(array_length(a_families,1),1))::int], (ARRAY['google','microsoft','apple','amazon','internal'])[1+floor(random()*5)::int]::"sync_provider", ('external_id'||' '||g), CASE WHEN random()<0.1 THEN NULL ELSE a_family_members[1+floor(random()*GREATEST(array_length(a_family_members,1),1))::int] END, ('person'||g||'@example.com'), ((ARRAY['Alex','Jordan','Taylor','Casey','Sam','Riley','Jamie','Morgan'])[1+floor(random()*8)::int]||' '||(ARRAY['Smith','Lee','Patel','Kim','Garcia','Brown'])[1+floor(random()*6)::int]), (ARRAY['active','pending','completed','default','general','standard'])[1+floor(random()*6)::int], (random()<0.5), (ARRAY['pending','syncing','synced','error','conflict','disabled','unsupported'])[1+floor(random()*7)::int]::"sync_status", (now() - (random()*365||' days')::interval), CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, CASE WHEN random()<0.1 THEN NULL ELSE a_auth_users[1+floor(random()*GREATEST(array_length(a_auth_users,1),1))::int] END, jsonb_build_object('seed', g, 'note', 'sample'), (now() - (random()*365||' days')::interval), (now() - (random()*365||' days')::interval)
    FROM generate_series(1,500) AS gs(g) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'skip sync_event_attendees: %', SQLERRM; END;

END $$;

SET session_replication_role = origin;

-- Done. Row counts per table:
-- SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;
