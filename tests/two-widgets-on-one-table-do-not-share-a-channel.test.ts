// /dashboard/calendar rendered its error screen: the calendar and its busyness
// heatmap both call useRealtimeQuery on calendar_events, and both asked
// realtime-js for the channel `calendar_events:<family>`. realtime-js hands back
// the channel already open under a topic, so the second widget's `.on()` ran
// after the first widget's `.subscribe()` and threw. Found by the 2026-09-27
// page audit (finalaudit.md, "Page audit — every page").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RealtimeClient } from '@supabase/realtime-js';

const change = { event: '*', schema: 'public', table: 'calendar_events', filter: 'family_id=eq.fam-1' } as const;

describe('two widgets reading one table', () => {
  it('realtime-js reuses a topic, so a second listener on it throws (the mechanism)', () => {
    const client = new RealtimeClient('ws://127.0.0.1:1/realtime/v1', { params: { apikey: 'x' } });
    const first = client.channel('calendar_events:fam-1').on('postgres_changes', change, () => {}).subscribe();
    const second = client.channel('calendar_events:fam-1');
    expect(second).toBe(first);
    expect(() => second.on('postgres_changes', change, () => {})).toThrow(/after .?subscribe/);
    void client.removeAllChannels();
  });

  it('distinct topics get distinct channels, each taking its own listener (the fix)', () => {
    const client = new RealtimeClient('ws://127.0.0.1:1/realtime/v1', { params: { apikey: 'x' } });
    const a = client.channel('calendar_events:fam-1:r1').on('postgres_changes', change, () => {}).subscribe();
    const b = client.channel('calendar_events:fam-1:r2');
    expect(b).not.toBe(a);
    expect(() => b.on('postgres_changes', change, () => {}).subscribe()).not.toThrow();
    void client.removeAllChannels();
  });

  it('useRealtimeQuery opens its channel through ownChannel, one topic per subscription', () => {
    const src = readFileSync('lib/hooks/use-realtime-query.ts', 'utf8');
    expect(src).toMatch(/ownChannel\(supabase, spec\.name\)/);
    expect(src).not.toMatch(/\.channel\(spec\.name\)/);
    const own = readFileSync('lib/realtime/own-channel.ts', 'utf8');
    expect(own).toMatch(/client\.channel\(`\$\{name\}:sub\$\{sequence\}`\)/);
  });
});
