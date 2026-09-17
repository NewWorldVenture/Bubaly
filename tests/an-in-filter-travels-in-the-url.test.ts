import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readInChunks } from '@/lib/supabase/chunked-in';

/**
 * A PostgREST `.in()` filter travels in the query string. lib/supabase/chunked-in.ts
 * puts it at roughly 40 bytes per UUID and caps a batch at 100 to keep the longest
 * URL near 4 KB, "well inside the common 8 KB limit", because past the gateway's
 * request-line limit the read comes back `URI too long`.
 *
 * Three call sites handed it an id array that could pass that threshold:
 *
 *   lib/server/notification-emails.ts   up to 500 (pending is .limit(500))
 *   app/api/cron/return-reminders/route.ts   up to 200 (BATCH = 200)
 *   app/(app)/admin/marketing/push/actions.ts   unbounded
 *
 * The third is the one worth staring at. Its `push_devices` read was deliberately
 * converted to readAll, with a comment saying why: "past 1,000 devices a campaign
 * would reach a prefix of its audience and record `recipients` as if that were
 * everyone." That fix is correct — and removing the 1,000 cap is precisely what
 * makes the `.in()` on the next statement unbounded. Fixing the prefix read is
 * what made the following line reachable at scale.
 *
 * None of the three is a silent-wrong-data bug: all three fail closed. What makes
 * them worse than a one-off failure is that two of them cannot recover. Neither
 * writes anything before the failing read, so nothing is settled — the next run
 * selects the identical set and fails identically. The stall begins exactly when
 * the backlog is large enough to matter and never clears on its own. That is the
 * same shape main just fixed in the allowance cron, where one bad row ended the
 * platform's run every night.
 */

const CHUNK_LIMIT = 100;

describe('readInChunks', () => {
  it('never sends more than a chunk of ids in one request', async () => {
    const seen: number[] = [];
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);

    const { data, error } = await readInChunks<{ id: string }, { message: string }>(
      ids,
      (chunk) => {
        seen.push(chunk.length);
        return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null });
      },
    );

    expect(error).toBeNull();
    expect(data).toHaveLength(500);
    expect(Math.max(...seen)).toBeLessThanOrEqual(CHUNK_LIMIT);
    // Calibration: a single unchunked request would have been one batch of 500,
    // which is the ~20 KB query string this exists to avoid.
    expect(seen.length).toBeGreaterThan(1);
  });

  it('returns every row, not just the first batch', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const { data } = await readInChunks<{ id: string }, { message: string }>(
      ids,
      (chunk) => Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }),
    );
    expect(new Set(data.map((r) => r.id)).size).toBe(250);
  });
});

/**
 * The ratchet. These three sites take an id array whose size is set by something
 * other than themselves — a `.limit(500)`, a `BATCH` constant, a paged read — and
 * so cannot assume it is small.
 *
 * Deliberately NOT every `.in()` in the repo. Most carry a family-sized set: a
 * household's members, one project's materials. Sweeping those in would demand
 * chunking where a single request is correct and cheaper, and a guard that cries
 * wolf gets exemptions bolted onto it until it means nothing.
 */
const UNBOUNDED_ID_READS: { file: string; why: string }[] = [
  { file: 'lib/server/notification-emails.ts', why: 'userIds from a .limit(500) page of pending notifications' },
  { file: 'app/api/cron/return-reminders/route.ts', why: 'listingIds from a BATCH=200 page of orders' },
  { file: 'app/(app)/admin/marketing/push/actions.ts', why: 'uniqueIds from a readAll-paged device list' },
];

describe('an .in() filter travels in the URL', () => {
  it('each named file still exists and still reads by id', () => {
    // Non-vacuity: a moved file would make the assertion below scan nothing.
    for (const { file } of UNBOUNDED_ID_READS) {
      const source = readFileSync(file, 'utf8');
      expect(source.length, `${file} is empty or missing`).toBeGreaterThan(200);
      expect(/\.in\(/.test(source), `${file} no longer filters by id at all`).toBe(true);
    }
  });

  it('chunks the reads whose id array is sized elsewhere', () => {
    const offenders: string[] = [];
    for (const { file, why } of UNBOUNDED_ID_READS) {
      const source = readFileSync(file, 'utf8');
      if (!/readInChunks\s*[<(]/.test(source)) offenders.push(`${file} — ${why}`);
    }
    expect(
      offenders,
      'these pass an id array of unbounded size to a single .in(). Past the '
      + 'gateway request-line limit the read fails "URI too long", and because '
      + 'nothing is settled first the next run fails identically. Use '
      + 'readInChunks from @/lib/supabase/chunked-in:\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('matches readInChunks through a generic argument too', () => {
    // Recorded because the sweep that FOUND these first counted `readAll(` and
    // missed every `readAll<Row>(` call site, reporting three paged crons as
    // unpaged. The same mechanism failure — a name followed by a generic
    // argument — has now bitten this audit twice, so the pattern here is
    // `\s*[<(]` by construction rather than by luck.
    expect(/readInChunks\s*[<(]/.test('await readInChunks<Row, Err>(ids, read)')).toBe(true);
    expect(/readInChunks\s*[<(]/.test('await readInChunks(ids, read)')).toBe(true);
  });
});
