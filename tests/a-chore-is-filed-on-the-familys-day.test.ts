import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCompletionRewards } from '@/lib/chores/server';

// A chore is filed against the day the CHILD did it, not the day at Greenwich.
//
// `lib/chores/server.ts` built its day key with `new Date().toISOString()` sliced
// to ten characters. That names the day on the Greenwich meridian, and the value
// goes two places that both care which day it is:
//
//   * `kid_progress.last_activity`, a DATE column (00430) — a column that already
//     means the family's calendar day, so a Greenwich key written into it is
//     simply the wrong day for a large, predictable slice of every day;
//   * 0341's streak arm, `p_today - v_row.last_activity = 1`, which is the
//     difference between a streak continuing, resetting, or being credited early.
//
// What a family lost: a chore approved at 17:00 in Los Angeles is 00:00 the next
// day at Greenwich, so it was filed against TOMORROW — `last_activity` disagreed
// with the evening the child actually did the chore, and the next day's approval
// then saw a same-day repeat rather than a continuation. East of Greenwich the
// error runs the other way: 08:00 in Tokyo is the previous afternoon at
// Greenwich, so the chore was filed against YESTERDAY and the day after looked
// like a two-day gap, resetting a streak the child had kept.
//
// ── what this file asserts, and why it is a contract rather than a restatement ──
//
// Every case below names its zone EXPLICITLY and passes the instant as a value.
// "Unbound" is not a zone — it is whatever the host says, and this suite is run
// under at least two different hosts (vitest.config.ts pins TZ from the
// environment precisely so CI can run it twice). A test that reads the host's
// zone proves nothing about a family's.
//
// The five zones are chosen to bracket the whole inhabited range rather than to
// decorate: Etc/GMT+12 (UTC-12) is the furthest a family can be BEHIND Greenwich
// and Pacific/Kiritimati (UTC+14) the furthest AHEAD, so together they span the
// full 26-hour spread over which "today" is ambiguous. America/Los_Angeles is
// the case from the bug report and the only one of the five that observes DST.
//
// The expected day keys are written out as literals rather than computed. A test
// that derives its expectation with the same helper the code under test uses can
// only prove the helper is self-consistent; these say what a wall clock in that
// house reads at that instant, and were worked out by hand from the offset.

type Rpc = { fn: string; args: Record<string, unknown> };

/** What `kid_progress_apply_completion` hands back on a successful award. */
const AWARD = {
  ok: true, xp: 40, level: 1, current_streak: 2, longest_streak: 3,
  last_activity: '2026-09-21',
  previous_level: 1, previous_streak: 1, previous_longest_streak: 3,
  previous_last_activity: '2026-09-20',
};

/**
 * A database that records what it was asked and otherwise says yes.
 *
 * `badgesFail` exists so the REVERSAL path can be driven too: the day keys a
 * rollback carries come off the award's own reply, and a half-conversion that
 * fixed the award while leaving the reversal naming Greenwich days would take
 * back a streak the row never had.
 */
function recordingClient(opts: { badgesFail?: boolean } = {}) {
  const rpcs: Rpc[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: fn === 'kid_progress_apply_completion' ? AWARD : { ok: true }, error: null });
    },
    from(table: string) {
      let operation = 'read';
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'maybeSingle', 'single', 'limit']) chain[method] = () => chain;
      chain.insert = () => { operation = 'insert'; return chain; };
      chain.update = () => { operation = 'update'; return chain; };
      chain.upsert = () => { operation = 'upsert'; return chain; };
      chain.then = (res: (value: unknown) => unknown, rej: (reason: unknown) => unknown) => {
        if (table === 'chore_assignments') return Promise.resolve({ data: null, error: null, count: 1 }).then(res, rej);
        if (table === 'member_badges' && operation === 'upsert') {
          return Promise.resolve(opts.badgesFail
            ? { data: null, error: new Error('badge write failed') }
            : { data: [], error: null }).then(res, rej);
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      };
      return chain;
    },
  };
  return { client, rpcs };
}

/** Approve one medium chore in `tz` at `instant`, and report the day it was filed against. */
async function filedAgainst(tz: string, instant: string): Promise<string> {
  const { client, rpcs } = recordingClient();
  await applyCompletionRewards(client as never, {
    familyId: 'fam-1', memberId: 'kid-1', difficulty: 'medium', qualityScore: 90,
    tz, now: new Date(instant),
  });
  const award = rpcs.find((r) => r.fn === 'kid_progress_apply_completion');
  expect(award, `no award was sent for ${tz} at ${instant}`).toBeDefined();
  return award!.args.p_today as string;
}

/** The Greenwich day key — the exact form this conversion removed. */
const greenwichDay = (instant: string) => new Date(instant).toISOString().slice(0, 10);

/** Whole calendar days between two `YYYY-MM-DD` keys. No instant involved, so no DST to trip on. */
function daysBetween(from: string, to: string): number {
  const at = (key: string) => {
    const [y, m, d] = key.split('-').map((part) => Number.parseInt(part, 10));
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Etc/GMT+12'] as const;

/**
 * One instant, five houses, and the day each kitchen wall reads.
 *
 * Offsets in force at these instants: UTC +0; America/Los_Angeles -7 (PDT, late
 * September); Asia/Tokyo +9; Pacific/Kiritimati +14; Etc/GMT+12 -12 (the POSIX
 * sign is inverted — `Etc/GMT+12` IS UTC-12).
 */
const CASES: Array<{ instant: string; local: string; expected: Record<string, string> }> = [
  {
    // The bug report, exactly: a chore approved at 17:00 on a Monday in Los Angeles.
    instant: '2026-09-22T00:00:00Z',
    local: '17:00 Sep 21 in Los Angeles',
    expected: {
      UTC: '2026-09-22',
      'America/Los_Angeles': '2026-09-21',
      'Asia/Tokyo': '2026-09-22',
      'Pacific/Kiritimati': '2026-09-22',
      'Etc/GMT+12': '2026-09-21',
    },
  },
  {
    // Mid-morning at Greenwich: only the far east has rolled over.
    instant: '2026-09-21T11:00:00Z',
    local: '04:00 Sep 21 in Los Angeles, 20:00 Sep 21 in Tokyo',
    expected: {
      UTC: '2026-09-21',
      'America/Los_Angeles': '2026-09-21',
      'Asia/Tokyo': '2026-09-21',
      'Pacific/Kiritimati': '2026-09-22',
      'Etc/GMT+12': '2026-09-20',
    },
  },
  {
    // A chore done before school in Tokyo: 08:30, and Greenwich still says yesterday.
    instant: '2026-09-21T23:30:00Z',
    local: '08:30 Sep 22 in Tokyo',
    expected: {
      UTC: '2026-09-21',
      'America/Los_Angeles': '2026-09-21',
      'Asia/Tokyo': '2026-09-22',
      'Pacific/Kiritimati': '2026-09-22',
      'Etc/GMT+12': '2026-09-21',
    },
  },
  {
    // Just after Greenwich midnight: the Americas are still on the previous evening.
    instant: '2026-09-21T00:30:00Z',
    local: '17:30 Sep 20 in Los Angeles',
    expected: {
      UTC: '2026-09-21',
      'America/Los_Angeles': '2026-09-20',
      'Asia/Tokyo': '2026-09-21',
      'Pacific/Kiritimati': '2026-09-21',
      'Etc/GMT+12': '2026-09-20',
    },
  },
  {
    // Midday at Greenwich — the only part of the day where most of the world agrees.
    instant: '2026-09-21T12:00:00Z',
    local: '05:00 Sep 21 in Los Angeles, 21:00 Sep 21 in Tokyo',
    expected: {
      UTC: '2026-09-21',
      'America/Los_Angeles': '2026-09-21',
      'Asia/Tokyo': '2026-09-21',
      'Pacific/Kiritimati': '2026-09-22',
      'Etc/GMT+12': '2026-09-21',
    },
  },
];

describe("an approved chore is filed on the family's day", () => {
  for (const { instant, local, expected } of CASES) {
    for (const tz of ZONES) {
      it(`${tz}: ${instant} (${local}) files against ${expected[tz]}`, async () => {
        expect(await filedAgainst(tz, instant)).toBe(expected[tz]);
      });
    }
  }

  it('hands the RPC a value its `date` parameter can accept, in every zone', async () => {
    // `p_today` is declared `date` in 0341. Anything that is not a bare
    // `YYYY-MM-DD` either fails the cast or is coerced by Postgres under the
    // SERVER's zone, which is the defect wearing a different hat.
    for (const tz of ZONES) {
      for (const { instant } of CASES) {
        expect(await filedAgainst(tz, instant), `${tz} @ ${instant}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('is not the Greenwich day — and this test could not pass if it were', async () => {
    // NON-VACUITY. Every case above would also pass against an implementation
    // that ignored the zone IF the zones happened to agree at that instant. This
    // is the case that cannot: at 17:00 in Los Angeles the family's day and
    // Greenwich's are different days, and the value the database receives must be
    // the family's.
    const instant = '2026-09-22T00:00:00Z';
    expect(greenwichDay(instant)).toBe('2026-09-22');
    expect(await filedAgainst('America/Los_Angeles', instant)).toBe('2026-09-21');
    expect(await filedAgainst('America/Los_Angeles', instant)).not.toBe(greenwichDay(instant));

    // And the mirror image, east of Greenwich, so a sign error is caught too.
    const morning = '2026-09-21T23:30:00Z';
    expect(greenwichDay(morning)).toBe('2026-09-21');
    expect(await filedAgainst('Asia/Tokyo', morning)).toBe('2026-09-22');
  });

  it('gives five houses different days for the same instant', async () => {
    // A Greenwich implementation returns ONE key here. Two distinct keys is the
    // floor that says the zone argument reached the arithmetic at all.
    const keys = await Promise.all(ZONES.map((tz) => filedAgainst(tz, '2026-09-21T11:00:00Z')));
    expect(new Set(keys).size).toBeGreaterThan(1);
    expect(keys).toEqual(['2026-09-21', '2026-09-21', '2026-09-21', '2026-09-22', '2026-09-20']);
  });

  it('steps by whole calendar days across both DST transitions', async () => {
    // 0341 decides a streak with `p_today - v_row.last_activity = 1`. That holds
    // only while two chores done at the same hour on consecutive LOCAL days
    // produce consecutive day KEYS — and a local day is 23 or 25 hours twice a
    // year, so anything derived by adding 86_400_000 to an instant is wrong on
    // exactly those two days and right on the other 363.
    //
    // Fall back, America/Los_Angeles, 1 November 2026: 17:00 local on 31 Oct is
    // PDT (UTC-7) and 17:00 local on 1 Nov is PST (UTC-8), so the two instants
    // are 25 hours apart.
    const fallBack = ['2026-11-01T00:00:00Z', '2026-11-02T01:00:00Z'];
    const fallKeys = await Promise.all(fallBack.map((i) => filedAgainst('America/Los_Angeles', i)));
    expect(fallKeys).toEqual(['2026-10-31', '2026-11-01']);
    expect(daysBetween(fallKeys[0], fallKeys[1])).toBe(1);
    expect(new Date(fallBack[1]).getTime() - new Date(fallBack[0]).getTime()).toBe(25 * 3_600_000);

    // Spring forward, 14 March 2027: the same two local hours are 23 hours apart.
    const springForward = ['2027-03-14T01:00:00Z', '2027-03-15T00:00:00Z'];
    const springKeys = await Promise.all(springForward.map((i) => filedAgainst('America/Los_Angeles', i)));
    expect(springKeys).toEqual(['2027-03-13', '2027-03-14']);
    expect(daysBetween(springKeys[0], springKeys[1])).toBe(1);
    expect(new Date(springForward[1]).getTime() - new Date(springForward[0]).getTime()).toBe(23 * 3_600_000);
  });

  it('carries the award\'s own day keys into the reversal rather than re-deriving them', async () => {
    // THE HALF-CONVERSION CHECK. The rollback restores the streak only while the
    // row still carries exactly what this award wrote, so the days it names must
    // be the days the DATABASE reported — never a second derivation that could
    // land on a different day than the award did.
    const { client, rpcs } = recordingClient({ badgesFail: true });
    await expect(applyCompletionRewards(client as never, {
      familyId: 'fam-1', memberId: 'kid-1', difficulty: 'medium', qualityScore: 90,
      tz: 'America/Los_Angeles', now: new Date('2026-09-22T00:00:00Z'),
    })).rejects.toThrow('Could not apply chore rewards');

    expect(rpcs.map((r) => r.fn)).toEqual([
      'kid_progress_apply_completion', 'kid_progress_revert_completion',
    ]);
    expect(rpcs[1].args.p_applied_last_activity).toBe(AWARD.last_activity);
    expect(rpcs[1].args.p_previous_last_activity).toBe(AWARD.previous_last_activity);
  });
});

describe('the chore engine reads no clock and no zone of its own', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Comments are stripped for the same reason the Greenwich-day guard strips
  // them: the block explaining this fix necessarily describes the shape it
  // removed, and a check satisfied by DELETING AN EXPLANATION measures nothing.
  const source = stripComments(readFileSync('lib/chores/server.ts', 'utf8'));

  it('builds no Greenwich day key', () => {
    expect(source).not.toMatch(/toISOString\(\)\s*\.slice\(0,\s*10\)/);
    expect(source).not.toMatch(/toISOString\(\)\s*\.split\('T'\)\[0\]/);
    expect(source).toContain("import { dayKeyInTz } from '@/lib/services/scope'");
    expect(source).toContain('dayKeyInTz(opts.now, opts.tz)');
  });

  it('takes the zone and the instant as required arguments, with no default', () => {
    // A DEFAULTED ZONE IS THE DEFECT WITH A FRIENDLIER FACE: it compiles at every
    // call site, so a caller that forgets to thread the family's zone silently
    // gets somebody else's day and nothing anywhere goes red. The weekly briefing
    // shipped Greenwich weeks for seven weeks behind exactly such a default.
    const fn = source.slice(source.indexOf('export async function applyCompletionRewards'));
    const signature = fn.slice(0, fn.indexOf('): Promise<CompletionResult>'));
    expect(signature).toMatch(/\btz: string;/);
    expect(signature).toMatch(/\bnow: Date;/);
    expect(signature).not.toMatch(/\btz\?:/);
    expect(signature).not.toMatch(/\bnow\?:/);
    expect(signature).not.toMatch(/\btz: string\s*=/);
    expect(signature).not.toMatch(/\bnow: Date\s*=/);
    // No clock read anywhere in the module: the instant is the caller's.
    expect(source).not.toMatch(/new Date\(\)/);
    expect(source).not.toMatch(/Date\.now\(\)/);
  });

  it('is reached by callers that pass the family\'s own zone', () => {
    // The step this conversion has been caught by before is the CONSUMER, not the
    // producer. `finalizeApproval` is the only path into the engine, and both of
    // its call sites must supply the zone off the family row rather than letting
    // the server's own day stand in.
    const missions = stripComments(readFileSync('app/(app)/missions/actions.ts', 'utf8'));
    expect(missions).toMatch(/const tz = ctx\.active\.family\.timezone \|\| 'UTC';/);
    expect(missions).toMatch(/args: \{ familyId: string; tz: string;/);
    expect(missions).toContain('tz: args.tz, now,');
    // Both call sites, named individually so dropping either one goes red.
    expect(missions).toContain('finalizeApproval(service, { familyId, tz,');
    expect(missions).toContain('familyId, tz, assignment, chore, submissionId, score,');
    // One instant for the row, not two: `approved_at` and the day key agree.
    expect(missions).toContain('approved_at: now.toISOString()');
    expect(missions).not.toMatch(/approved_at: new Date\(\)\.toISOString\(\),\s*approved_by: args\.actorId/);
  });
});
