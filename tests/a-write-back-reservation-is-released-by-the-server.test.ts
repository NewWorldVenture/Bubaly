// `materializeConciergePlan` reserves a `concierge_plan_actions` row before it
// creates the record, and releases the reservation if the create fails. That
// release went through the CALLER's client, so it relied on 0158's member
// DELETE policy — the same policy that lets anyone in the family erase ledger
// rows and have the next apply create every record again. Releasing through the
// server's writer lets that policy be dropped without stranding a kind.
import { describe, expect, it, vi } from 'vitest';

type Deleted = { client: string; filters: Record<string, unknown> };
const deleted = vi.hoisted(() => ({ calls: [] as Deleted[] }));

function fake(name: string, opts: { calendarError?: unknown } = {}) {
  return {
    from(table: string) {
      let mode: 'read' | 'insert' | 'delete' | 'update' = 'read';
      const filters: Record<string, unknown> = {};
      const run = async () => {
        if (table === 'concierge_plan_actions') {
          if (mode === 'read') return { data: [], error: null };
          if (mode === 'insert') return { data: { id: 'reservation-1' }, error: null };
          if (mode === 'delete') {
            deleted.calls.push({ client: name, filters: { ...filters } });
            // With no member DELETE policy, RLS deletes nothing and says nothing.
            return { data: name === 'service' ? [{ id: filters.id }] : [], error: null };
          }
          return { data: [{ id: filters.id }], error: null };
        }
        if (table === 'calendar_events') return opts.calendarError ? { data: null, error: opts.calendarError } : { data: { id: 'ev-1' }, error: null };
        return { data: { id: 'x' }, error: null };
      };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b, single: () => run(), maybeSingle: () => run(),
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return b; },
        insert: () => { mode = 'insert'; return b; },
        update: () => { mode = 'update'; return b; },
        delete: () => { mode = 'delete'; return b; },
        then: (ok: (v: unknown) => void, bad: (e: unknown) => void) => run().then(ok, bad),
      });
      return b;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fake('service') }));

const { materializeConciergePlan } = await import('@/lib/services/approvals');

describe('a failed write-back releases its reservation through the server', () => {
  it('the release is the service writer\'s, scoped to the reservation, the family and the plan', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const member = fake('member', { calendarError: { message: 'refused' } });
    const plan = { id: 'plan-1', title: 'Zoo', description: null, location: null, planned_for: '2026-09-12', budget_cents: null };
    const result = await materializeConciergePlan(member as never, 'fam-1', 'user-1', plan, ['calendar']);
    expect(result).toEqual({ applied: [], failed: ['calendar'] });
    expect(deleted.calls).toEqual([{ client: 'service', filters: { id: 'reservation-1', family_id: 'fam-1', plan_id: 'plan-1', 'is:target_id': null } }]);
    expect(errors.mock.calls.some(([m]) => String(m).includes('could not release'))).toBe(false);
    errors.mockRestore();
  });
});
