import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/**
 * A service-role stub that answers `resolveFamilyPlanLevel` for an entitled
 * family, and nothing else.
 *
 * Routes behind a feature-gated page resolve the family's plan before they do
 * any work, and `resolveFamilyPlanLevel` always reads through the SERVICE
 * client — the client handed to it is accepted for call-site symmetry and then
 * ignored (see the note in `lib/server/plan.ts`). So a test that drives one of
 * those routes has to supply one, or the plan read fails and the route
 * correctly answers 503.
 *
 * The plan is SEEDED rather than the gate mocked away, so these tests keep
 * exercising the real entitlement path. Hand it a lower plan to watch a route
 * refuse.
 */
export function entitledServiceClient(plan = 'plus'): SupabaseClient<Database> {
  const resultFor = (table: string) =>
    table === 'subscriptions'
      ? { data: [{ plan, status: 'active' }], error: null }
      : table === 'families'
        ? { data: { trial_ends_at: null, closed_at: null }, error: null }
        : { data: null, error: null };

  const from = (table: string) => {
    const result = resultFor(table);
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'neq', 'order', 'limit', 'maybeSingle', 'single']) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };

  return { from } as unknown as SupabaseClient<Database>;
}
