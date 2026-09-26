import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S9-84 — a toast that shows PostgREST's own words.
 *
 * `toastError(error.message)` puts the database's text in front of the family:
 * "new row violates row-level security policy for table \"vacation_packing_items\"",
 * in English, whatever the locale, naming a table. `describeDbError` is how the
 * rest of the app says it — permission, duplicate, not found, invalid, network —
 * and it passes an unclassified message through unchanged, so nothing that was
 * said before is lost.
 *
 * Thirty such toasts in thirteen files. Twenty-eight were fixed in C1-S9-84;
 * the last two, in the display grid, in C1-S9-87 — together with its E2E
 * harness (display-ownership.spec.ts), which transpiles the component and
 * resolves imports from a fixed map, so `@/lib/supabase/errors` had to be added
 * to that map in the same commit. The baseline is now empty: this is a ban.
 */
const BASELINE = new Map<string, number>([]);

const RAW = /toastError\(\s*\w+\.message\s*\)/g;

function census(): Map<string, number> {
  const files = execSync("git ls-files 'components/**/*.tsx' 'app/**/*.tsx'", { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const out = new Map<string, number>();
  for (const f of files) {
    const n = (readFileSync(f, 'utf8').match(RAW) ?? []).length;
    if (n) out.set(f, n);
  }
  return out;
}

describe('a raw database message is not a toast (C1-S9-84)', () => {
  const found = census();

  it('no file shows more raw messages than its baseline, and no new file shows any', () => {
    const over = [...found].filter(([f, n]) => n > (BASELINE.get(f) ?? 0)).map(([f, n]) => `${f}: ${n}`);
    expect(over, 'describe it: toastError(describeDbError(error))').toEqual([]);
  });

  it('the baseline shrinks with the code', () => {
    const stale = [...BASELINE].filter(([f, n]) => (found.get(f) ?? 0) < n).map(([f]) => f);
    expect(stale, 'lower or remove these entries').toEqual([]);
  });

  it('the census sees the form it bans', () => {
    expect('if (error) toastError(error.message);'.match(RAW)).toHaveLength(1);
    expect('toastError(describeDbError(error))'.match(RAW)).toBeNull();
  });
});
