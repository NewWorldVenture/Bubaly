// Two chores approved for one child at the same moment must BOTH land.
//
// `applyCompletionRewards` used to read `kid_progress`, add the XP in
// TypeScript, and write the total back by id. Two approvals arriving together
// both read xp=100 and both wrote 120: one award silently lost, and the child
// told 120 twice. `level`, `current_streak` and `longest_streak` were computed
// from the same stale read and went out in the same statement, so all four were
// lost together. 0341 moved the arithmetic behind a row lock.
//
// ── why this test is built the way it is ───────────────────────────────────
//
// A concurrency test that starts two callers and HOPES they overlap can pass by
// never overlapping. That is a vacuous pass, and it is the failure this suite
// exists to avoid: it would report green for the defect above on any run where
// the first caller happened to finish first.
//
// So the interleaving is forced rather than raced. The first approval is HELD
// OPEN at the database — a slow write is all that models — the second approval
// is then started, and the test ASSERTS mid-flight that both have reached the
// database and neither has written. Only then is the hold released. The
// overlap is a fact this test establishes, not a coincidence it waits for.
//
// The stub is the real `applyCompletionRewards` talking to a database whose
// only two special behaviours are the ones Postgres actually has:
//
//   * an unguarded UPDATE applies last-write-wins (`.from('kid_progress')
//     .update(…)`), and
//   * `select … for update` SERIALISES the callers that ask for it, so the
//     second one reads the row the first one left (the RPC path).
//
// Both are kept, deliberately: the blind path is still wired up so that putting
// the arithmetic back in TypeScript makes this test go red at 120 instead of
// quietly taking a different route through the stub.
//
// The lock itself is SQL, and this test cannot prove SQL. Its other half is
// `docs/audit/two-approvals-for-one-kid-both-land-race.sh`, which races two real
// Postgres connections against a replay of every migration.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { levelForXp, nextStreak } from '@/lib/chores/logic';

const FAM = 'fam-1';
const KID = 'kid-1';
const TODAY = '2026-09-21';
const YESTERDAY = '2026-09-20';
const MEDIUM_XP = 20;
const out = (s: string) => process.stdout.write(s + '\n');
const settle = () => new Promise((r) => setTimeout(r, 5));

type Row = Record<string, any>;
const ok = (data: any) => ({ data, error: null, count: null });

function makeDb() {
  const progress: Row = {
    id: 'p1', family_id: FAM, member_id: KID,
    xp: 100, level: levelForXp(100), current_streak: 1, longest_streak: 1, last_activity: YESTERDAY,
  };
  const log: string[] = [];
  let hold: Promise<void> | null = null;

  // `select … for update`: the callers that ask for this row take their turn.
  // Nothing else in this stub serialises anything.
  let rowLock: Promise<void> = Promise.resolve();
  async function underRowLock<T>(run: () => Promise<T>): Promise<T> {
    const queued = rowLock;
    let release!: () => void;
    rowLock = new Promise<void>((r) => { release = r; });
    await queued;
    try {
      return await run();
    } finally {
      release();
    }
  }

  const thenable = (fn: () => Promise<any> | any) => {
    const self: any = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'order', 'limit']) self[m] = () => self;
    self.single = () => thenable(fn);
    self.maybeSingle = () => thenable(fn);
    self.then = (res: any, rej: any) => Promise.resolve().then(fn).then(res, rej);
    return self;
  };

  async function applyCompletion(args: Row) {
    log.push('call kid_progress_apply_completion');
    return underRowLock(async () => {
      log.push(`locked kid_progress (row xp=${progress.xp})`);
      if (hold) { log.push(`holding the row lock at xp=${progress.xp}`); await hold; }
      const before = { ...progress };
      const xp = before.xp + args.p_gained_xp;
      const level = levelForXp(xp);
      const streak = nextStreak(before.current_streak, before.last_activity, args.p_today);
      const longest = Math.max(before.longest_streak, streak);
      Object.assign(progress, {
        xp, level, current_streak: streak, longest_streak: longest, last_activity: args.p_today,
      });
      log.push(`wrote kid_progress xp=${xp} (row now xp=${progress.xp})`);
      return ok({
        ok: true, xp, level, current_streak: streak, longest_streak: longest, last_activity: args.p_today,
        previous_level: before.level, previous_streak: before.current_streak,
        previous_longest_streak: before.longest_streak, previous_last_activity: before.last_activity,
      });
    });
  }

  async function revertCompletion(args: Row) {
    log.push('call kid_progress_revert_completion');
    return underRowLock(async () => {
      const xp = Math.max(0, progress.xp - args.p_gained_xp);
      const restore = progress.current_streak === args.p_applied_streak
        && progress.longest_streak === args.p_applied_longest_streak
        && progress.last_activity === args.p_applied_last_activity;
      Object.assign(progress, {
        xp,
        level: levelForXp(xp),
        current_streak: restore ? args.p_previous_streak : progress.current_streak,
        longest_streak: restore ? args.p_previous_longest_streak : progress.longest_streak,
        last_activity: restore ? args.p_previous_last_activity : progress.last_activity,
      });
      log.push(`reverted kid_progress xp=${xp} (streak_restored=${restore})`);
      return ok({ ok: true, xp, streak_restored: restore });
    });
  }

  const client: any = {
    rpc(fn: string, args: Row) {
      if (fn === 'kid_progress_apply_completion') return applyCompletion(args);
      if (fn === 'kid_progress_revert_completion') return revertCompletion(args);
      throw new Error(`unstubbed rpc: ${fn}`);
    },
    from(table: string) {
      const api: any = {
        select: (_c?: string, opts?: any) => {
          if (table === 'kid_progress') return thenable(() => { log.push(`read kid_progress xp=${progress.xp}`); return ok({ ...progress }); });
          if (table === 'chore_assignments' && opts?.head) return thenable(() => ({ data: null, error: null, count: 1 }));
          if (table === 'member_badges') return thenable(() => ok([]));
          return thenable(() => ok([]));
        },
        insert: () => thenable(() => ok({ ...progress })),
        upsert: () => thenable(() => ok([])),
        // Unguarded, held-open UPDATE — the blind shape, kept wired up so that
        // moving the arithmetic back into TypeScript is caught here.
        update: (patch: Row) => {
          if (table !== 'kid_progress') return thenable(() => ok({ id: 'x' }));
          return thenable(async () => {
            if (hold) { log.push(`UPDATE kid_progress xp=${patch.xp} -- held`); await hold; }
            Object.assign(progress, patch);          // unguarded: last write wins
            log.push(`wrote kid_progress xp=${patch.xp} (row now xp=${progress.xp})`);
            return ok({ id: 'p1' });
          });
        },
      };
      return api;
    },
  };
  return {
    client: client as SupabaseClient<Database>,
    progress,
    log,
    holdUpdates(p: Promise<void>) { hold = p; },
    releaseUpdates() { hold = null; },
  };
}

const { applyCompletionRewards } = await import('@/lib/chores/server');

// The streak arm is decided, not inherited from the day the suite happens to run
// on: yesterday's activity + today = a streak of 2. The day key that decides it
// is now an explicit (zone, instant) pair on the options below — see ZONE/NOW —
// so this holds under TZ=UTC and TZ=Asia/Tokyo alike. The fake clock stays as a
// floor: any clock read that creeps back into the award path is pinned too.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
});
afterAll(() => { vi.useRealTimers(); });

// Named explicitly rather than left to the host: 02:00 on 21 September in Los
// Angeles is 09:00 the same day at Greenwich, so both answers happen to be
// TODAY here — which is the point. This test is about the LOCK, and pinning the
// zone keeps it about the lock in every zone the suite is run under.
const ZONE = 'America/Los_Angeles';
const NOW = new Date(`${TODAY}T09:00:00Z`);

describe('two chores approved for one kid at the same time', () => {
  it('both land: 100 + 20 + 20 = 140, and the second award reads what the first wrote', async () => {
    const db = makeDb();
    const opts = { familyId: FAM, memberId: KID, difficulty: 'medium' as const, qualityScore: 90, tz: ZONE, now: NOW };

    let release!: () => void;
    db.holdUpdates(new Promise<void>((r) => { release = r; }));

    // Parent clicks Approve on chore #1. It reaches kid_progress and is held
    // there — a slow write is all this models.
    const a = applyCompletionRewards(db.client, opts);
    await settle();

    // Parent clicks Approve on chore #2 in the same second. Nothing in the app
    // stops it, and nothing should: they are two different approvals.
    const b = applyCompletionRewards(db.client, opts);
    await settle();

    // Taken BEFORE the release: this is what makes the overlap a fact. Both
    // approvals have reached the database and neither has written.
    const midflight = [...db.log];

    db.releaseUpdates();
    release();
    const [aResult, bResult] = await Promise.all([a, b]);

    out('--- statements in order ---');
    for (const l of db.log) out('  ' + l);
    out('RESULT ' + JSON.stringify({
      choreA_told_the_kid: aResult.xp,
      choreB_told_the_kid: bResult.xp,
      xp_actually_stored: db.progress.xp,
      level_stored: db.progress.level,
      streak_stored: db.progress.current_streak,
      longest_streak_stored: db.progress.longest_streak,
      two_chores_at_20xp_from_100_should_be: 140,
    }));

    // The invariant. Both awards, or the defect is back.
    expect(db.progress.xp).toBe(140);

    // The three columns computed from the same read. Fixing only the XP would
    // leave these decided from a total the row no longer holds.
    expect(db.progress.level).toBe(levelForXp(140));
    expect(db.progress.current_streak).toBe(2);
    expect(db.progress.longest_streak).toBe(2);
    expect(db.progress.last_activity).toBe(TODAY);

    // Neither child was told a number the row does not hold: one approval
    // reported the running total 120, the other 140.
    expect([aResult.xp, bResult.xp].sort((x, y) => x - y)).toEqual([120, 140]);
    expect([aResult.streak, bResult.streak]).toEqual([2, 2]);

    // The second award decided from the row the first one wrote. This is the
    // mechanism, stated as an observation rather than an assumption.
    expect(db.log.filter((l) => l.startsWith('locked kid_progress'))).toEqual([
      'locked kid_progress (row xp=100)',
      'locked kid_progress (row xp=120)',
    ]);

    // Non-vacuity floor: the two approvals really were in flight together, and
    // the test really did observe that before letting either finish. Without
    // this, a run in which the first approval completed before the second began
    // would pass while proving nothing.
    const reachedTheDatabase = midflight.filter(
      (l) => l.startsWith('call kid_progress_apply_completion') || l.startsWith('read kid_progress'),
    );
    expect(reachedTheDatabase).toHaveLength(2);
    expect(midflight.filter((l) => l.startsWith('wrote'))).toEqual([]);

    // Nothing was rolled back; both totals above are awards, not repairs.
    expect(db.log.filter((l) => l.includes('revert'))).toEqual([]);
  });

  // The award's level is recomputed inside the lock, in SQL, by
  // `kid_progress_level_for_xp` — a second copy of `levelForXp`. Two copies of a
  // curve drift, and the drift is invisible: the database pays one level while
  // the UI celebrates another. This table is the pin. Its other half is the same
  // table in `docs/audit/two-approvals-for-one-kid-both-land-check.sql`, asserted against
  // the SQL function on a real replay, so changing one side without the other
  // fails on one side or the other.
  const LEVEL_CURVE: Array<[number, number]> = [
    [0, 1], [1, 1], [99, 1], [100, 2], [140, 2], [299, 2],
    [300, 3], [599, 3], [600, 4], [999, 4], [1000, 5], [1499, 5], [1500, 6],
  ];

  it('and the level curve the database recomputes from is the app curve', () => {
    for (const [xp, level] of LEVEL_CURVE) {
      expect(levelForXp(xp), `levelForXp(${xp})`).toBe(level);
    }
  });
});
