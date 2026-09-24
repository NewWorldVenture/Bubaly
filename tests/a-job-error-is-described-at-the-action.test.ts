import { describe, expect, it, vi } from 'vitest';

/**
 * The on-demand prep and twin actions pass their runner's error on. (SEC-023)
 *
 * `runPrepGeneration` and `runTwinProjection` return the database's own
 * message, which is right for the model-refresh cron that logs it. The two
 * user-facing actions returned it as `error: res.error` — one step removed from
 * the `error.message` shape the app/ scan looks for, so the scan could not see
 * them. They now describe it; a classified error still comes through.
 */

const RAW = 'invalid input syntax for type uuid: "not-a-uuid"';
const runner = vi.hoisted(() => ({ result: { ok: false, error: '' } as Record<string, unknown> }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'u' }, active: { familyId: 'f' } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}) }));
vi.mock('@/lib/planning/prep-server', () => ({ runPrepGeneration: async () => runner.result }));
vi.mock('@/lib/twin/project-server', () => ({ runTwinProjection: async () => runner.result }));

import { generatePrepPlansAction } from '@/app/(app)/dashboard/prep-plans/prep-actions';
import { projectTwinAction } from '@/app/(app)/dashboard/graph/twin-actions';

describe.each([
  ['generatePrepPlansAction', generatePrepPlansAction],
  ['projectTwinAction', projectTwinAction],
] as const)('%s', (_name, action) => {
  it('does not hand the database\'s text to the user', async () => {
    runner.result = { ok: false, error: RAW };
    const res = await action();
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain('invalid input syntax');
    expect(res.error).toBeTruthy();
  });

  it('still says when the person lacks permission', async () => {
    runner.result = { ok: false, error: 'new row violates row-level security policy for table "x"' };
    expect((await action()).error).toMatch(/permission/i);
  });
});
