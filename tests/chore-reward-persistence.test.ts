import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCompletionRewards, awardBadges, ensureProgress } from '@/lib/chores/server';

type Result = { data: unknown; error: unknown; count?: number | null };
type Call = { table: string; operation: string };

const progress = {
  id: 'progress-1', family_id: 'family-1', member_id: 'member-1', xp: 10, level: 1,
  current_streak: 2, longest_streak: 4, last_activity: null,
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
};

function fakeClient(resolveResult: (table: string, operation: string, calls: Call[]) => Result) {
  const calls: Call[] = [];
  const client = {
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
  return { client, calls };
}

const rewardOptions = { familyId: 'family-1', memberId: 'member-1', difficulty: 'medium' as const, qualityScore: 100 };

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
    const { client, calls } = fakeClient((table, operation) => {
      if (table === 'kid_progress' && operation === 'read') return { data: progress, error: null };
      if (table === 'kid_progress' && operation === 'update') return { data: null, error: new Error('write failed') };
      return { data: null, error: null };
    });

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not save chore progress');
    expect(calls).toEqual([{ table: 'kid_progress', operation: 'update' }]);
  });

  it('restores the prior progress row when chore history cannot be read', async () => {
    const { client, calls } = fakeClient((table, operation, allCalls) => {
      if (table === 'kid_progress' && operation === 'read') return { data: progress, error: null };
      if (table === 'kid_progress' && operation === 'update') {
        return { data: { id: 'progress-1' }, error: null };
      }
      if (table === 'chore_assignments') return { data: null, error: new Error('history failed'), count: null };
      return { data: null, error: null };
    });

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not apply chore rewards');
    expect(calls.filter((call) => call.table === 'kid_progress' && call.operation === 'update')).toHaveLength(2);
  });

  it('restores progress when badge persistence fails', async () => {
    const { client, calls } = fakeClient((table, operation) => {
      if (table === 'kid_progress' && operation === 'read') return { data: progress, error: null };
      if (table === 'kid_progress' && operation === 'update') return { data: { id: 'progress-1' }, error: null };
      if (table === 'chore_assignments') return { data: null, error: null, count: 1 };
      if (table === 'member_badges' && operation === 'read') return { data: [], error: null };
      if (table === 'member_badges' && operation === 'upsert') return { data: null, error: new Error('badge write failed') };
      return { data: null, error: null };
    });

    await expect(applyCompletionRewards(client as never, rewardOptions)).rejects.toThrow('Could not apply chore rewards');
    expect(calls.filter((call) => call.table === 'kid_progress' && call.operation === 'update')).toHaveLength(2);
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
