// Money must not lose an update.
//
// `savings-view` computed the new balance in the browser and wrote it back:
//
//   const next = Math.max(0, Number(g.current_amount) + delta);
//   await sb.from('savings_goals').update({ current_amount: next }).eq('id', g.id);
//
// `g.current_amount` is whatever that tab last rendered. Two parents each adding
// £20 to a goal holding £100 both compute £120 and both write £120: the family
// put in £40, the goal gained £20, and both were told it worked.
//
// `contributeToSavingsGoal` takes the DELTA and writes it under a compare-and-set
// — the update carries the value it read as a condition, so a write that matches
// no row means someone moved it first and is retried rather than clobbering.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { contributeToSavingsGoal } from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1',
  role: 'parent', actorKind: 'member', tz: 'America/New_York',
});
const goal = () => db.table('savings_goals').find((r) => r.id === 'goal-1');

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { savings_goals: { emoji: null, target_date: null }, audit_logs: { resource_id: null, metadata: null } },
  });
  db.seed('savings_goals', [{
    id: 'goal-1', family_id: FAMILY, name: 'Disney trip', target_amount: 1000, current_amount: 100,
  }]);
});

describe('contributing to a savings goal', () => {
  it('adds the amount', async () => {
    const res = await contributeToSavingsGoal(scope(), 'goal-1', 20);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(goal()?.current_amount).toBe(120);
  });

  it('keeps BOTH contributions when someone else lands one first', async () => {
    // The race, staged exactly: another parent's £20 commits between our read
    // and our write. The old code wrote 120 over their 120 and lost £20; this
    // must see 120, add to it, and finish at 140.
    const real = db.from.bind(db);
    let raced = false;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      if (table === 'savings_goals' && !raced) {
        raced = true;                       // let OUR read happen first...
        return real(table);
      }
      if (table === 'savings_goals' && raced && goal()?.current_amount === 100) {
        goal()!.current_amount = 120;        // ...then they commit, before our update
      }
      return real(table);
    });

    const res = await contributeToSavingsGoal(scope(), 'goal-1', 20);
    vi.restoreAllMocks();

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(goal()?.current_amount).toBe(140);
  });

  it('never takes a goal below zero', async () => {
    const res = await contributeToSavingsGoal(scope(), 'goal-1', -500);
    expect(res.ok).toBe(true);
    expect(goal()?.current_amount).toBe(0);
  });

  it('refuses an amount that is not one', async () => {
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await contributeToSavingsGoal(scope(), 'goal-1', bad)).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(goal()?.current_amount).toBe(100);
  });

  it('will not touch another family\'s goal', async () => {
    db.seed('savings_goals', [{ id: 'goal-2', family_id: 'family-2', name: 'Their car', target_amount: 500, current_amount: 50 }]);
    const res = await contributeToSavingsGoal(scope(), 'goal-2', 20);
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('savings_goals').find((r) => r.id === 'goal-2')?.current_amount).toBe(50);
  });

  it('records what was put in, on the household trail', async () => {
    await contributeToSavingsGoal(scope(), 'goal-1', 20);
    const row = db.table('audit_logs').at(-1);
    expect(row?.resource).toBe('finances');
    expect((row?.metadata as { title?: string })?.title).toContain('Disney trip');
  });
});
