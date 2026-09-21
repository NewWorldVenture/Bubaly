import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCompletionRewards, awardBadges, ensureProgress } from '@/lib/chores/server';
import { DIFFICULTY_XP } from '@/lib/chores/logic';

// The award and its reversal are RPCs as of 0341 — `kid_progress_apply_completion`
// reads the row FOR UPDATE so two approvals landing together both count, and
// `kid_progress_revert_completion` subtracts under the same lock rather than
// writing a pre-award snapshot back over whatever is there. So the boundaries
// below are asserted against those calls rather than against a blind
// `.from('kid_progress').update(…)`. What each case asserts is unchanged: the
// engine stops on a failed award, and it takes its own award back — and only
// its own — when the work after it fails.

type Result = { data: unknown; error: unknown; count?: number | null };
type Call = { table: string; operation: string };

const progress = {
  id: 'progress-1', family_id: 'family-1', member_id: 'member-1', xp: 10, level: 1,
  current_streak: 2, longest_streak: 4, last_activity: null,
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
};

/** What `kid_progress_apply_completion` hands back on a successful award. */
const applied = {
  ok: true, xp: 30, level: 1, current_streak: 3, longest_streak: 4, last_activity: '2026-07-02',
  previous_level: progress.level, previous_streak: progress.current_streak,
  previous_longest_streak: progress.longest_streak, previous_last_activity: progress.last_activity,
};

function fakeClient(
  resolveResult: (table: string, operation: string, calls: Call[]) => Result,
  resolveRpc: (fn: string, args: Record<string, unknown>) => Result = () => ({ data: applied, error: null }),
) {
  const calls: Call[] = [];
  const rpcArgs: Record<string, unknown>[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ table: fn, operation: 'rpc' });
      rpcArgs.push(args);
      return Promise.resolve(resolveRpc(fn, args));
    },
    from(table: string) {
      let operation = 'read';
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'maybeSingle', 'single', 'limit']) chain[method] = () => chain;
      chain.insert = () => { operation = 'insert'; calls.push({ table, operation }); return chain; };
      chain.update = () => { operation = 'update'; calls.push({ table, operation }); return chain; };
      chain.upsert = () => { operation = 'upsert'; calls.push({ table, operation }); return chain; };
      chain.then = (resolveValue: (value: Result) => unknown, rejectValue: (reason: unknown) => unknown) =>
        Promise.resolve(resolveResult(table, operation, calls)).then(resolveValue, rejectValue);
      return chain;
    },
  };
  return { client, calls, rpcArgs };
}

const rewardOptions = { familyId: 'family-1', memberId: 'member-1', difficulty: 'medium' as const, qualityScore: 100 };

/**
 * The rollback takes back THIS award and nothing else.
 *
 * It used to write the pre-award row back absolutely, which erased any approval
 * that landed beside it — the lost update pointing the other way. So the
 * reversal has to carry the XP this award added (relative, subtracted under the
 * row lock) and the snapshot it is allowed to put the streak back to, and the
 * values it wrote, so the function can tell whether anybody has written since.
 */
function expectTakesBackItsOwnAwardOnly(revert: Record<string, unknown> | undefined) {
  expect(revert, 'no reversal was sent').toBeDefined();
  expect(revert!.p_family_id).toBe(rewardOptions.familyId);
  expect(revert!.p_member_id).toBe(rewardOptions.memberId);
  expect(revert!.p_gained_xp).toBe(DIFFICULTY_XP.medium);
  expect(revert!.p_applied_streak).toBe(applied.current_streak);
  expect(revert!.p_applied_longest_streak).toBe(applied.longest_streak);
  expect(revert!.p_applied_last_activity).toBe(applied.last_activity);
  expect(revert!.p_previous_streak).toBe(progress.current_streak);
  expect(revert!.p_previous_longest_streak).toBe(progress.longest_streak);
  expect(revert!.p_previous_last_activity).toBe(progress.last_activity);
}

describe('chore reward persistence boundaries', () => {
  it('fails closed when the progress lookup fails', async () => {
    const { client, calls } = fakeClient((table, operation) => (
      table === 'kid_progress' && operation === 'read'
        ? { data: null, error: new Error('database unavailable') }
        : { data: null, error: null }
    ));

    await expect(ensureProgress(client as never, 'family-1', 'member-1')).rejects.toThrow('Could not read chore progress');
    expect(calls).toEqual([]);
  });

  it('does not continue after an XP progress write fails', async () => {
    const { client, calls } = fakeClient(
      () => ({ data: null, error: null }),
      () => ({ data: null, error: new Error('write failed') }),
    );

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not save chore progress');
    expect(calls).toEqual([{ table: 'kid_progress_apply_completion', operation: 'rpc' }]);
  });

  it('does not continue when the award comes back refused rather than errored', async () => {
    // The RPC reports a boundary it refused as `{ ok: false, reason }` with no
    // transport error, so a caller that only checks `error` would celebrate an
    // award that never happened.
    const { client, calls } = fakeClient(
      () => ({ data: null, error: null }),
      () => ({ data: { ok: false, reason: 'forbidden' }, error: null }),
    );

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not save chore progress');
    expect(calls).toEqual([{ table: 'kid_progress_apply_completion', operation: 'rpc' }]);
  });

  it('restores the prior progress row when chore history cannot be read', async () => {
    const { client, calls, rpcArgs } = fakeClient((table) => {
      if (table === 'chore_assignments') return { data: null, error: new Error('history failed'), count: null };
      return { data: null, error: null };
    });

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not apply chore rewards');
    expect(calls.map((call) => call.table)).toEqual([
      'kid_progress_apply_completion', 'kid_progress_revert_completion',
    ]);
    expectTakesBackItsOwnAwardOnly(rpcArgs[1]);
  });

  it('restores progress when badge persistence fails', async () => {
    const { client, calls, rpcArgs } = fakeClient((table, operation) => {
      if (table === 'chore_assignments') return { data: null, error: null, count: 1 };
      if (table === 'member_badges' && operation === 'read') return { data: [], error: null };
      if (table === 'member_badges' && operation === 'upsert') return { data: null, error: new Error('badge write failed') };
      return { data: null, error: null };
    });

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not apply chore rewards');
    expect(calls.filter((call) => call.operation === 'rpc').map((call) => call.table)).toEqual([
      'kid_progress_apply_completion', 'kid_progress_revert_completion',
    ]);
    expectTakesBackItsOwnAwardOnly(rpcArgs[1]);
  });

  it('returns only badges actually inserted by an idempotent upsert', async () => {
    const { client, calls } = fakeClient((table, operation) => {
      if (table === 'member_badges' && operation === 'read') return { data: [], error: null };
      if (table === 'member_badges' && operation === 'upsert') return { data: [{ badge_id: 'first_chore' }], error: null };
      return { data: null, error: null };
    });

    await expect(awardBadges(client as never, 'family-1', 'member-1', ['first_chore', 'first_chore']))
      .resolves.toEqual(['first_chore']);
    expect(calls).toEqual([{ table: 'member_badges', operation: 'upsert' }]);
  });

  it('rolls an approved assignment back when reward application fails', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/(app)/missions/actions.ts'), 'utf8');

    expect(source).toContain(".eq('family_id', args.familyId).select('id').single()");
    expect(source).toContain("throw new Error('Could not save chore approval')");
    expect(source).toContain("const { error: rollbackError } = await supabase.from('chore_assignments').update");
    expect(source).toContain('args.assignment.points_awarded');
  });
});
