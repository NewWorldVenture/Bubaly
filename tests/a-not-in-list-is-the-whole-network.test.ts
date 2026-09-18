import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';
import { writeInChunks } from '@/lib/supabase/chunked-in';

/**
 * The nightly network aggregation ends by pruning the contributions of families
 * who are no longer opted in. It did that with the natural spelling:
 *
 *   .delete().not('family_id', 'in', `(${keepIds.join(',')})`)
 *
 * which carries the wrong list. A PostgREST filter travels in the query string
 * — lib/supabase/chunked-in.ts puts it at roughly 40 bytes per UUID and caps a
 * read at 100 ids to keep the longest URL near 4 KB, "well inside the common
 * 8 KB limit" — and `keepIds` is every family STILL opted in, not the handful
 * being removed.
 *
 * That list has no ceiling, and the reason it has none is a fix:
 * tests/whole-table-reads-are-not-capped.test.ts made the consent read page,
 * because a truncated consent list would DELETE the contribution of a family
 * that never withdrew. The comment above that read says so. Paging it to keep
 * the list complete is precisely what removed the request line's bound — the
 * same pairing an .in() filter travels in the URL recorded for the push
 * campaign, where converting a capped read to readAll made the next statement's
 * .in() unbounded.
 *
 * Past the gateway's limit the delete answers `URI too long`, the run returns
 * 'failed to prune contributions', and nothing has been written before it — so
 * the next night selects the identical set and fails identically. The stall
 * begins at roughly two hundred consenting families and never clears. Worse
 * than a stall: what stops working is the erasure. A family that withdrew keeps
 * contributing to the aggregates it withdrew from, for as long as the prune
 * stays broken.
 *
 * Why the existing tests pass over it. The in-memory Supabase models rows,
 * PostgREST's row cap, and the filter vocabulary — it has no URL, so a request
 * line cannot be too long in it. `whole-table-reads-are-not-capped` seeds 1,011
 * consenting families and asserts every one of them survives the prune; in
 * production that assertion builds a 40 KB request line. The fake is right
 * about the row count and silent about the byte count, and the byte count is
 * the failure.
 *
 * So this file gives the fake the one thing it was missing.
 */

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-09-07T11:00:00Z');

/** A UUID-length id, so the byte arithmetic below is the real one. */
const famId = (n: number) => `fam${String(n).padStart(5, '0')}-0000-4000-8000-00000000abcd`;

/** The common gateway request-line limit that chunked-in.ts sizes against. */
const URI_LIMIT = 8192;

/**
 * The in-memory client, plus a request line.
 *
 * Every id that enters a filter is counted the way it would be spent in a query
 * string: PostgREST separates `in` values with a comma, which percent-encodes to
 * `%2C`, so an id costs its own length plus three. Past the limit the builder
 * answers the way a gateway does — a transport-level rejection, before any row
 * is considered.
 */
function uriLimited(db: InMemorySupabase, limit = URI_LIMIT): { db: DB; longest: () => number } {
  let longest = 0;
  const proxied = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        let bytes = 0;
        const spend = (ids: readonly string[]) => {
          bytes += ids.reduce((n, id) => n + String(id).length + 3, 0);
          longest = Math.max(longest, bytes);
        };
        const wrap = (builder: object): object => new Proxy(builder, {
          get(b, key, r) {
            const value = Reflect.get(b, key, r);
            if (key === 'in' && typeof value === 'function') {
              return (column: string, values: unknown[]) => {
                spend(values as string[]);
                return wrap(value.call(b, column, values) as object);
              };
            }
            if (key === 'not' && typeof value === 'function') {
              return (column: string, op: string, filterValue: unknown) => {
                // `not(col, 'in', '(a,b,c)')` — the ids are inside the string.
                if (op === 'in' && typeof filterValue === 'string') {
                  spend(filterValue.replace(/^\(|\)$/g, '').split(',').filter(Boolean));
                }
                return wrap(value.call(b, column, op, filterValue) as object);
              };
            }
            if (key === 'then' && bytes > limit) {
              // A gateway rejects the request line before PostgREST parses it,
              // so this is an error on the response, not a thrown exception:
              // exactly what the call site's `if (error)` branch reads.
              return (resolve: (v: unknown) => unknown) => resolve({
                data: null, count: null, status: 414, statusText: 'URI Too Long',
                error: { message: `414: request line of ${bytes} bytes exceeds ${limit}` },
              });
            }
            if (typeof value === 'function') {
              return (...args: unknown[]) => {
                const out = (value as (...a: unknown[]) => unknown).call(b, ...args);
                return out === b ? r : out;
              };
            }
            return value;
          },
        });
        return wrap((target as InMemorySupabase).from(table) as unknown as object);
      };
    },
  });
  return { db: proxied as unknown as DB, longest: () => longest };
}

/** `total` consenting families, of which the last `withdrawn` have opted out. */
function seedNetwork(db: InMemorySupabase, total: number, withdrawn: number) {
  const all = Array.from({ length: total }, (_, i) => famId(i));
  db.seed('network_consent', all.map((id, i) => ({
    family_id: id, enabled: i < total - withdrawn, scopes: {},
  })));
  db.seed('network_contributions', all.map((id) => ({
    family_id: id, cohort_key: 'k', features: {}, metrics: {}, scopes: {},
  })));
  return { kept: all.slice(0, total - withdrawn), gone: all.slice(total - withdrawn) };
}

describe('the prune must not carry the whole network in its request line', () => {
  it('erases the families who withdrew, past the size where a not-in would not fit', async () => {
    const inner = createInMemorySupabase({ maxRows: 1000 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kept, gone } = seedNetwork(inner, 300, 5);
    const { db, longest } = uriLimited(inner);

    const result = await runNetworkAggregation(db, NOW);

    // Calibration, and the finding: against the `not in (keepIds)` spelling this
    // same call returned { ok: false, error: 'failed to prune contributions' },
    // because 295 kept families cost 295 * 39 = 11,505 bytes of request line.
    expect(kept.length * 39).toBeGreaterThan(URI_LIMIT);
    expect(result.ok, `${result.error} (longest request line: ${longest()} bytes)`).toBe(true);

    const survivors = inner.table('network_contributions').map((r) => r.family_id);
    expect(survivors).toHaveLength(kept.length);
    for (const id of gone) expect(survivors, `${id} withdrew and was not erased`).not.toContain(id);
    expect(longest()).toBeLessThanOrEqual(URI_LIMIT);
  });

  it('the limited client actually rejects an oversized filter (guards the guard)', async () => {
    // Non-vacuity: if the proxy never counted anything, the case above would
    // pass against the defect it exists to catch.
    const inner = createInMemorySupabase({ maxRows: 1000 });
    inner.seed('network_contributions', [{ family_id: famId(0), cohort_key: 'k', features: {}, metrics: {}, scopes: {} }]);
    const { db } = uriLimited(inner);
    const tooMany = Array.from({ length: 300 }, (_, i) => famId(i));

    const { error: overBudget } = await db.from('network_contributions').delete().in('family_id', tooMany);
    expect(overBudget, 'the proxy let a 300-id filter through').not.toBeNull();
    expect(inner.table('network_contributions')).toHaveLength(1);

    const { error: withinBudget } = await db.from('network_contributions').delete().in('family_id', [famId(0)]);
    expect(withinBudget, 'the proxy rejects a filter that would fit').toBeNull();
    expect(inner.table('network_contributions')).toHaveLength(0);
  });

  it('counts the ids inside a not-in string too, not only an .in() array', async () => {
    // The defect's own spelling hides its ids in a single string argument. A
    // proxy that only counted `.in(col, array)` would price the fixed code and
    // let the broken code through free.
    const inner = createInMemorySupabase({ maxRows: 1000 });
    const ids = Array.from({ length: 300 }, (_, i) => famId(i));
    const { db } = uriLimited(inner);

    const { error } = await db.from('network_contributions').delete()
      .not('family_id', 'in', `(${ids.join(',')})`);
    expect(error).not.toBeNull();
  });
});

describe('writeInChunks', () => {
  it('never sends more than a chunk, and covers every id', async () => {
    const seen: number[] = [];
    const ids = Array.from({ length: 250 }, (_, i) => famId(i));
    const { error } = await writeInChunks(ids, (chunk) => {
      seen.push(chunk.length);
      return Promise.resolve({ error: null });
    });
    expect(error).toBeNull();
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(250);
    // Calibration: one unchunked request would have been a single batch of 250.
    expect(seen.length).toBe(3);
  });

  it('sends nothing at all for an empty list', async () => {
    // The old code needed a separate branch here, because `not in ()` is not
    // "delete nothing" — PostgREST reads the empty list as a list containing
    // one empty string, so it would have matched, and deleted, every row.
    let calls = 0;
    const { error } = await writeInChunks([], () => { calls++; return Promise.resolve({ error: null }); });
    expect(calls).toBe(0);
    expect(error).toBeNull();
  });

  it('keeps erasing after a failed chunk, and still reports the failure', async () => {
    // A partial erasure is worth more than none: the chunk that failed is the
    // only one left for the next run, and the caller is told either way.
    const attempted: string[] = [];
    const ids = Array.from({ length: 250 }, (_, i) => famId(i));
    const { error } = await writeInChunks(ids, (chunk) => {
      attempted.push(chunk[0]);
      return Promise.resolve({ error: chunk[0] === ids[0] ? { message: 'deadlock detected' } : null });
    });
    expect(error).toEqual({ message: 'deadlock detected' });
    expect(attempted).toHaveLength(3);
  });
});

/**
 * The ratchet.
 *
 * `.in(column, ids)` is a method, so `an .in() filter travels in the URL` can
 * scan for it. The complement has no method: it is spelled
 * `not(col, 'in', `(${xs.join(',')})`)`, a hand-built string, and that is why
 * this site was not among the three that pass found. Three exist in the
 * repository and only one carried a list that grows with the platform.
 *
 * A list whose length is fixed by the SOURCE — a module constant, a closed
 * union of status names — cannot reach the limit and does not need chunking;
 * demanding it there would be asserting something untrue, and a guard that
 * cries wolf collects exemptions until it means nothing. So each site is
 * classified once, by the thing that bounds its list, and a new one fails until
 * somebody says which it is.
 */
const BOUNDED_NOT_IN: { file: string; list: string; why: string }[] = [
  {
    file: 'lib/ai/runs/store.ts',
    list: 'options.excludeStatuses',
    why: 'legacyStatusesReadingElsewhere() over a closed set of run statuses — single digits',
  },
  {
    file: 'lib/services/notifications/index.ts',
    list: 'DIGEST_NOTIFICATION_TYPES',
    why: 'a module constant of notification type names',
  },
];

function handBuiltNotIn(): { file: string; list: string }[] {
  const hits: { file: string; list: string }[] = [];
  for (const dir of ['app', 'lib']) {
    for (const abs of walkTs(dir)) {
      const source = readFileSync(abs, 'utf8');
      for (const m of source.matchAll(/\.not\(\s*[^,]+,\s*['"]in['"]\s*,\s*`\(\$\{([^}]*?)\.join\(/g)) {
        hits.push({ file: abs.split(sep).join('/'), list: m[1].trim() });
      }
    }
  }
  return hits;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe('every hand-built NOT IN list is bounded by its source', () => {
  it('finds the call sites at all (guards the guard)', () => {
    // A matcher that silently found nothing would make the rule below vacuous.
    expect(handBuiltNotIn().length).toBeGreaterThanOrEqual(BOUNDED_NOT_IN.length);
  });

  it('matches the shape the defect was written in', () => {
    // Recorded rather than trusted: this pattern is the only thing standing
    // between the next such delete and production, so it is checked against the
    // exact line that was there.
    const defect = ".delete().not('family_id', 'in', `(${keepIds.join(',')})`)";
    expect(/\.not\(\s*[^,]+,\s*['"]in['"]\s*,\s*`\(\$\{([^}]*?)\.join\(/.test(defect)).toBe(true);
  });

  it('classifies each one, or fails naming it', () => {
    const unclassified = handBuiltNotIn().filter(
      (h) => !BOUNDED_NOT_IN.some((b) => b.file === h.file && b.list === h.list),
    );
    expect(
      unclassified.map((h) => `${h.file} — not in (${h.list})`),
      'a NOT IN list is built by hand here. NOT IN does not decompose over chunks, '
      + 'so if that list can grow with the platform the statement has a request-line '
      + 'ceiling and no way to page under it: invert the set and delete the remainder '
      + 'with writeInChunks from @/lib/supabase/chunked-in. If the list is fixed by its '
      + 'source, add it to BOUNDED_NOT_IN with the reason:\n'
      + unclassified.map((h) => `  ${h.file} — ${h.list}`).join('\n'),
    ).toEqual([]);
  });

  it('does not carry an entry for a site that is gone', () => {
    // The list shrinks as sites are fixed and never lies — the same rule the
    // aria-modal ratchet earlier in this audit enforced on itself three times.
    const present = handBuiltNotIn();
    for (const b of BOUNDED_NOT_IN) {
      expect(
        present.some((h) => h.file === b.file && h.list === b.list),
        `${b.file} no longer builds a NOT IN from ${b.list}; remove the entry`,
      ).toBe(true);
    }
  });
});
