// What the database actually streams — the one list, shared by every client
// that is about to open a websocket.
//
// Before this file existed, ~170 tables were subscribed through
// `useRealtimeQuery` and 51 were in the `supabase_realtime` publication. The
// other ~120 channels connected, reported SUBSCRIBED, and delivered nothing
// forever: a dead channel and a quiet table are indistinguishable to the
// client, so every one of those pages LOOKED live and was not.
//
// It lives here rather than beside the migrations because the decision is made
// in the browser, at the moment a component decides whether to hold a socket.
// A rule the client cannot see is a rule the client cannot honour.
//
// `tests/realtime-publication-drift.test.ts` parses the migrations and fails if
// either set below stops matching the SQL. Two copies is the minimum: the
// database has to hold the line for callers that never run this code.

/**
 * Tables added to `supabase_realtime` by a migration. A table absent from this
 * set can never fire a `postgres_changes` event, so no channel is opened for it.
 */
export const REALTIME_TABLES: ReadonlySet<string> = new Set([
  // 0090–0100, 0112, 0240–0248, 0250 — the pre-existing publication.
  'ai_plan_steps', 'ai_run_events', 'approval_requests', 'bedtime_routines',
  'call_logs', 'career_profiles', 'concierge_plans', 'concierge_sessions',
  'declutter_missions', 'declutter_sessions', 'declutter_zones', 'departure_plans',
  'emergency_sessions', 'family_automation_runs', 'family_communications',
  'family_places', 'front_desk_settings', 'home_locations', 'home_projects',
  'inventory_items', 'inventory_moves', 'job_applications', 'language_goals',
  'language_sessions', 'location_events', 'member_locations', 'move_boxes',
  'move_tasks', 'moves', 'outfit_logs', 'outfits', 'permission_grants',
  'project_materials', 'project_quotes', 'relationship_dates',
  'relationship_gift_ideas', 'relationship_profile', 'reminder_lists',
  'resume_versions', 'sleep_checkins', 'sleep_logs', 'trip_plans',
  'trust_audit_logs', 'trust_delegations', 'trust_policies', 'trust_scores',
  'vocab_cards', 'wardrobe_items', 'watch_sessions', 'watchlist_titles',
  'watchlist_votes',
  // 0269 — the surfaces where two people plausibly act at the same second.
  ...TRANCHE_0269_ENTRIES(),
]);

/** 0269's tranche, named separately so the reason for each is reviewable. */
function TRANCHE_0269_ENTRIES(): string[] {
  return [
    'calendar_events',      // two parents scheduling into the same slot
    'chore_assignments',    // a child completes, a parent approves
    'family_conversations', // the thread list and its last-message ordering
    'family_messages',      // the sender's own message has no other render path
    'grocery_items',        // one parent in the store, one at home
    'grocery_lists',        // the list the shopper opened
    'marketplace_bids',     // a live, timed, real-money auction
    'notifications',        // the header bell on every screen
    'todo_items',           // a shared list where completion must propagate
    'todo_lists',
  ];
}

export const TRANCHE_0269: readonly string[] = TRANCHE_0269_ENTRIES();

/**
 * Published tables carrying `REPLICA IDENTITY FULL`.
 *
 * Postgres puts only the primary key in a DELETE's old tuple under the default
 * replica identity. Realtime evaluates a subscription's filter against those
 * old columns, so `family_id=eq.<uuid>` — the filter every subscription in this
 * app uses — can never match a DELETE unless the whole old row is in the WAL.
 * Without FULL a published table gets live INSERT and UPDATE and silently no
 * DELETE, which is the same dishonesty one level down.
 *
 * Only tables the client can hard-delete from need it; paying the extra WAL on
 * a table nothing deletes buys nothing.
 */
export const DELETE_LIVE_TABLES: ReadonlySet<string> = new Set([
  'calendar_events', 'chore_assignments', 'grocery_items', 'notifications', 'todo_items',
]);

/**
 * Published before 0269, with a delete path, and knowingly still DELETE-blind:
 * a row deleted on another device stays on screen until a refetch. Enumerated
 * rather than silent — the drift test forces the next table added to the
 * publication into one list or the other.
 */
export const DELETE_BLIND_ACCEPTED: ReadonlySet<string> = new Set([
  // Published and subscribed; a delete stays on screen until a refetch.
  'call_logs', 'concierge_plans', 'family_automation_runs',
  // Published by 0091/0093/0098 and subscribed by nothing at all, so their
  // DELETE behaviour reaches no one either way.
  'departure_plans', 'permission_grants', 'trip_plans', 'trust_policies',
  'bedtime_routines', 'career_profiles', 'declutter_missions', 'declutter_sessions',
  'declutter_zones', 'family_places', 'home_locations', 'home_projects',
  'inventory_items', 'inventory_moves', 'job_applications', 'language_goals',
  'language_sessions', 'move_boxes', 'move_tasks', 'moves', 'outfit_logs',
  'outfits', 'project_materials', 'project_quotes', 'relationship_dates',
  'relationship_gift_ideas', 'reminder_lists', 'resume_versions', 'sleep_checkins',
  'sleep_logs', 'vocab_cards', 'wardrobe_items', 'watch_sessions',
  'watchlist_titles', 'watchlist_votes',
]);

/**
 * True when the database publishes `table`. The bespoke subscriptions — the
 * ones filtered by conversation_id or listing_id rather than family_id — ask
 * this directly instead of going through `realtimeChannelFor`.
 */
export function isRealtimePublished(table: string): boolean {
  return REALTIME_TABLES.has(table);
}

export type ChannelSpec = { name: string; filter: string };

/**
 * The channel a family-scoped subscriber should open for `table`, or `null`
 * when the database publishes nothing for it and a socket would be a lie.
 * This is the real decision; `useRealtimeQuery` only obeys it.
 */
export function realtimeChannelFor(table: string, familyId: string): ChannelSpec | null {
  if (!familyId || !REALTIME_TABLES.has(table)) return null;
  return { name: `${table}:${familyId}`, filter: `family_id=eq.${familyId}` };
}

/** True when a DELETE on `table` reaches a `family_id`-filtered subscriber. */
export function deletesAreLive(table: string): boolean {
  return REALTIME_TABLES.has(table) && DELETE_LIVE_TABLES.has(table);
}
