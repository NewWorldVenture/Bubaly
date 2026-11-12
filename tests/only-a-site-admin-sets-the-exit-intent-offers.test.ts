// The exit-intent offer actions (app/(app)/admin/marketing/exit-intent/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. An exit-intent offer is shown to every matching public visitor,
// so it is a site-admin control: the /admin layout renders only for a super
// admin (app/(app)/admin/layout.tsx:14), and each action re-verifies through
// requireMarketingAdmin (lib/marketing/admin.ts:76), which refuses a signed-out
// caller (401), anyone not on the super_admins allowlist (403) and an admin who
// still owes a two-step code (403). A household's roles grant nothing here: a
// family's parent is not a platform admin. marketing_exit_intent is site-wide,
// not family data, so there is no "other family" id to reach.
//
// WHAT IS ASSERTED: the super admin's call writes exactly the row (or the
// status / soft-delete) it promises and one audit row; every other caller is
// refused with the gate's own status and no table of either household, the
// offers or the audit log changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: h.revalidateTag }));

const { createExitIntentAction, toggleExitIntentAction, deleteExitIntentAction } =
  await import('@/app/(app)/admin/marketing/exit-intent/actions');

const CREATE = 'ACTION-0AD61A98DD69';
const TOGGLE = 'ACTION-727733BB15E7';
const DELETE = 'ACTION-5E46A704BA79';
const OFFER = 'e1000000-0000-4000-8000-000000000001';

let db: InMemorySupabase;

function createForm(): FormData {
  const fd = new FormData();
  fd.set('name', 'Spring offer');
  fd.set('headline', 'Before you go');
  fd.set('body', 'Try the family plan free for 14 days.');
  fd.set('cta_label', 'Start free');
  fd.set('cta_href', '/signup');
  fd.set('source', 'google, newsletter');
  fd.set('mode', 'scroll');
  fd.set('delayMs', '1500');
  fd.set('scrollPercent', '40');
  fd.set('priority', '3');
  fd.set('status', 'active');
  return fd;
}

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.revalidateTag.mockReset();
  db = newAdminWorld();
  db.seed('marketing_exit_intent', [{
    id: OFFER, name: 'Seeded offer', headline: 'Wait', status: 'paused', priority: 0,
    match: {}, trigger_config: { mode: 'mouseleave', delayMs: 0, scrollPercent: 60 }, deleted_at: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const ACTIONS = [
  { id: CREATE, name: 'createExitIntentAction', run: () => createExitIntentAction(createForm()) },
  { id: TOGGLE, name: 'toggleExitIntentAction', run: () => toggleExitIntentAction(OFFER, true) },
  { id: DELETE, name: 'deleteExitIntentAction', run: () => deleteExitIntentAction(OFFER) },
];

describe(`${CREATE} createExitIntentAction`, () => {
  it(`${CREATE} a super admin creates the offer exactly as submitted`, async () => {
    signInAs({ kind: 'super_admin' });
    await createExitIntentAction(createForm());
    const created = db.table('marketing_exit_intent').filter((row) => row.id !== OFFER);
    expect(created).toEqual([expect.objectContaining({
      name: 'Spring offer', headline: 'Before you go', body: 'Try the family plan free for 14 days.',
      cta_label: 'Start free', cta_href: '/signup', match: { source: ['google', 'newsletter'] },
      trigger_config: { mode: 'scroll', delayMs: 1500, scrollPercent: 40 }, priority: 3, status: 'active',
      created_by: SUPER_ADMIN.id,
    })]);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'create', resource: 'marketing_exit_intent', resource_id: created[0].id, actor_id: SUPER_ADMIN.id,
    })]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/marketing/exit-intent');
  });
});

describe(`${TOGGLE} toggleExitIntentAction`, () => {
  it(`${TOGGLE} a super admin activates, then pauses, the offer`, async () => {
    signInAs({ kind: 'super_admin' });
    await toggleExitIntentAction(OFFER, true);
    expect(db.table('marketing_exit_intent')).toEqual([expect.objectContaining({ id: OFFER, status: 'active', deleted_at: null })]);
    await toggleExitIntentAction(OFFER, false);
    expect(db.table('marketing_exit_intent')).toEqual([expect.objectContaining({ id: OFFER, status: 'paused' })]);
    expect(db.table('marketing_audit_logs').map((row) => [row.action, row.resource_id, row.metadata])).toEqual([
      ['update', OFFER, { status: 'active' }],
      ['update', OFFER, { status: 'paused' }],
    ]);
  });
});

describe(`${DELETE} deleteExitIntentAction`, () => {
  it(`${DELETE} a super admin soft-deletes the offer, and a second delete finds nothing`, async () => {
    signInAs({ kind: 'super_admin' });
    await deleteExitIntentAction(OFFER);
    expect(db.table('marketing_exit_intent')).toEqual([expect.objectContaining({ id: OFFER, deleted_at: expect.any(String) })]);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({ action: 'delete', resource_id: OFFER, actor_id: SUPER_ADMIN.id })]);
    await expect(deleteExitIntentAction(OFFER)).rejects.toThrow();
    expect(db.table('marketing_audit_logs')).toHaveLength(1);
  });
});

describe.each(ACTIONS)('$id $name refuses everyone but a site admin', ({ id, run }) => {
  it.each(REFUSED_CALLERS)(`${id} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(run()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_exit_intent')).toEqual([expect.objectContaining({ id: OFFER, status: 'paused', deleted_at: null })]);
    expect(db.table('marketing_audit_logs')).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });
});
