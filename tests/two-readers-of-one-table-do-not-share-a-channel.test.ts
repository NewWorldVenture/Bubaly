import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ownChannel } from '@/lib/realtime/own-channel';

/**
 * Audit C1-S9-94 — found by the page audit crawl, signed in, on /dashboard/calendar:
 *
 *   Error: cannot add `postgres_changes` callbacks for
 *   realtime:calendar_events:<family> after `subscribe()`.
 *
 * The browser Supabase client is a singleton, and realtime-js `channel(topic)`
 * returns the EXISTING channel when the topic is already open
 * (node_modules/@supabase/realtime-js RealtimeClient.channel). The calendar
 * page mounts two `useRealtimeQuery('calendar_events')` readers; both asked for
 * `calendar_events:<family>`, the second got the first's already-subscribed
 * channel, and its `.on()` threw — taking that section down to its error
 * boundary. Whichever reader unmounted first also removed the channel from
 * under the other, which then stopped updating without a sign.
 *
 * The fake below does what realtime-js does — dedupe by topic, refuse `.on`
 * after `.subscribe` — so the first case is red on the shared-name code and
 * green on ownChannel.
 */
function realtimeLikeClient() {
  const open = new Map<string, { subscribed: boolean; on: () => unknown; subscribe: () => unknown }>();
  const client = {
    channel(topic: string) {
      const existing = open.get(topic);
      if (existing) return existing;
      const ch = {
        subscribed: false,
        on() {
          if (ch.subscribed) throw new Error(`cannot add \`postgres_changes\` callbacks for realtime:${topic} after \`subscribe()\`.`);
          return ch;
        },
        subscribe() { ch.subscribed = true; return ch; },
      };
      open.set(topic, ch);
      return ch;
    },
  };
  return { client: client as unknown as SupabaseClient, open };
}

describe('two readers of one table do not share a channel (C1-S9-94)', () => {
  it('a second subscription on the same table and family opens cleanly', () => {
    const { client, open } = realtimeLikeClient();
    const first = ownChannel(client, 'calendar_events:fam-1') as unknown as { on: () => { subscribe: () => unknown } };
    first.on().subscribe();
    const second = ownChannel(client, 'calendar_events:fam-1') as unknown as { on: () => { subscribe: () => unknown } };
    expect(() => second.on().subscribe()).not.toThrow();
    expect(open.size).toBe(2);
  });

  it('and the fake is faithful: the shared name reproduces the crash', () => {
    // Negative control. Without this the case above would also pass against a
    // fake that never deduplicated — and prove nothing about ownChannel.
    const { client } = realtimeLikeClient();
    const first = client.channel('calendar_events:fam-1') as unknown as { on: () => { subscribe: () => unknown } };
    first.on().subscribe();
    const second = client.channel('calendar_events:fam-1') as unknown as { on: () => unknown };
    expect(() => second.on()).toThrow(/after `subscribe\(\)`/);
  });

  it('every postgres_changes subscription in the app goes through ownChannel', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx'", { encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((f) => f !== 'lib/realtime/own-channel.ts');
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\.channel\(([^)]*)\)([\s\S]{0,120})/g)) {
        if (/postgres_changes/.test(m[2])) offenders.push(`${f}: .channel(${m[1]})`);
      }
    }
    expect(offenders, 'use ownChannel(client, name) for postgres_changes; see lib/realtime/own-channel.ts').toEqual([]);
    // Non-vacuity: the scan does see real subscriptions.
    const users = files.filter((f) => readFileSync(f, 'utf8').includes('ownChannel('));
    expect(users.length).toBeGreaterThanOrEqual(9);
  });

  it('leaves presence on its shared topic — presence meets ON the topic', () => {
    const src = readFileSync('components/modules/messages-module.tsx', 'utf8');
    expect(src).toContain('supabase.channel(`presence:family:${familyId}`');
    expect(src).not.toContain('ownChannel(supabase, `presence');
  });
});
