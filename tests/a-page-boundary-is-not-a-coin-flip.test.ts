import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// DATA-015. `order by` on a non-unique column has no total order, so which rows
// land on which page is a property of the QUERY PLAN and the physical order of
// the heap, not of the data. Reproduced on the local Postgres with ten rows
// sharing one `created_at` — the value a batch insert produces, because `now()`
// is transaction-start time and every row in one transaction gets the same one:
//
//   page 1 = rows 1-5, page 2 = rows 6-10
//   one UPDATE to an unrelated column on one row — no insert, no delete,
//   `created_at` untouched
//   page 1 and page 2 re-read: row-03 moved from page 1 to page 2 and row-06
//   the other way
//
// A reader who held page 1 and then asked for page 2 sees row-03 twice and
// row-06 never. Re-run with `, id desc` appended: zero rows moved.
//
// For a `readAll` sweep it is worse than a paged screen, because the duplicate
// and the omission both land inside one result the caller treats as complete.
//
// The rule is that every paged read ends on its table's PRIMARY KEY. A unique
// column would make the sort total too, and three sites relied on exactly that
// — but `uq_subscriptions_family`, the index that made one of them total, comes
// from migration 0285, which is PENDING PRODUCTION. A tiebreaker whose
// correctness depends on which migration is live is not one. Every primary key
// here has been in place since 0002.

function primaryKeys(): Map<string, string[]> {
  const pk = new Map<string, string[]>();
  for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join('supabase/migrations', file), 'utf8');
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      const [, table, body] = m;
      const lines = body.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean);
      const composite = lines.find((l) => /^primary\s+key\s*\(/i.test(l));
      const inline = lines.find((l) => /\bprimary\s+key\b/i.test(l) && !/^primary\s+key/i.test(l));
      if (composite) pk.set(table, /\(([^)]*)\)/.exec(composite)![1].split(',').map((s) => s.trim()));
      else if (inline) pk.set(table, [inline.split(/\s+/)[0]]);
    }
    const alter = /alter\s+table\s+(?:only\s+)?(?:public\.)?([a-z0-9_]+)[\s\S]*?add\s+(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/gi;
    while ((m = alter.exec(sql))) pk.set(m[1], m[2].split(',').map((s) => s.trim()));
  }
  return pk;
}

type PagedRead = { file: string; line: number; table: string | null; orders: string[] };

/** Every `.range(` call, with the table and order columns of the chain it belongs to. */
export function pagedReads(file: string, source: string): PagedRead[] {
  const lines = source.split('\n');
  const found: PagedRead[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('.range(')) continue;
    let start = i;
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      if (/\.from\(/.test(lines[j])) { start = j; break; }
    }
    const chain = lines.slice(start, i + 1).join('\n');
    const table = (/\.from\(\s*['"`]([A-Za-z0-9_.]+)['"`]/.exec(chain) ?? [])[1]?.replace(/^public\./, '') ?? null;
    const orders = [...chain.matchAll(/\.order\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]);
    found.push({ file, line: i + 1, table, orders });
  }
  return found;
}

/** Why a paged read's order is not total, or null when it is. */
export function unstableOrder(read: PagedRead, pk: Map<string, string[]>): string | null {
  // A helper that takes the query from its caller cannot know the order; the
  // rule lands on the call site, which this scan reaches separately.
  if (!read.table) return null;
  const key = pk.get(read.table);
  if (!key) return `no primary key found for ${read.table} in the migrations`;
  if (read.orders.length === 0) return `pages ${read.table} with no order at all`;
  const missing = key.filter((c) => !read.orders.includes(c));
  if (missing.length) {
    return `pages ${read.table} ordered by (${read.orders.join(', ')}), which does not end on the primary key (${key.join(',')})`;
  }
  return null;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of ['app', 'lib', 'components']) walk(root);
  return out;
}

const pk = primaryKeys();
const reads = sourceFiles().flatMap((f) => pagedReads(f, readFileSync(f, 'utf8')));

describe('a page boundary is not a coin flip (DATA-015)', () => {
  it('found the paged reads to judge', () => {
    expect(reads.length).toBeGreaterThanOrEqual(100);
    // The generic pagers take their query from the caller; they must stay
    // unresolvable, or the rule has moved to the wrong place.
    const helpers = reads.filter((r) => !r.table).map((r) => r.file);
    expect(helpers).toContain('lib/supabase/read-all.ts');
  });

  it('every paged read ends on its primary key', () => {
    const problems = reads
      .map((r) => ({ r, why: unstableOrder(r, pk) }))
      .filter((x) => x.why)
      .map((x) => `${x.r.file}:${x.r.line} — ${x.why}`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('rejects the three reads this finding was about', () => {
    // The exact chains as they were. An absence-only rule is satisfied by a
    // scan that looks nowhere, so the analyser is shown saying no.
    const before = [
      ["await db.from('guardian_communications').select('id, started_at')",
       "  .eq('family_id', familyId)",
       "  .order('started_at', { ascending: false })",
       '  .range(offset, offset + pageSize - 1);'],
      ["db.from('ai_requests').select(COLUMNS, { count: 'exact' })",
       "  .order('created_at', { ascending: false })",
       '  .range(from, from + AI_ACTIVITY_PAGE_SIZE - 1);'],
      ["readAll((from, to) => sb.from('network_aggregates').select('scope, cohort_key')",
       "  .order('cohort_size', { ascending: false })",
       "  .order('cohort_key')",
       "  .order('metric')",
       '  .range(from, to), { max: 2000 });'],
    ];
    for (const chain of before) {
      const [read] = pagedReads('synthetic.ts', chain.join('\n'));
      expect(unstableOrder(read, pk), chain[0]).toMatch(/does not end on the primary key/);
    }
  });

  it('rejects a paged read with no order at all', () => {
    const [read] = pagedReads('synthetic.ts', "await db.from('ai_requests').select('id').range(0, 49);");
    expect(unstableOrder(read, pk)).toMatch(/no order at all/);
  });

  it('accepts a sort that ends on a composite primary key in either column order', () => {
    // `.order()` terms are given most-significant first; a composite key is
    // total whichever order its columns appear in, so the rule tests membership.
    const key = [...pk].find(([, cols]) => cols.length > 1);
    expect(key, 'the migrations must define at least one composite primary key').toBeDefined();
    const [table, cols] = key!;
    const forward = { file: 'x', line: 1, table, orders: cols };
    const reversed = { file: 'x', line: 1, table, orders: [...cols].reverse() };
    expect(unstableOrder(forward, pk)).toBeNull();
    expect(unstableOrder(reversed, pk)).toBeNull();
  });

  it('is not satisfied by a unique column that a pending migration created', () => {
    // subscriptions.family_id is unique only through 0285, which docs/
    // PENDING_PROD_MIGRATIONS.md records as not applied. A rule that accepted
    // it would pass here and page unstably in production.
    const pending = readFileSync('supabase/migrations/0285_conflict_targets_inferable.sql', 'utf8');
    expect(pending).toContain('uq_subscriptions_family');
    const read = { file: 'x', line: 1, table: 'subscriptions', orders: ['family_id'] };
    expect(unstableOrder(read, pk)).toMatch(/does not end on the primary key/);
  });
});
