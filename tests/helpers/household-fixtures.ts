// Column defaults for the household modules' tables (0240–0248 and the meals
// views), shaped like lib/database.types.ts, so a test seeds only the columns
// it is about and the module still renders a complete row.
import type { InMemoryOptions } from './in-memory-supabase';

// A uuid, because a family-media path's first segment must be one (lib/storage/family-media-ref.ts).
export const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
export const MEMBER = 'member-1';

const owned = { family_id: FAMILY, created_by: 'user-1', notes: null };

export const HOUSEHOLD_DEFAULTS: NonNullable<InMemoryOptions['defaults']> = {
  sleep_logs: { ...owned, member_id: MEMBER, quality: 3, awakenings: 0, source: 'manual' },
  bedtime_routines: { ...owned, member_id: MEMBER, name: 'Bedtime', target_bedtime: '21:00', target_wake: '07:00', wind_down_min: 30, steps: [], days_of_week: [0, 1, 2, 3, 4, 5, 6], is_active: true },
  sleep_checkins: { ...owned, member_id: MEMBER, energy: 3, mood: 3, caffeine_after_2pm: false, screens_in_bed: false, exercised: false },
  inventory_items: { ...owned, category: 'other', location_id: null, owner_member_id: null, quantity: 1, value_cents: null, purchased_on: null, brand: null, model: null, serial_number: null, warranty_until: null, photo_path: null, tags: [], status: 'in_place', lent_to: null, lent_on: null },
  home_locations: { ...owned, kind: 'room', parent_id: null },
  inventory_moves: { ...owned, from_location_id: null, to_location_id: null, moved_by: null, moved_at: '2026-09-01T12:00:00+00:00', reason: null },
  moves: { ...owned, from_address: null, to_address: null, status: 'planning', move_kind: 'local', budget_cents: null, spent_cents: 0, mover_name: null, mover_phone: null, mover_quote_cents: null, has_kids: false, has_pets: false, is_renting_out: false },
  move_tasks: { ...owned, category: 'admin', offset_days: -7, due_date: null, assignee_id: null, status: 'todo', date_mode: 'fixed', completed_at: null, template_key: null },
  move_boxes: { ...owned, from_room: null, to_room: null, contents: [], is_fragile: false, is_essential: false, status: 'empty', packed_by: null, photo_path: null },
  wardrobe_items: { ...owned, member_id: MEMBER, category: 'top', color: null, size: null, brand: null, warmth: 3, formality: 2, seasons: [], status: 'active', photo_path: null, purchased_on: null, price_cents: null, wear_count: 0, last_worn_on: null },
  outfits: { ...owned, member_id: MEMBER, occasion: 'everyday', item_ids: [], temp_min_c: null, temp_max_c: null, rating: null, is_favorite: false },
  outfit_logs: { ...owned, member_id: MEMBER, outfit_id: null, item_ids: [], occasion: null, temp_c: null, weather: null },
  declutter_zones: { ...owned, room: null, kind: 'surface', clutter_score: 3, last_reset_at: null, photo_path: null, target_state: null, is_active: true },
  declutter_missions: { ...owned, zone_id: null, minutes: 15, assignee_id: null, status: 'planned', scheduled_for: null, completed_at: null, items_removed: 0, before_photo_path: null, after_photo_path: null, points: 5 },
  declutter_sessions: { ...owned, zone_id: null, member_id: null, minutes: 15, missions_done: 0, items_removed: 0 },
  career_profiles: { ...owned, member_id: MEMBER, title: 'Search', is_active: true, headline: null, summary: null, skills: [], target_roles: [], target_keywords: [], work_mode: 'remote', employment_type: 'full_time', salary_target_cents: null, location: null, status: 'active_search', weekly_goal: 5 },
  job_applications: { ...owned, stage: 'applied', source: null, url: null, location: null, work_mode: null, salary_min_cents: null, salary_max_cents: null, applied_on: null, last_activity_on: null, next_step: null, next_step_on: null, contact_name: null, contact_email: null, resume_id: null, excitement: null },
  resume_versions: { ...owned, target_role: null, body: 'Resume body', keywords: [], ats_score: null, matched_keywords: [], missing_keywords: [], is_primary: false, file_path: null },
  language_goals: { ...owned, member_id: MEMBER, language_code: 'es', language_label: 'Spanish', current_level: 'A1', target_level: 'B1', weekly_minutes: 60, reason: null, started_on: '2026-09-01', is_active: true },
  language_sessions: { ...owned, member_id: MEMBER, kind: 'vocab', minutes: 20, score: null, topic: null, corrections: [] },
  vocab_cards: { ...owned, example: null, part_of_speech: null, tags: [], ease: 2.5, interval_days: 0, repetitions: 0, lapses: 0, last_reviewed_on: null, is_suspended: false },
  home_projects: { ...owned, description: null, room: null, kind: 'repair', status: 'planning', priority: 'medium', is_diy: true, budget_cents: null, labor_cents: 0, target_start: null, target_end: null, completed_at: null, owner_id: null, contractor_id: null, photo_path: null },
  project_materials: { ...owned, quantity: 1, unit: null, est_cost_cents: null, actual_cost_cents: null, is_purchased: false, store: null, url: null },
  project_quotes: { ...owned, contractor_id: null, includes_materials: false, lead_time_days: null, valid_until: null, status: 'received', received_on: null },
  watchlist_titles: { ...owned, kind: 'movie', year: null, genres: [], age_rating: null, min_age: 0, runtime_min: null, service: 'netflix', status: 'want', priority: 3, added_by: null, external_url: null, poster_path: null },
  watchlist_votes: { ...owned },
  watch_sessions: { ...owned, title_id: null, member_ids: [], rating: null, minutes: null },
  nutrition_logs: { ...owned, member_id: MEMBER, meal: 'breakfast', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 0 },
  family_favorites: { ...owned, member_id: MEMBER, kind: 'recipe', rating: null, ref_url: null },
  family_recipes: {
    ...owned, description: null, category: 'dinner', cuisine: null, servings: 4, prep_time_mins: null, cook_time_mins: null, difficulty: 'easy',
    ingredients: [], instructions: [], photo_url: null, tags: [], allergy_flags: [], is_favorite: false, is_public: false, rating: null,
    times_made: 0, last_made_at: null, source_url: null, ai_generated: false, estimated_cost_cents: null, source_provider: null,
    source_recipe_id: null, attribution: null, license_notes: null, imported_at: null, raw_payload: null,
  },
};
