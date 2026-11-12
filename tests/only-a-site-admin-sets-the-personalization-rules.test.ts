// The personalization rule actions (app/(app)/admin/marketing/personalization/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. A personalization rule swaps the copy a public visitor sees on a
// marketing slot, so it is a site-admin control: the /admin layout renders only
// for a super admin (app/(app)/admin/layout.tsx:14), and each action re-verifies
// through requireMarketingAdmin (lib/marketing/admin.ts:76), which refuses a
// signed-out caller (401), anyone not on the super_admins allowlist (403) and an
// admin who still owes a two-step code (403). A household's roles grant nothing
// here: a family's parent is not a platform admin.
// marketing_personalization_rules is site-wide, not family data, so there is no
// "other family" id to reach.
//
// WHAT IS ASSERTED: the super admin's call writes exactly the rule (or the
// status / soft-delete) it promises and one audit row; every other caller is
// refused with the gate's own status and no table of either household, the
// rules or the audit log changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: h.revalidateTag }));

const { createRuleAction, toggleRuleStatusAction, deleteRuleAction } =
  await import('@/app/(app)/admin/marketing/personalization/actions');

const CREATE = 'ACTION-BEB0BE97AA24';
const TOGGLE = 'ACTION-C0C5317102F6';
const DELETE = 'ACTION-E202B0737B2A';
const RULE = 'e2000000-0000-4000-8000-000000000001';

let db: InMemorySupabase;

function createForm(): FormData {
  const fd = new FormData();
  fd.set('name', 'Newsletter hero');
  fd.set('slot', 'home_hero');
  fd.set('source', 'newsletter');
  fd.set('paths', '/, /pricing');
  fd.set('returning', 'true');
  fd.set('minSessions', '2');
  fd.set('headline', 'Welcome back');
  fd.set('cta_label', 'See plans');
  fd.set('cta_href', '/pricing');
  fd.set('priority', '5');
  fd.set('status', 'paused');
  return fd;
}

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.revalidateTag.mockReset();
  db = newAdminWorld();
  db.seed('marketing_personalization_rules', [{
    id: RULE, name: 'Seeded rule', slot: 'home_hero', status: 'paused', priority: 0,
    match: {}, variant: { headline: 'Hello' }, deleted_at: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const ACTIONS = [
  { id: CREATE, name: 'createRuleAction', run: () => createRuleAction(createForm()) },
  { id: TOGGLE, name: 'toggleRuleStatusAction', run: () => toggleRuleStatusAction(RULE, true) },
  { id: DELETE, name: 'deleteRuleAction', run: () => deleteRuleAction(RULE) },
];

describe(`${CREATE} createRuleAction`, () => {
  it(`${CREATE} a super admin creates the rule exactly as submitted`, async () => {
    signInAs({ kind: 'super_admin' });
    await createRuleAction(createForm());
    const created = db.table('marketing_personalization_rules').filter((row) => row.id !== RULE);
    expect(created).toEqual([expect.objectContaining({
      name: 'Newsletter hero', slot: 'home_hero',
      match: { source: ['newsletter'], paths: ['/', '/pricing'], returning: true, minSessions: 2 },
      variant: { headline: 'Welcome back', cta_label: 'See plans', cta_href: '/pricing' },
      priority: 5, status: 'paused', created_by: SUPER_ADMIN.id,
    })]);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'create', resource: 'marketing_personalization_rule', resource_id: created[0].id, actor_id: SUPER_ADMIN.id,
      metadata: { name: 'Newsletter hero', slot: 'home_hero' },
    })]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/marketing/personalization');
  });
});

describe(`${TOGGLE} toggleRuleStatusAction`, () => {
  it(`${TOGGLE} a super admin activates, then pauses, the rule`, async () => {
    signInAs({ kind: 'super_admin' });
    await toggleRuleStatusAction(RULE, true);
    expect(db.table('marketing_personalization_rules')).toEqual([expect.objectContaining({ id: RULE, status: 'active', deleted_at: null })]);
    await toggleRuleStatusAction(RULE, false);
    expect(db.table('marketing_personalization_rules')).toEqual([expect.objectContaining({ id: RULE, status: 'paused' })]);
    expect(db.table('marketing_audit_logs').map((row) => [row.action, row.resource_id, row.metadata])).toEqual([
      ['update', RULE, { status: 'active' }],
      ['update', RULE, { status: 'paused' }],
    ]);
  });
});

describe(`${DELETE} deleteRuleAction`, () => {
  it(`${DELETE} a super admin soft-deletes the rule, and a second delete finds nothing`, async () => {
    signInAs({ kind: 'super_admin' });
    await deleteRuleAction(RULE);
    expect(db.table('marketing_personalization_rules')).toEqual([expect.objectContaining({ id: RULE, deleted_at: expect.any(String) })]);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({ action: 'delete', resource_id: RULE, actor_id: SUPER_ADMIN.id })]);
    await expect(deleteRuleAction(RULE)).rejects.toThrow();
    expect(db.table('marketing_audit_logs')).toHaveLength(1);
  });
});

describe.each(ACTIONS)('$id $name refuses everyone but a site admin', ({ id, run }) => {
  it.each(REFUSED_CALLERS)(`${id} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(run()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_personalization_rules')).toEqual([expect.objectContaining({ id: RULE, status: 'paused', deleted_at: null })]);
    expect(db.table('marketing_audit_logs')).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });
});
