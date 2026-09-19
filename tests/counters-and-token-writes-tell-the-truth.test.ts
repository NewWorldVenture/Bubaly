import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Audit C1-S6-02 and C1-S6-03 — two discarded write results with consequences,
 * found by censusing every bare-awaited Supabase write in the tree.
 *
 * Most of the ~30 hits are best-effort telemetry and are correctly discarded.
 * `app/api/cron/family-routines/route.ts` even carries a written justification
 * for three of them, and that reasoning survives scrutiny: nothing outside the
 * file reads `routine_runs.status`. It is quoted in the audit rather than
 * overturned. These two are the ones where something real depends on the write.
 */
describe('the Google Calendar token writes are read (C1-S6-02)', () => {
  const source = strip(readFileSync('app/api/google/calendar/sync/route.ts', 'utf8'));

  it('a refused clear is named, because GET answers "connected" from that value', () => {
    // Discarding it leaves the Sync button in front of a calendar that can
    // never sync, while the same response tells the user to reconnect.
    expect(source).toContain('const { error: clearError }');
    expect(at(source, 'if (clearError)')).toBeLessThan(at(source, 'reconnect: true'));
  });

  it('a failed legacy migration is logged differently from a lost refresh', () => {
    // A lost refresh self-corrects on the next sync. A lost migration does not:
    // the plaintext token stays in a browser-readable column (C3-S5-02) and
    // everything looks fine.
    expect(source).toContain('const { error: persistError }');
    const branch = source.slice(at(source, 'if (persistError)'));
    expect(branch).toContain('decoded.legacy');
    expect(branch).toContain('remains readable');
  });
});

describe('the routines tick counts only work that happened (C1-S6-03)', () => {
  const source = strip(readFileSync('app/api/cron/family-routines/route.ts', 'utf8'));

  it('a refused createRun is a problem, not a filing', () => {
    expect(at(source, 'const run = await createRun(')).toBeLessThan(at(source, 'if (!run.ok)'));
    expect(at(source, 'if (!run.ok)')).toBeLessThan(at(source, 'filed += 1'));
    expect(source).toContain('problems.push(rule.id)');
    // The old shape incremented unconditionally, with the kick merely guarded.
    expect(source).not.toContain('if (run.ok) kickRun(');
  });

  it('it matches the standard this file already sets for `armed`', () => {
    // armPendingRoutines only counts an arm whose update landed. `filed` now
    // holds the same line, and this asserts the model is still there to match.
    const armed = source.slice(source.indexOf('async function armPendingRoutines'));
    expect(armed).toContain('const { error: armError }');
    expect(at(armed, 'if (armError)')).toBeLessThan(at(armed, 'armed += 1'));
  });
});
