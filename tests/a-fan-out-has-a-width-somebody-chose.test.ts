import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '@/lib/utils/map-with-concurrency';
import { resolveDriveTimes } from '@/lib/schedule/intelligence';
import type { DriveTimeRequest } from '@/lib/trips/drive-time';

// `Promise.all(items.map(work))` starts every item at once. For pure work that
// costs nothing; for anything that leaves the process the width of the fan-out
// is whatever the data happens to be. `resolveDriveTimes` did exactly that
// against an external routing provider, so a family with two hundred located
// events opened two hundred simultaneous requests — a rate-limit, a bill, and a
// thundering herd, all decided by a number nobody chose (F-F09).

describe('mapWithConcurrency', () => {
  it('keeps results in input order, whatever order they finish in', async () => {
    // Reversed delays: the last item settles first. A helper that pushed
    // results as they arrived would return them backwards, and every caller
    // that zips by index would be silently wrong.
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, (items.length - n) * 2));
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  it('never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
    // …and it does use the width it was given, rather than quietly serialising.
    expect(peak).toBeGreaterThan(1);
  });

  it('starts the next item as soon as a lane frees, not after a batch', async () => {
    // Lanes, not chunks. Chunking waits for the slowest item in each batch, so
    // one slow call idles the rest; with 2 lanes and one 40ms item among nine
    // 1ms ones, a chunked implementation takes far longer than a laned one.
    const order: number[] = [];
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (n) => {
      await new Promise((r) => setTimeout(r, n === 0 ? 40 : 1));
      order.push(n);
      return n;
    });
    // The slow first item finishes late while the other lane has moved on.
    expect(order[0]).not.toBe(0);
    expect(order).toHaveLength(10);
  });

  it('handles the edges', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
    // A nonsense limit still runs, one at a time, rather than hanging forever.
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapWithConcurrency([1, 2, 3], -5, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('rejects like Promise.all rather than swallowing', async () => {
    // Swallowing would put `undefined` into a results array the caller reads
    // positionally. Tolerance belongs inside `work`, where the caller knows
    // what a miss means — which is what the drive-time fetcher does.
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope');
      return n;
    })).rejects.toThrow('nope');
  });
});

describe('the drive-time fan-out has a width somebody chose', () => {
  const event = (id: string) => ({
    id, title: `Event ${id}`, category: 'sports', location: '1 Main St',
    starts_at: '2026-07-15T17:00:00Z', ends_at: null, all_day: false, assignee_id: null,
  });

  it('asks the provider for every located event, bounded', async () => {
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    const events = Array.from({ length: 40 }, (_, i) => event(`e${i}`));
    const out = await resolveDriveTimes(events, async (req: DriveTimeRequest) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--; seen.push(req.eventId);
      return { driveSeconds: 600, source: 'test' as const };
    });
    // Every event answered, and nothing left out.
    expect(Object.keys(out)).toHaveLength(40);
    expect(seen).toHaveLength(40);
    // And the provider was never hit by all forty at once.
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('still lets a fetcher that cannot answer fall through', async () => {
    const events = [event('a'), event('b')];
    const out = await resolveDriveTimes(events, async (req) => (req.eventId === 'a' ? null : { driveSeconds: 300, source: 'test' as const }));
    expect(Object.keys(out)).toEqual(['b']);
  });

  it('does not call the provider for an event with nowhere to drive to', async () => {
    const calls: string[] = [];
    const out = await resolveDriveTimes(
      [{ ...event('a'), location: null }, { ...event('b'), all_day: true }, { ...event('c'), location: '   ' }],
      async (req) => { calls.push(req.eventId); return { driveSeconds: 1, source: 'test' as const }; },
    );
    expect(calls).toEqual([]);
    expect(out).toEqual({});
  });
});

describe('the unbounded shape does not come back', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
    }
    return out;
  }

  it('resolveDriveTimes fans out through the bounded helper', () => {
    const src = readFileSync('lib/schedule/intelligence.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    const start = src.indexOf('export async function resolveDriveTimes');
    const body = src.slice(start, src.indexOf('export async function', start + 10));
    expect(body).toMatch(/mapWithConcurrency\(/);
    expect(body).not.toMatch(/Promise\.all\(/);
  });

  it('the helper is where a next caller will find it (non-vacuity)', () => {
    const files = walk('lib');
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('utils', 'map-with-concurrency.ts')))).toBe(true);
  });
});
