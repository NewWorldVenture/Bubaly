import type { InMemorySupabase, Row } from './in-memory-supabase';

/** Synthetic atomic claim check and mutation; no await separates the fence from its writes. */
export function applyCalendarFeedSync(args: Record<string, unknown>, db: InMemorySupabase): string {
  const feed = db.table('calendar_feeds').find(row => row.id === args.p_feed_id);
  if (!feed || feed.last_status !== 'syncing' || feed.updated_at !== args.p_fence) return 'lost';
  const events = db.table('calendar_events');
  const upserts = (args.p_upserts as Row[]) ?? [];
  if (upserts.some(row => row.family_id != null && row.family_id !== feed.family_id)) throw new Error('wrong feed family');
  for (const incoming of upserts) {
    const row: Row = { ...incoming, feed_id: feed.id, family_id: feed.family_id };
    const stored = events.find(event => event.feed_id === feed.id && event.external_uid === row.external_uid);
    if (stored) Object.assign(stored, row);
    else events.push(db.withDefaults('calendar_events', row));
  }
  const removals = new Set((args.p_removals as string[]) ?? []);
  for (let n = events.length - 1; n >= 0; n--) {
    if (events[n].feed_id === feed.id && removals.has(events[n].external_uid as string)) events.splice(n, 1);
  }
  return 'applied';
}
