// setBenchmarksPublicationAction (app/(app)/admin/benchmarks/actions.ts), called
// as every kind of caller with a valid form.
//
// THE POLICY. The switch publishes /resources/benchmarks to the public web. It
// is a site-admin control: the /admin layout renders it only for a super admin,
// and the action re-verifies through requireMarketingAdmin (lib/marketing/admin.ts),
// which refuses anyone else. A household's roles say nothing here — a family's
// parent is not a platform admin — and marketing_settings is not family data,
// so there is no "other family" to reach.
//
// WHAT IS ASSERTED: the super admin's call writes exactly the flag and one
// audit row; every other caller is refused with the gate's own status and the
// tables of both households, the settings and the audit log are unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const { setBenchmarksPublicationAction } = await import('@/app/(app)/admin/benchmarks/actions');

const ID = 'ACTION-2E23B34F2298';
let db: InMemorySupabase;

const form = (published: boolean) => {
  const fd = new FormData();
  fd.set('published', String(published));
  return fd;
};

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('marketing_settings', [{ key: 'benchmarks_public', value: { enabled: false }, updated_by: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe(`${ID} setBenchmarksPublicationAction`, () => {
  it(`${ID} a super admin publishes, then unpublishes, the benchmarks page`, async () => {
    signInAs({ kind: 'super_admin' });
    await setBenchmarksPublicationAction(form(true));
    expect(db.table('marketing_settings')).toEqual([
      expect.objectContaining({ key: 'benchmarks_public', value: { enabled: true }, updated_by: SUPER_ADMIN.id }),
    ]);
    await setBenchmarksPublicationAction(form(false));
    expect(db.table('marketing_settings')).toEqual([
      expect.objectContaining({ key: 'benchmarks_public', value: { enabled: false } }),
    ]);
    expect(db.table('marketing_audit_logs').map((row) => [row.action, row.actor_id, row.resource_id])).toEqual([
      ['publish', SUPER_ADMIN.id, 'benchmarks_public'],
      ['unpublish', SUPER_ADMIN.id, 'benchmarks_public'],
    ]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/resources/benchmarks');
  });

  it.each(REFUSED_CALLERS)(`${ID} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(setBenchmarksPublicationAction(form(true))).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_settings')[0].value).toEqual({ enabled: false });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
