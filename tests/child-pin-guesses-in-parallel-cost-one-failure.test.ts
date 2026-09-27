import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, evaluateThrottle, registerFailure, type ThrottleRow } from '@/lib/auth/child-throttle';
import { reserveChildLoginAttempt } from '@/lib/auth/child-throttle-store';

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
 * And it takes the attempt BEFORE the PIN is checked (reserveChildLoginAttempt),
 * gate and count as one step. Counting every guess correctly AFTER the check is
 * not enough on its own: every guess in a burst still passes the gate before
 * any of them has written, so all of them reach the password check and the
 * lock lands after the fact. Measured on the local stack: 25 concurrent wrong
 * PINs all reached the check, and the right PIN placed 21st signed in. With the
 * reservation, a burst admits exactly the budget and the rest meet the lock.
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
          && (!('window_start' in eqs) || cur.window_start === eqs.window_start)
          && (!('locked_until' in eqs) || cur.locked_until === eqs.locked_until);
        if (!matches) return { data: null, error: null };
        updatesApplied++;
        rows.set(key, { ...cur!, ...patch });
        return { data: { username: key }, error: null };
      }
      await tick(null);
      return { data: rows.get(key) ?? null, error: null };
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { eqs[col] = val; return chain; },
      is: (col: string, val: unknown) => { eqs[col] = val; return chain; },
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

/** N guesses in flight at once, each reserving its attempt before the PIN check. */
async function parallelGuesses(n: number, seed?: Row) {
  const db = fakeDb(seed);
  const results = await Promise.all(
    Array.from({ length: n }, () => reserveChildLoginAttempt(db.client, USER, NOW)),
  );
  return { db, results, admitted: results.filter((r) => r.ok).length, row: db.rows.get(USER) ?? null };
}

describe('parallel child PIN guesses', () => {
  it('each cost an attempt when they start from no row at all', async () => {
    const { admitted, row } = await parallelGuesses(DEFAULT_POLICY.maxFails);
    // Five simultaneous guesses are five attempts, which is exactly the budget.
    expect(admitted).toBe(DEFAULT_POLICY.maxFails);
    expect(row?.fails).toBe(DEFAULT_POLICY.maxFails);
  });

  it('trip the lockout instead of sliding under it', async () => {
    const { row } = await parallelGuesses(DEFAULT_POLICY.maxFails);
    expect(evaluateThrottle(row, NOW).locked).toBe(true);
  });

  it('each cost an attempt when they start from an existing count', async () => {
    const seed: Row = { username: USER, fails: 1, window_start: NOW.toISOString(), locked_until: null };
    const { admitted, row } = await parallelGuesses(3, seed);
    expect(admitted).toBe(3);
    expect(row?.fails).toBe(4);
  });

  // The property counting after the check could not give: a burst wider than
  // the budget reaches the PIN check only as many times as the budget allows.
  it('admits no more of a wide burst than the budget', async () => {
    const { results, admitted, row } = await parallelGuesses(25);
    expect(admitted).toBe(DEFAULT_POLICY.maxFails);
    expect(results.filter((r) => !r.ok).length).toBe(25 - DEFAULT_POLICY.maxFails);
    expect(evaluateThrottle(row, NOW).locked).toBe(true);
  });

  it('turns away a guess that arrives once the lock is set', async () => {
    const { db } = await parallelGuesses(DEFAULT_POLICY.maxFails);
    const late = await reserveChildLoginAttempt(db.client, USER, NOW);
    expect(late).toMatchObject({ ok: false, reason: 'locked' });
  });

  // Controls — the sequential path and the policy itself are unchanged.
  it('still counts an ordinary one-at-a-time attempt', async () => {
    const db = fakeDb();
    expect(await reserveChildLoginAttempt(db.client, USER, NOW)).toEqual({ ok: true });
    expect(db.rows.get(USER)?.fails).toBe(1);
    expect(await reserveChildLoginAttempt(db.client, USER, NOW)).toEqual({ ok: true });
    expect(db.rows.get(USER)?.fails).toBe(2);
  });

  it('reports the attempt as unavailable when the counter cannot be read', async () => {
    // An uncounted attempt must refuse the sign-in, which is what makes losing
    // a race safe: the loser either takes the next slot or is turned away.
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }),
        insert: () => Promise.resolve({ error: { code: '08006', message: 'down' } }),
      }),
    } as never;
    expect(await reserveChildLoginAttempt(db, USER, NOW)).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('leaves the pure policy alone — the same inputs give the same next state', () => {
    expect(registerFailure(null, NOW)).toEqual({ fails: 1, window_start: NOW.toISOString(), locked_until: null });
  });
});
