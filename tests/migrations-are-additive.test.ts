import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Prod-safety ratchet (mandate: migrations must be additive + idempotent; agents
// cannot apply to prod, and the pending set gets applied by a human later). A
// migration that DROP TABLE / DROP COLUMN / TRUNCATE would DESTROY production
// data when that human runs `supabase db push`. The whole migration history is
// verified additive at authoring time (0 destructive statements); this guard
// fails CI if a destructive one is ever introduced. Dropping POLICY / TRIGGER /
// FUNCTION / INDEX (recreated right after) is fine and NOT flagged.
const DIR = 'supabase/migrations';

// Strip -- line comments and /* */ block comments so prose never trips the scan.
function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const DESTRUCTIVE: [string, RegExp][] = [
  ['DROP TABLE', /\bdrop\s+table\b/i],
  ['DROP COLUMN', /\bdrop\s+column\b/i],
  ['TRUNCATE', /\btruncate\b/i],
  // ALTER TYPE ... DROP VALUE isn't valid PG, but DROP TYPE of an in-use enum is destructive.
  ['DROP TYPE', /\bdrop\s+type\b(?!\s+if\s+exists\s+\w*_?tmp)/i],
];

describe('migrations are additive (no destructive DDL)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it('scans the full migration history', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('contains no DROP TABLE / DROP COLUMN / TRUNCATE / DROP TYPE', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const sql = stripSql(readFileSync(`${DIR}/${f}`, 'utf8'));
      for (const [label, re] of DESTRUCTIVE) {
        if (re.test(sql)) offenders.push(`${f} :: ${label}`);
      }
    }
    expect(offenders, `destructive DDL found (would delete prod data on apply):\n${offenders.join('\n')}`).toEqual([]);
  });
});
