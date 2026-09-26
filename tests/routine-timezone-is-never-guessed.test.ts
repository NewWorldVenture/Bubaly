// A routine fired against the wrong clock fires on the wrong DAY near midnight,
// and nothing fails when it happens.
//
// Both timezone reads in the routine worker were written as:
//
//     const { data: family } = await db.from('families')...maybeSingle();
//     const tz = family?.timezone ?? 'America/New_York';
//
// Two defects in two lines. The read sat INSIDE the loop — one round trip per
// rule, repeating the identical read for every rule a family owns. And it
// discarded the error, so a failed read silently became New York: a household
// in Berlin or Sydney gets its routines fired against the wrong clock with
// nothing to show for it. Audit C4-S4-08.
//
// Skipping is safe and self-correcting — `next_run_at` is untouched, so the
// rule stays due and the next tick retries. Firing at the wrong time is not
// recoverable, which is why the fix refuses rather than guesses.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rules: [] as Row[],
  families: [] as Row[],
  familyReads: 0,
  failFamilyRead: false,
}));

const mocks = vi.hoisted(() => ({
  createRequest: vi.fn(), createRun: vi.fn(), kickRun: vi.fn(),
  getAISettings: vi.fn(), nextRelativeFire: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const filters: Row = {};
      const b: Row = {};
      const rows = () => {
        if (table === 'families') {
          state.familyReads += 1;
          // The worker now reads every family for the tick in one `.in('id', …)`
          // rather than one `.eq('id', …)` per rule, so the fake answers both.
          const ids = filters['in:id'] as string[] | undefined;
          if (ids) return state.families.filter((r) => ids.includes(r.id as string));
          return state.families.filter((r) => r.id === filters.id);
        }
        if (table === 'family_automation_rules') {
          return state.rules.filter((r) => Object.entries(filters).every(([c, v]) => c.startsWith('lte:') || c.startsWith('not:') || c.startsWith('is:') || r[c] === v));
        }
        return [];
      };
      const result = () => {
        if (table === 'families' && state.failFamilyRead) {
          return { data: null, error: { code: '08006', message: 'connection failure' } };
        }
        return { data: rows(), error: null };
      };
      Object.assign(b, {
        select: () => b, order: () => b, limit: () => b,
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        lte: () => b, not: () => b, is: () => b,
        in: (c: string, v: unknown) => { filters[`in:${c}`] = v; return b; },
        insert: () => b, update: () => b,
        single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: (resolve: (v: unknown) => void) => resolve(result()),
      });
      return b;
    },
  }),
}));

vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: mocks.getAISettings }));
vi.mock('@/lib/ai/runs/store', () => ({ createRequest: mocks.createRequest, createRun: mocks.createRun }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: mocks.kickRun }));
vi.mock('@/lib/services/routines', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/routines')>('@/lib/services/routines');
  return { ...actual, nextRelativeFire: mocks.nextRelativeFire };
});

const { GET } = await import('@/app/api/cron/family-routines/route');
const call = () => GET(new Request('https://bubaly.com/api/cron/family-routines') as never);

const DUE_RULE = (id: string) => ({
  id, family_id: 'fam-1', schedule_kind: 'cron', schedule_expr: '0 7 * * *',
  anchor_key: null, offset_days: null, at_hour: 7, said: null,
  next_run_at: '2020-01-01T07:00:00.000Z', is_enabled: true,
});

describe('a routine is never fired against a guessed clock (C4-S4-08)', () => {
  beforeEach(() => {
    state.rules = []; state.families = [{ id: 'fam-1', timezone: 'Europe/Berlin' }];
    state.familyReads = 0; state.failFamilyRead = false;
    mocks.getAISettings.mockResolvedValue({ paused: true });
  });

  it('does not read a family timezone once per rule', async () => {
    // The invariant is that the read does not SCALE with the rules, which is
    // what the N+1 did. Pinning an absolute count instead pins an
    // implementation: this asserted `<= 1` when one cached reader was shared
    // across both loops, and went red when the worker moved to one batched
    // read per loop — a change that made the defect no less fixed. Tripling
    // the rules and requiring the count not to move survives both shapes and
    // still fails the thing it is named for.
    state.rules = [DUE_RULE('r1'), DUE_RULE('r2'), DUE_RULE('r3')];
    await call();
    const readsForThree = state.familyReads;

    state.familyReads = 0;
    state.rules = ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12'].map(DUE_RULE);
    await call();
    const readsForNine = state.familyReads;

    expect(readsForNine, 'three times the rules must not mean more timezone reads')
      .toBe(readsForThree);
    expect(readsForThree, 'a tick must not read one family a dozen times').toBeLessThanOrEqual(3);
  });

  it('fires nothing and reports the failure when the timezone read fails', async () => {
    // The CONTRACT changed under this test and the intent had to survive it.
    // It used to assert `{ ok: false, problems > 0, filed: 0 }`, because the
    // zone was read per rule and an unplaceable rule was counted as a problem
    // while the tick carried on. The read is now batched for the whole tick, so
    // its failure is not one rule's problem — it is every rule's, and the
    // worker answers 500 and fires nothing. What must not change is the thing
    // the test is named for: nothing is filed against a guessed clock.
    state.rules = [DUE_RULE('r1')];
    state.failFamilyRead = true;
    const res = await call();
    expect(res.status, 'a tick that could not establish a clock must not report success').toBe(500);
    expect(mocks.createRequest, 'nothing may be filed against a guessed clock').not.toHaveBeenCalled();
  });
});
