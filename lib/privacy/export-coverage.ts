// lib/privacy/export-coverage.ts — what the family export covers, and what it
// does not. Importable from the browser (no 'server-only'): the Privacy Center
// may read it to say what the file leaves out.
//
// The export reads twelve sections (lib/privacy/export.ts). Its only omission
// list used to be `withheld`, which names the sections a ROLE does not get; it
// said nothing about the modules the export never reads at all — health,
// journal, locations, credentials, wallet, and most of the other tables that
// carry a member id — while the Privacy Center and the privacy policy presented
// the file as a copy of the family's data and the Privacy Center recommended it
// before a deletion request. The file now names those modules in `notIncluded`,
// and tests/an-export-names-what-it-leaves-out.test.ts holds this inventory to
// the migrations: every table carrying a `member_id` is either read by a
// section or named here, so a module added tomorrow is an honest omission from
// the day it ships rather than a silent one. (The member-keyed tables no
// application code touches at all — AUTHZ-020's list — are not named here:
// the app never writes them, so there is nothing of the family's in them for
// the file to leave out, and naming one would trip that tripwire.)

/**
 * The tables each export section reads (lib/privacy/export.ts readSection),
 * the ones that carry a person's row at least: `family_members` (by user),
 * `calendar_events` (by assignee) and the member-keyed rest.
 */
export const EXPORT_SECTION_TABLES: Readonly<Record<string, readonly string[]>> = {
  family: [],
  members: ['family_members'],
  calendar: ['calendar_events'],
  todos: [],
  memories: ['family_facts', 'family_playbook_suggestions'],
  documents: ['documents'],
  trips: [],
  groceries: [],
  school: ['school_events', 'school_classes'],
  sports: ['teams', 'sports_events'],
  routines: [],
  finances: ['transactions'],
};

/**
 * The modules the export does not read, each with the member-keyed tables it
 * holds. The KEYS are what the file carries as `notIncluded`; the tables are
 * what the test checks against the migrations.
 */
export const EXPORT_NOT_INCLUDED_TABLES: Readonly<Record<string, readonly string[]>> = {
  health: [
    'appointments', 'health_goals', 'health_metrics', 'health_providers', 'health_visits', 'immunizations',
    'medical_profiles', 'medication_doses', 'medications', 'nutrition_logs', 'symptom_logs', 'workout_logs',
  ],
  journal: ['journal_entries'],
  locations: ['location_events', 'member_locations', 'safety_check_ins'],
  credentials: ['family_credentials'],
  wallet: ['child_wallets', 'currency_transactions', 'stripe_cardholders', 'wallet_cards', 'wallet_passes', 'wallet_rewards'],
  rewards: ['economy_redemptions', 'reward_redemptions', 'member_badges', 'kid_progress', 'independence_milestones'],
  chores: ['chore_assignments', 'chore_disputes', 'chore_submissions'],
  careLog: ['care_log'],
  behavior: ['behavior_logs'],
  sleep: ['bedtime_routines', 'sleep_checkins', 'sleep_logs'],
  screenTime: ['screen_time_entries', 'screen_time_limits'],
  kidLogins: ['child_logins'],
  trustGrants: ['permission_grants', 'social_access_permissions'],
  habits: ['habit_logs', 'habits'],
  reminders: ['family_reminders', 'reminders'],
  announcements: ['announcement_reads'],
  polls: ['family_poll_votes', 'meal_vote_ballots', 'watchlist_votes'],
  rsvps: ['event_rsvps'],
  schoolwork: ['grades', 'homework_assignments'],
  tripDetails: ['vacation_documents', 'vacation_medical_information', 'vacation_members', 'vacation_packing_lists'],
  taxDocuments: ['tax_documents'],
  insurance: ['family_insurance_policies', 'insurance_policies'],
  expenseSplits: ['expense_split_shares'],
  auto: ['driver_licenses', 'driving_trips'],
  relationship: ['family_dates', 'relationship_dates'],
  lifeEvents: ['family_memories', 'family_milestones', 'journey_events', 'trip_memories', 'family_tree_nodes'],
  emergencyContacts: ['family_emergency_contacts'],
  favorites: ['family_favorites'],
  wishlists: ['wishlist_items'],
  wardrobe: ['outfit_logs', 'outfits', 'wardrobe_items'],
  declutter: ['declutter_sessions'],
  dailyRoutines: ['family_routines'],
  career: ['career_profiles'],
  language: ['language_goals', 'language_sessions'],
  opportunities: ['opportunities'],
  playDates: ['play_dates'],
  renewals: ['renewals'],
  guardian: ['guardian_communications', 'guardian_contacts', 'guardian_member_profiles', 'guardian_routing_rules'],
  marketplace: ['marketplace_follows', 'marketplace_listings', 'marketplace_offers', 'marketplace_saved_searches', 'marketplace_saves', 'marketplace_stores'],
  wellbeing: ['family_signals', 'family_stress_signals', 'workload_snapshots'],
  ai: [
    'agent_activity', 'ai_feedback', 'autopilot_suggestions', 'daily_insights', 'family_ai_recommendations',
    'family_digital_twin_profiles', 'family_knowledge_nodes', 'twin_simulations', 'voice_commands',
  ],
};

/** The module names the export file carries as `notIncluded`, in file order. */
export const EXPORT_NOT_INCLUDED: readonly string[] = Object.keys(EXPORT_NOT_INCLUDED_TABLES);
