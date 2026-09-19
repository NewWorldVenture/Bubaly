import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No API route writes to the database and drops the answer.
 *
 * `await supabase.from('x').insert({...})` with nothing destructured cannot
 * fail loudly. PostgREST RESOLVES an RLS refusal, a missing column and a
 * constraint violation as `{ error }` — it does not throw — so even the routes
 * that wrap the call in a try/catch never saw those. `app/api/contact` is the
 * clearest case: its ticket insert is explicitly best-effort *because* "the
 * email below is the primary path", and the comment promises the ticket
 * "surfaces in the admin console even if email delivery is unavailable". A
 * resolved error meant that fallback silently did not exist.
 *
 * `cron/family-routines` is the one where silence costs correctness rather
 * than observability: those writes record that a routine was filed, so a lost
 * status update lets the next pass file the same routine again.
 *
 * Best-effort stays best-effort — none of these now block their response. They
 * just leave a trace, which is the difference between degrading and vanishing.
 */

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

/** `await <client>.from('table').insert(` with no destructure in front of it. */
const BARE_WRITE = /(^|\n)\s*await\s+\w[\w.]*\s*\n?\s*\.from\('(\w+)'\)\s*\n?\s*\.(insert|update|upsert|delete)\(/g;

describe('an API write that failed leaves a trace', () => {
  const files = routeFiles('app/api');

  it('finds the routes to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no route issues a write whose answer it never reads', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(BARE_WRITE)) offenders.push(`${file} → ${m[2]}.${m[3]}`);
    }
    expect(offenders, 'a write whose error cannot be seen').toEqual([]);
  });

  it('the contact ticket, whose fallback depends on it, logs its failure', () => {
    const source = readFileSync('app/api/contact/route.ts', 'utf8');
    expect(source).toContain("console.error('[contact] support_tickets write failed'");
  });

  it('the routine bookkeeping, where silence costs correctness, logs its failure', () => {
    const source = readFileSync('app/api/cron/family-routines/route.ts', 'utf8');
    expect(source.match(/routine_runs write failed/g) ?? []).toHaveLength(3);
  });

  it('best-effort writes still do not block the response', () => {
    // The point is a trace, not a new failure mode: none of these turned into
    // an early return.
    const source = readFileSync('app/api/contact/route.ts', 'utf8');
    expect(source).toContain('/* non-fatal: the email below is the primary path */');
  });
});
