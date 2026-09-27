import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSchema } from '../scripts/audit-supabase-queries.mjs';

const ROOT = join(__dirname, '..');

/**
 * A COLUMN TYPESCRIPT BELIEVES IN AND POSTGRES HAS NEVER HEARD OF.
 *
 * `lib/database.types.ts` is hand-maintained, and it is the only thing standing
 * between a query and a runtime error: `supabase.from('x').insert({ y })` is
 * checked against these types and against nothing else. A column declared here
 * that no migration creates is therefore worse than an undeclared one — the
 * compiler actively approves the write, and PostgREST answers PGRST204 in
 * production.
 *
 * There is exactly one today, and `lib/services/finances/index.ts` already
 * documents it in the source that would otherwise write it:
 *
 *   `idempotency_key` is likewise not written. `lib/database.types.ts` types
 *   the column on this table and NO migration adds it — `0256` gave it only to
 *   its six keyed tables — so writing it would be a PGRST204 against real
 *   schema.
 *
 * That comment is correct and it is not enforcement. It lives in one file, and
 * nothing stops a second writer — a new server action, an AI tool, an import
 * path — from setting the field that the types say is there. This makes the
 * divergence a fact the suite checks rather than a fact one author remembered.
 *
 * The comparison reuses `readSchema` from `scripts/audit-supabase-queries.mjs`,
 * which builds the table -> column map by parsing the migrations, so the two
 * sides cannot drift apart through two different readings of the same files.
 */

const schema = readSchema();
const migrationColumns: Map<string, Set<string>> = (schema as { columns?: Map<string, Set<string>> }).columns
  ?? (schema as unknown as Map<string, Set<string>>);

/**
 * Declared in `database.types.ts`, created by no migration, and deliberately
 * never written. Shrinking this list is the point: adding the migration, or
 * removing the field from the types, must remove the entry.
 */
const DECLARED_BUT_ABSENT = new Map([
  ['transactions.idempotency_key', 'documented in lib/services/finances/index.ts; 0256 gave the column only to its six keyed tables, so writing it would be PGRST204'],
]);

/** table -> the column names its `Row` type declares. `& Stamps` adds the two timestamps. */
function typedColumns(): { tables: number; skipped: number; byTable: Map<string, string[]> } {
  const src = readFileSync(join(ROOT, 'lib/database.types.ts'), 'utf8');
  const byTable = new Map<string, string[]>();
  let tables = 0;
  let skipped = 0;
  const re = /^ {6}(\w+): T<\s*\n\s*\{([^\n]*?)\}\s*(& Stamps)?,/gm;
  for (const m of src.matchAll(re)) {
    const [, table, body, stamps] = m;
    tables += 1;
    const known = migrationColumns.get(table);
    if (!known || known.size === 0) { skipped += 1; continue; }
    const names = [...body.matchAll(/(\w+)\??:/g)].map((x) => x[1]);
    if (stamps) names.push('created_at', 'updated_at');
    byTable.set(table, names);
  }
  return { tables, skipped, byTable };
}

describe('a typed column must exist', () => {
  const { tables, skipped, byTable } = typedColumns();

  it('reads both sides — neither parser is allowed to return nothing', () => {
    // The failure this exists to prevent: a regex that stops matching turns the
    // whole file into a green no-op. Both numbers are floors, not targets.
    expect(tables, 'database.types.ts yielded almost no tables — the Row-type regex broke').toBeGreaterThanOrEqual(400);
    expect(migrationColumns.size, 'readSchema returned almost no tables').toBeGreaterThanOrEqual(400);
    expect(skipped, 'too many typed tables are absent from the migration parse to trust the comparison').toBeLessThan(tables / 4);
    const compared = [...byTable.values()].reduce((n, c) => n + c.length, 0);
    expect(compared, 'almost no columns were compared').toBeGreaterThanOrEqual(6_000);
  });

  it('every column the types declare is created by a migration', () => {
    const absent: string[] = [];
    for (const [table, names] of byTable) {
      const known = migrationColumns.get(table) as Set<string>;
      for (const c of names) {
        const key = `${table}.${c}`;
        if (!known.has(c) && !DECLARED_BUT_ABSENT.has(key)) absent.push(key);
      }
    }
    expect(
      absent,
      'these columns are typed but no migration creates them. TypeScript will approve a write '
      + 'to each, and PostgREST will answer PGRST204 in production:\n'
      + absent.map((a) => `  ${a}`).join('\n'),
    ).toEqual([]);
  });

  it('keeps the exception list honest — every entry is still genuinely absent', () => {
    // The ratchet. When the migration lands, or the field leaves the types, the
    // entry has to go; a licence nobody needs is how a list starts lying.
    const stale: string[] = [];
    for (const key of DECLARED_BUT_ABSENT.keys()) {
      const [table, column] = key.split('.');
      const known = migrationColumns.get(table);
      const typed = byTable.get(table) ?? [];
      if (!typed.includes(column)) stale.push(`${key} is no longer in database.types.ts — remove the entry`);
      else if (known?.has(column)) stale.push(`${key} now exists in the migrations — remove the entry`);
    }
    expect(stale).toEqual([]);
  });

  it('the one exception is the one the source already documents', () => {
    // Pinned so the comment and the list cannot drift apart: if that reasoning
    // is ever deleted, this names the file it left.
    expect([...DECLARED_BUT_ABSENT.keys()]).toEqual(['transactions.idempotency_key']);
    const finances = readFileSync(join(ROOT, 'lib/services/finances/index.ts'), 'utf8');
    expect(finances).toContain('`idempotency_key` is likewise not written');
    expect(finances).toContain('NO migration adds it');
  });
});
