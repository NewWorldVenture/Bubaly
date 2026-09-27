import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

let sequence = 0;

/**
 * A `postgres_changes` channel that belongs to this subscription alone.
 *
 * The browser client is a singleton (lib/supabase/client.ts), and realtime-js
 * `channel(topic)` RETURNS THE EXISTING CHANNEL when one with that topic is
 * already open. So two components subscribing to the same table for the same
 * family — the calendar page mounts two `useRealtimeQuery('calendar_events')`
 * readers — got one shared channel: the second's `.on()` landed after the
 * first's `.subscribe()` and threw ("cannot add `postgres_changes` callbacks
 * … after `subscribe()`"), taking that section of the page down to its error
 * boundary. And whichever unmounted first removed the channel under the other,
 * which then silently stopped updating.
 *
 * For `postgres_changes` the topic is only a label — the server filters on the
 * `{ table, filter }` given to `.on()` — so each subscription can have its own.
 * Do NOT use this for presence or broadcast: those rendezvous ON the topic, and
 * a per-mount name would put every browser in a room of one.
 * Audit C1-S9-94.
 */
export function ownChannel(client: SupabaseClient, name: string): RealtimeChannel {
  sequence += 1;
  return client.channel(`${name}:sub${sequence}`);
}
