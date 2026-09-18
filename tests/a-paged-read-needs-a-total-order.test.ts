import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `lib/supabase/read-all.ts` states the rule it needs and states it precisely:
 * give a paged query "an `.order()` that is unique — a primary key, not the
 * `family_id` being filtered on — or pages can repeat and skip rows."
 *
 * It is not a theoretical requirement. `.range(from, to)` is a separate request
 * with a separately planned sort, so a key that is not a TOTAL order lets the
 * boundary between two pages move inside a run of equal values: the row that sat
 * at offset 1,000 in the first query can sit at 999 in the second and never be
 * returned at all. `lib/blog/posts.ts` measured the exposure on its own table —
 * "717 of the published rows share a `published_at` with another row" — and
 * three more call sites carry the same tiebreak with the same reasoning written
 * out.
 *
 * Forty-nine paged reads in this repository. Thirty-nine order by `id`. Of the
 * ten that do not:
 *
 *   - four add an explicit tiebreak (blog posts, journey events, benchmark
 *     aggregates, sync calendar events), each with the reason in the source;
 *   - five order by a column that IS unique in the schema — checked against the
 *     migrations, not assumed, and listed below with the constraint that makes
 *     it true;
 *   - one did neither. `push_devices` is "one row per physical device" (0035),
 *     so `user_id` repeats for anyone with a phone and a laptop, and the
 *     campaign audience read ordered by it alone.
 *
 * Five of six would have been false accusations, which is why the registry below
 * names the constraint rather than trusting the column's name.
 */

const ROOT = join(__dirname, '..');

/**
 * Unique keys, read out of the migration that declares each one. An entry is a
 * claim about the schema, so it carries its evidence.
 *
 * A read is totally ordered when its `.order()` columns TOGETHER WITH the
 * columns an `.eq()` pins to a constant contain one of these keys. The second
 * half is not a loophole, it is the reason the benchmarks read was one column
 * short and looked fine: it filters `.eq('scope', 'benchmarks')`, so `scope` is
 * the same for every row it can return and cannot break a tie — but the other
 * three members of `unique (scope, cohort_key, metric, value)` then all have to
 * be in the order, and `value` was not.
 */
const UNIQUE_KEYS: Record<string, { columns: string[]; why: string }[]> = {
  blog_posts: [{ columns: ['slug'], why: '00100: `slug text NOT NULL UNIQUE`' }],
  checkout_sessions: [{ columns: ['session_id'], why: '0051: `session_id text NOT NULL UNIQUE`' }],
  family_model_dirty: [{ columns: ['family_id'], why: '0134: `family_id uuid primary key`' }],
  marketing_suppressions: [{ columns: ['email'], why: '0021: `email text PRIMARY KEY`' }],
  network_aggregates: [{ columns: ['scope', 'cohort_key', 'metric', 'value'], why: '0135: `unique (scope, cohort_key, metric, value)`' }],
  network_consent: [{ columns: ['family_id'], why: '0132: `family_id uuid primary key`' }],
  network_contributions: [{ columns: ['family_id'], why: '0135: `family_id uuid primary key`' }],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

type PagedRead = { file: string; line: number; table: string; orders: string[]; pinned: string[] };

/**
 * Every `readAll` / `readAllInChunks` call whose page factory calls `.range()`.
 *
 * A PostgREST chain is one STATEMENT, not one line, so the window runs past the
 * call and the orders are taken in the sequence they are chained — the LAST one
 * is what breaks the ties the earlier ones leave.
 */
function pagedReads(): PagedRead[] {
  const out: PagedRead[] = [];
  for (const dir of ['app', 'lib']) {
    for (const abs of walk(join(ROOT, dir))) {
      const src = readFileSync(abs, 'utf8');
      const file = relative(ROOT, abs).split(sep).join('/');
      // The helpers' own definitions take a page factory; they are not call sites.
      if (file.startsWith('lib/supabase/')) continue;
      for (const m of src.matchAll(/\b(?:readAll|readAllInChunks)\s*[<(]/g)) {
        const segment = src.slice(m.index ?? 0, (m.index ?? 0) + 900);
        if (!segment.includes('.range(')) continue;
        const scope = segment.slice(0, segment.indexOf('.range('));
        const table = /\.from\(\s*'([^']+)'/.exec(scope)?.[1] ?? '?';
        const orders = [...scope.matchAll(/\.order\(\s*'([^']+)'/g)].map((o) => o[1]);
        // `.eq(col, …)` pins a column to one value for every row the read can
        // return, so it cannot break a tie — but it does satisfy that member of
        // a composite key. `.in()`, `.gte()` and friends deliberately do not.
        const pinned = [...scope.matchAll(/\.eq\(\s*'([^']+)'/g)].map((e) => e[1]);
        out.push({ file, line: src.slice(0, m.index).split('\n').length, table, orders, pinned });
      }
    }
  }
  return out;
}

describe('a paged read needs a total order', () => {
  it('finds the call sites at all (guards the guard)', () => {
    // A matcher that silently found nothing would make every rule below vacuous.
    const reads = pagedReads();
    expect(reads.length).toBeGreaterThan(30);
    expect(reads.every((r) => r.table !== '?'), 'a paged read whose table could not be read').toBe(true);
  });

  it('orders every paged read by something', () => {
    const unordered = pagedReads().filter((r) => r.orders.length === 0);
    expect(
      unordered.map((r) => `${r.file}:${r.line} — ${r.table}`),
      'an UNORDERED paged read is the worst case of all: the server may return '
      + 'the pages in any order it likes, so rows repeat and vanish at every '
      + 'boundary rather than only at ties.',
    ).toEqual([]);
  });

  it('is ordered by a key that is actually unique', () => {
    const offenders: string[] = [];
    for (const read of pagedReads()) {
      if (read.orders.includes('id')) continue;
      const determined = new Set([...read.orders, ...read.pinned]);
      const keys = UNIQUE_KEYS[read.table] ?? [];
      if (keys.some((key) => key.columns.every((c) => determined.has(c)))) continue;
      offenders.push(
        `${read.file}:${read.line} — ${read.table} orders by [${read.orders.join(', ')}]`
        + (read.pinned.length ? ` (pinning ${read.pinned.join(', ')})` : ''),
      );
    }
    expect(
      offenders,
      'this ordering is not a total order, so `.range()` — a separately planned '
      + 'sort on every page — can move the boundary inside a run of equal values '
      + 'and drop a row with no error at all. Add .order(\'id\'), or complete the '
      + 'table\'s own unique key and record it in UNIQUE_KEYS with the migration '
      + 'line that declares it:\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('carries no key for a table nothing pages', () => {
    // The registry shrinks honestly. An entry that outlived its call site is a
    // claim about the schema that nobody is checking any more.
    const paged = new Set(pagedReads().map((r) => r.table));
    for (const table of Object.keys(UNIQUE_KEYS)) {
      expect(paged.has(table), `${table} has no paged read left; remove its entry`).toBe(true);
    }
  });

  it('every registry entry cites the migration that proves it', () => {
    // An entry without evidence is an assumption, and an assumption about
    // uniqueness is exactly what this file exists to stop.
    for (const [table, keys] of Object.entries(UNIQUE_KEYS)) {
      for (const { columns, why } of keys) {
        expect(columns.length, `${table} has an empty key`).toBeGreaterThan(0);
        expect(/^\d{4,5}: /.test(why), `${table} does not cite a migration`).toBe(true);
        expect(/primary key|unique/i.test(why), `${table} cites no constraint`).toBe(true);
      }
    }
  });

  it('counts an .eq() as pinning and a .gte()/.in() as not (guards the matcher)', () => {
    // The pin is what lets a composite key be satisfied without ordering by
    // every member, so treating the wrong filter as a pin would excuse a read
    // that really is under-ordered. `.gte('cohort_size', FLOOR)` in the
    // benchmarks read is exactly such a filter: it narrows the rows and leaves
    // cohort_size varying across them.
    const pins = (text: string) => [...text.matchAll(/\.eq\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(pins(".eq('scope', 'benchmarks').gte('cohort_size', K).in('metric', ms)")).toEqual(['scope']);
    expect(pins(".eq('enabled', true).eq('family_id', familyId)")).toEqual(['enabled', 'family_id']);
  });

  it('reads a chained order sequence in order (guards the matcher)', () => {
    // The rule turns on the LAST order, so a matcher that returned them in any
    // other sequence would judge the wrong column. Checked against the two
    // shapes the repository actually writes.
    const orders = (text: string) => [...text.matchAll(/\.order\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(orders(".order('published_at', { ascending: false }).order('slug')")).toEqual(['published_at', 'slug']);
    expect(orders(".order('user_id').order('id')")).toEqual(['user_id', 'id']);
  });
});
