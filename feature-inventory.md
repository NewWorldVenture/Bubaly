# Feature Inventory

Every dashboard feature and the Supabase tables its page/actions/module touch directly
(engine-driven pages may reach further via `lib/*` helpers). UX tier per feature:
`todo.md` UI/UX matrix. Seed coverage: `supabase/SEED_ALL.sql`.

| Feature | Direct tables |
|---|---|
| `/dashboard/activity` | `calendar_events`, `chore_assignments`, `chores`, `family_announcements`, `family_members`, `family_photos`, `grocery_items`, `notes` |
| `/dashboard/agents` | `agent_activity`, `approval_requests`, `bills`, `calendar_events`, `chore_assignments`, `documents`, `family_members`, `family_photos` +5 more |
| `/dashboard/announcements` | `announcement_reads`, `family_announcements` |
| `/dashboard/app-store` | `family_app_installs`, `family_apps` |
| `/dashboard/assistant` | `ai_conversations`, `ai_messages`, `calendar_events`, `chore_assignments`, `medications`, `reminders` |
| `/dashboard/auto` | `auto_insurance_policies`, `auto_service_records`, `driver_licenses`, `rental_cars`, `vehicle_inspections`, `vehicle_registrations`, `vehicles` |
| `/dashboard/autonomous-family-management` | `family_ai_recommendations`, `family_automation_rules`, `family_automation_runs` |
| `/dashboard/autopay` | `bills` |
| `/dashboard/autopilot` | `autopilot_suggestions`, `family_reminders` |
| `/dashboard/behavior` | `behavior_logs` |
| `/dashboard/billing` | `bills`, `budgets`, `financial_accounts`, `savings_goals`, `stripe_settings`, `subscriptions`, `transactions` |
| `/dashboard/bills` | `bills` |
| `/dashboard/binder` | `household_info` |
| `/dashboard/briefing` | `calendar_events`, `family_operating_index`, `reminders` |
| `/dashboard/budgets` | `budgets`, `transactions` |
| `/dashboard/calendar` | `calendar_events` |
| `/dashboard/calm` | `agent_activity`, `approval_requests`, `autopilot_suggestions`, `family_operating_index`, `reminders` |
| `/dashboard/care` | `care_log` |
| `/dashboard/celebrations` | `family_dates` |
| `/dashboard/chores` | `chore_assignments`, `chores`, `reward_redemptions`, `rewards` |
| `/dashboard/command-center` | `calendar_events`, `chore_assignments`, `documents`, `family_members`, `meal_plans` |
| `/dashboard/concierge-calls` | `concierge_calls` |
| `/dashboard/concierge` | `approval_requests`, `calendar_events`, `concierge_plan_actions`, `concierge_plans`, `family_automation_runs`, `family_reminders`, `trust_policies` |
| `/dashboard/conflicts` | `calendar_events`, `family_members` |
| `/dashboard/connections` | `family_connections` |
| `/dashboard/contacts` | `family_contacts` |
| `/dashboard/decisions` | `decision_options`, `family_decisions` |
| `/dashboard/dental` | `health_providers`, `health_visits`, `insurance_policies`, `medical_profiles`, `medications` |
| `/dashboard/devices` | `smart_devices` |
| `/dashboard/dining` | `dining_out` |
| `/dashboard/documents` | `documents` |
| `/dashboard/due` | `bills` |
| `/dashboard/expenses` | `expense_split_shares`, `expense_splits` |
| `/dashboard/experience` | `experience_audits` |
| `/dashboard/family-access` | `child_logins`, `family_members` |
| `/dashboard/family-automation` | `family_automation_rules`, `family_automation_runs` |
| `/dashboard/family-cfo` | `bills`, `budgets`, `financial_accounts`, `savings_goals`, `transactions` |
| `/dashboard/family-coo` | `calendar_events`, `chore_assignments`, `chores`, `family_members`, `family_routines`, `grocery_items`, `maintenance_tasks` |
| `/dashboard/family-digital-twin` | `budgets`, `calendar_events`, `family_digital_twin_profiles`, `family_members`, `family_routines`, `goals`, `school_classes`, `teams` +3 more |
| `/dashboard/family-emergency` | `family_emergency_contacts`, `family_emergency_plans`, `family_members`, `medical_profiles` |
| `/dashboard/family-health` | `appointments`, `family_members`, `health_providers`, `medical_profiles`, `medications` |
| `/dashboard/family-operating-index` | (via lib/* engines) |
| `/dashboard/family-operations` | (via lib/* engines) |
| `/dashboard/family-school` | `family_members`, `grades`, `school_classes`, `school_events` |
| `/dashboard/family-signals` | `family_signals` |
| `/dashboard/family-sports` | `family_members`, `game_results`, `sports_events`, `teams` |
| `/dashboard/family-stress` | `family_members`, `family_stress_signals` |
| `/dashboard/family-tree` | `family_tree_nodes` |
| `/dashboard/family` | `calendar_events`, `documents`, `families`, `family_albums`, `family_contacts`, `family_credentials`, `family_members`, `medical_profiles` +2 more |
| `/dashboard/favorites` | `family_favorites` |
| `/dashboard/focus` | `calendar_events`, `chore_assignments`, `family_members`, `todo_items` |
| `/dashboard/food` | `dining_out`, `family_food_scores`, `family_recipes`, `grocery_items`, `meal_plans`, `meals`, `pantry_items` |
| `/dashboard/front-desk` | `call_logs`, `family_contacts`, `family_reminders`, `front_desk_settings` |
| `/dashboard/goals` | `goals` |
| `/dashboard/grandparent-portal` | `families`, `family_announcements`, `family_dates`, `family_members`, `family_milestones`, `family_photos` |
| `/dashboard/graph` | `graph_edges`, `graph_entities` |
| `/dashboard/grocery` | `grocery_items`, `grocery_lists` |
| `/dashboard/habits` | `habit_logs`, `habits` |
| `/dashboard/health` | `appointments`, `health_goals`, `health_metrics`, `reminders`, `symptom_logs`, `workout_logs` |
| `/dashboard/home` | `documents`, `home_assets`, `home_contractors`, `home_service_records`, `home_warranties`, `maintenance_tasks` |
| `/dashboard/homework` | `homework_assignments` |
| `/dashboard/inbox` | `family_communications`, `family_contacts`, `family_reminders` |
| `/dashboard/independence` | `family_members`, `independence_milestones` |
| `/dashboard/insurance` | `family_insurance_policies` |
| `/dashboard/intelligence` | `family_members`, `meal_plans`, `network_aggregates`, `network_consent`, `school_classes`, `teams` |
| `/dashboard/journal` | `journal_entries` |
| `/dashboard/journeys` | `journey_events` |
| `/dashboard/kitchen` | `family_food_scores`, `family_recipes`, `grocery_items`, `leftover_inventory`, `meal_nutrition`, `meal_plans`, `pantry_items` |
| `/dashboard/knowledge` | `family_facts` |
| `/dashboard/life-events` | `family_facts`, `life_event_plan_items`, `life_event_plans` |
| `/dashboard/locator` | `family_members`, `family_places`, `location_events`, `member_locations`, `notifications` |
| `/dashboard/meals` | `family_recipes`, `grocery_items`, `meal_plans`, `meal_vote_ballots`, `meal_vote_options`, `meal_votes`, `meals` |
| `/dashboard/medical` | `health_providers`, `health_visits`, `immunizations`, `insurance_policies`, `medical_profiles`, `medications` |
| `/dashboard/medications` | `medication_doses`, `medication_schedules`, `medications` |
| `/dashboard/memories` | `calendar_events`, `family_albums`, `family_members`, `family_memories`, `family_photos` |
| `/dashboard/messages` | `family_conversations`, `family_messages` |
| `/dashboard/migrate` | `audit_logs`, `calendar_events`, `chores`, `grocery_items`, `grocery_lists`, `notes` |
| `/dashboard/moments` | `calendar_events`, `family_members`, `homework_assignments`, `moment_activations`, `vacations` |
| `/dashboard/money-timeline` | `money_timeline_insights` |
| `/dashboard/more` | (via lib/* engines) |
| `/dashboard/next-best-actions` | `calendar_events`, `opportunities`, `todo_items` |
| `/dashboard/notes` | `notes` |
| `/dashboard/notifications` | `notifications` |
| `/dashboard/nutrition` | `nutrition_logs` |
| `/dashboard/onboarding-funnel` | `activation_events`, `onboarding_events` |
| `/dashboard/outcomes` | `calendar_events`, `family_members`, `grocery_items`, `todo_items` |
| `/dashboard/pantry` | `grocery_items`, `grocery_lists`, `pantry_items` |
| `/dashboard/paperwork` | `calendar_events`, `family_reminders`, `paperwork_items` |
| `/dashboard/passwords` | `family_credentials` |
| `/dashboard/payments` | `transactions` |
| `/dashboard/pets` | `pet_care_records`, `pets` |
| `/dashboard/photos` | `family_albums`, `family_photos` |
| `/dashboard/planning` | `calendar_events`, `documents`, `family_contacts`, `family_milestones`, `family_photos`, `family_reminders`, `notes`, `todo_items` |
| `/dashboard/playbook` | `calendar_events`, `family_facts`, `family_favorites`, `family_playbook_suggestions`, `grocery_items`, `meal_plans`, `meals`, `vacations` |
| `/dashboard/prep-plans` | `prep_plan_steps`, `prep_plans` |
| `/dashboard/profile` | `calendar_events`, `chore_assignments`, `family_members`, `independence_milestones` |
| `/dashboard/readiness` | `bills`, `calendar_events`, `chore_assignments`, `documents`, `family_members`, `grocery_items`, `meal_plans`, `prep_plan_steps` +3 more |
| `/dashboard/reasoning` | (via lib/* engines) |
| `/dashboard/recipes` | `family_recipes`, `grocery_items`, `grocery_lists` |
| `/dashboard/relationship` | `calendar_events`, `relationship_dates`, `relationship_gift_ideas`, `relationship_profile`, `wishlist_items` |
| `/dashboard/reminders` | `family_reminders`, `reminder_lists` |
| `/dashboard/renewals` | `renewals` |
| `/dashboard/rewards` | `chore_assignments`, `reward_redemptions`, `rewards` |
| `/dashboard/rides` | `rides` |
| `/dashboard/savings` | `savings_goals` |
| `/dashboard/scan` | (via lib/* engines) |
| `/dashboard/school` | `grades`, `school_classes`, `school_events` |
| `/dashboard/screen-time` | `screen_time_entries`, `screen_time_limits` |
| `/dashboard/security` | `home_security_events` |
| `/dashboard/settings` | `crm_contact_profile`, `crm_contacts`, `families`, `family_members`, `invites`, `profiles` |
| `/dashboard/setup` | `family_onboarding` |
| `/dashboard/signups` | `opportunities` |
| `/dashboard/social-feed` | `social_reader_items`, `social_reader_sources` |
| `/dashboard/social` | `social_access_permissions`, `social_accounts`, `social_calendar_items`, `social_comments`, `social_media_library`, `social_post_variants`, `social_posts`, `social_schedules` +1 more |
| `/dashboard/sports` | `game_results`, `sports_events`, `teams` |
| `/dashboard/subscriptions` | `subscriptions_tracked` |
| `/dashboard/sync` | `sync_calendars`, `sync_conflicts`, `sync_connections`, `sync_job_runs` |
| `/dashboard/tax-vault` | `tax_documents` |
| `/dashboard/timetable` | `school_classes` |
| `/dashboard/todos` | `todo_items`, `todo_lists` |
| `/dashboard/trip-intel` | `calendar_events`, `departure_plans`, `family_members`, `trip_plans` |
| `/dashboard/trip-memories` | `trip_memories`, `vacations` |
| `/dashboard/trips` | `trip_items`, `trips` |
| `/dashboard/trust` | `approval_requests`, `emergency_sessions`, `family_members`, `permission_grants`, `trust_audit_logs`, `trust_delegations`, `trust_policies` |
| `/dashboard/utilities` | `utility_bills` |
| `/dashboard/vacations` | `vacation_members`, `vacation_travel_scores`, `vacations` |
| `/dashboard/voice` | `voice_commands` |
| `/dashboard/voting` | `budgets`, `family_poll_options`, `family_poll_votes`, `family_polls`, `vacations` |
| `/dashboard/weather` | `weather_locations` |
| `/dashboard/weekend` | `weekend_events`, `weekend_feeds`, `weekend_plans`, `weekend_searches` |
| `/dashboard/weekly-briefing` | (via lib/* engines) |
| `/dashboard/wishlists` | `wishlist_items` |
| `/dashboard/workload` | `calendar_events`, `chore_assignments`, `chores`, `family_members`, `todo_items`, `workload_snapshots` |

**133 features.** Cross-feature intelligence (capture→task, concierge
write-back, autopilot, knowledge graph) documented in `architecture.md`.
