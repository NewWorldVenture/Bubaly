import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('the store must use the injected client'); } }));

const { updateRequest, updateRun, updateStep } = await import('@/lib/ai/runs/store');
import type { ServiceScope } from '@/lib/services/types';

/**
 * Audit C1-S9-66 — the run graph's state transitions answer for what they
 * changed.
 *
 * `updateRequest`, `updateStep` and `updateRun` returned `ok(null)` for an
 * update that matched nothing, so the executor went on believing a transition
 * had landed. The executor's own tests inject a fake port and never reach the
 * store, so nothing exercised these three against a client at all.
 */
type Reply = { data: unknown; error: unknown };
function client(reply: Reply) {
  const filters: Record<string, unknown> = {};
  const chain = {
    update: () => chain,
    eq: (c: string, v: unknown) => { filters[c] = v; return chain; },
    // A real client answers `.select()` on an update with the rows it changed.
    select: async () => reply,
  };
  return { db: { from: () => chain } as never, filters };
}
const scope = (db: never) => ({ familyId: 'fam-1', actorKind: 'system', db, userId: 'u-1' }) as unknown as ServiceScope;

const cases = [
  ['updateRequest', (s: ServiceScope, db: never) => updateRequest(s, 'req-1', { status: 'completed' } as never, { db })],
  ['updateStep', (s: ServiceScope, db: never) => updateStep(s, 'step-1', { status: 'done' } as never, { db })],
  ['updateRun', (s: ServiceScope, db: never) => updateRun(s, 'run-1', { state: 'completed' } as never, { db })],
] as const;

describe('run-graph transitions report a write that matched nothing (C1-S9-66)', () => {
  for (const [name, call] of cases) {
    it(`${name}: a matched row is ok`, async () => {
      const { db, filters } = client({ data: [{ id: 'x' }], error: null });
      const res = await call(scope(db), db);
      expect(res.ok, name).toBe(true);
      expect(filters.family_id, name).toBe('fam-1');
    });

    it(`${name}: zero rows is a failure, not ok`, async () => {
      const { db } = client({ data: [], error: null });
      const res = await call(scope(db), db);
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.retryable, name).toBe(true);
    });

    it(`${name}: an error is still a failure`, async () => {
      const { db } = client({ data: null, error: { code: '08006', message: 'connection failure' } });
      const res = await call(scope(db), db);
      expect(res.ok, name).toBe(false);
    });
  }
});
