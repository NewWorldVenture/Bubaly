import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, evaluateThrottle, registerFailure, type ThrottleRow } from '@/lib/auth/child-throttle';
import { recordChildLoginFailure } from '@/lib/auth/child-throttle-store';

/**
 * Parallel PIN guesses each cost a failure — not one between them.
 *
 * Child sign-in reads child_login_throttle BEFORE attempting the password and
 * writes the new count AFTER. Every request in flight at the same instant
 * therefore computes its next value from the SAME observed row, and the write
 * was a blind `upsert({ username, fails: observed + 1 })`. Ten simultaneous
 * guesses all read fails=0 and all wrote fails=1: the counter measured ROUNDS
 * of parallel guessing, not guesses.
 *
 * That is the whole bound. `lib/auth/child-throttle.ts` exists because "a
 * 4-digit PIN is only 10,000 combinations and kid usernames are guessable" —
 * the budget is five failures per fifteen minutes. Under parallelism the budget
 * is five ROUNDS, and a round can be as wide as the attacker's connection pool,
 * so the 10,000-combination space falls in a couple of windows.
 *
 * This is the same defect the wildcard-username fix addressed
 * (child-login-username-is-not-a-pattern), by a different mechanism: that one
 * multiplied the number of throttle KEYS, this one multiplies the attempts
 * chargeable to one key. Fixing the lookup did not fix this.
 *
 * The fix predicates the write on the state it was computed from, so exactly
 * one racer wins a given transition and the losers recount on top of the winner.
 *
 * Measured against the original `upsert(..., { onConflict: 'username' })`, which
 * the fake below still models so the counterfactual is the real one:
 *
 *   5 guesses in parallel, no prior row : counter reads 1, lockout NOT tripped
 *   3 guesses in parallel, from fails=1 : counter reads 2, not 4
 *
 * With the fix both reach the true count, and five simultaneous guesses lock the
 * account exactly as five sequential ones do.
 */

type Row = ThrottleRow & { username: string };

/** A child_login_throttle that honours `.eq()` predicates on UPDATE. */
function fakeDb(seed?: Row) {
  const rows = new Map<string, Row>();
  if (seed) rows.set(seed.username, { ...seed });
  let updatesAttempted = 0;
  let updatesApplied = 0;

  const from = () => {
    const eqs: Record<string, unknown> = {};
    let mode: 'select' | 'update' | 'insert' | 'upsert' = 'select';
    let patch: Partial<Row> = {};
    let inserted: Row | null = null;

    // Every operation resolves a microtask later, so callers driven with
    // Promise.all genuinely interleave between read and write.
    const tick = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 0));

    const run = async (): Promise<{ data: unknown; error: { code?: string } | null }> => {
      const key = String(eqs.username ?? '');
      if (mode === 'insert' || mode === 'upsert') {
        await tick(null);
        // `upsert(..., { onConflict: 'username' })` is what the code did BEFORE
        // the fix. It is modelled here so the counterfactual in this file can be
        // measured against the real thing rather than an approximation of it.
        if (rows.has(key) && mode === 'insert') return { data: null, error: { code: '23505' } };
        rows.set(key, { ...(rows.get(key) ?? {}), ...inserted! });
        return { data: null, error: null };
      }
      if (mode === 'update') {
        updatesAttempted++;
        await tick(null);
        const cur = rows.get(key);
        const matches = cur
          && (!('fails' in eqs) || cur.fails === eqs.fails)
          && (!('window_start' in eqs) || cur.window_start === eqs.window_start);
        if (!matches) return { data: [], error: null };
        updatesApplied++;
        rows.set(key, { ...cur!, ...patch });
        return { data: [{ username: key }], error: null };
      }
      await tick(null);
      return { data: rows.get(key) ?? null, error: null };
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { eqs[col] = val; return chain; },
      maybeSingle: () => run(),
      update: (p: Partial<Row>) => { mode = 'update'; patch = p; return chain; },
      insert: (r: Row) => { mode = 'insert'; inserted = r; eqs.username = r.username; return run(); },
      upsert: (r: Row) => { mode = 'upsert'; inserted = r; eqs.username = r.username; return run(); },
      then: (...a: unknown[]) => run().then(...(a as [])),
    };
    return chain;
  };

  return {
    client: { from } as never,
    rows,
    counts: () => ({ updatesAttempted, updatesApplied }),
  };
}

const NOW = new Date('2026-09-19T01:00:00.000Z');
const USER = 'alice';

/** N guesses that all observed `observed` before any of them wrote. */
async function parallelFailures(observed: ThrottleRow | null, n: number, seed?: Row) {
  const db = fakeDb(seed);
  const results = await Promise.all(
    Array.from({ length: n }, () => recordChildLoginFailure(db.client, USER, observed, NOW)),
  );
  return { db, results, row: db.rows.get(USER) ?? null };
}

describe('parallel child PIN guesses', () => {
  it('each cost a failure when they start from no row at all', async () => {
    const { results, row } = await parallelFailures(null, DEFAULT_POLICY.maxFails);
    expect(results.every(Boolean)).toBe(true);
    // Five simultaneous guesses are five failures, which is exactly the budget.
    expect(row?.fails).toBe(DEFAULT_POLICY.maxFails);
  });

  it('trip the lockout instead of sliding under it', async () => {
    const { row } = await parallelFailures(null, DEFAULT_POLICY.maxFails);
    expect(evaluateThrottle(row, NOW).locked).toBe(true);
  });

  it('each cost a failure when they start from an existing count', async () => {
    const seed: Row = { username: USER, fails: 1, window_start: NOW.toISOString(), locked_until: null };
    const { row } = await parallelFailures({ ...seed }, 3, seed);
    expect(row?.fails).toBe(4);
  });

  // A wide burst still counts every guess; the retry budget must cover it.
  it('counts a burst wider than a single contention round', async () => {
    const { results, row } = await parallelFailures(null, 5);
    expect(results.every(Boolean)).toBe(true);
    expect(row?.fails).toBe(5);
  });

  // Controls — the sequential path and the policy itself are unchanged.
  it('still counts an ordinary one-at-a-time failure', async () => {
    const db = fakeDb();
    expect(await recordChildLoginFailure(db.client, USER, null, NOW)).toBe(true);
    const first = db.rows.get(USER)!;
    expect(first.fails).toBe(1);
    expect(await recordChildLoginFailure(db.client, USER, first, NOW)).toBe(true);
    expect(db.rows.get(USER)?.fails).toBe(2);
  });

  // A control on the shipped code, not part of the calibration above: the blind
  // counterfactual never re-reads, so this case says nothing about it either way.
  it('reports failure to the caller when the counter cannot be written', async () => {
    // An uncounted attempt must refuse the sign-in, which is what makes losing
    // a race safe: the loser either recounts or is turned away.
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }),
        insert: () => Promise.resolve({ error: { code: '08006', message: 'down' } }),
      }),
    } as never;
    expect(await recordChildLoginFailure(db, USER, null, NOW)).toBe(false);
  });

  it('leaves the pure policy alone — the same inputs give the same next state', () => {
    expect(registerFailure(null, NOW)).toEqual({ fails: 1, window_start: NOW.toISOString(), locked_until: null });
  });
});
