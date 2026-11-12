// saveSocialLinksAction (app/(app)/admin/settings/social-links/actions.ts),
// called as every kind of caller with a valid form.
//
// THE POLICY. The social profile links are the company's own accounts, shown in
// every public page's footer (lib/marketing/social-links.ts:1-5): site-wide, not
// per family, so a household role says nothing and there is no "other family".
// The action is gated by superAdminGate (actions.ts:43; lib/auth/super-admin-gate.ts:31-42)
// and answers a refusal rather than throwing. The write is a compare-and-set on
// the revision the form was rendered from (lib/server/social-links.ts:204-213).
//
// WHAT IS ASSERTED: the super admin's save replaces the stored links with the
// sanitized set and writes one site-admin audit row holding the previous value;
// every other caller is refused and every table of both households is unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';
import { socialLinksRevision } from '@/lib/server/social-links';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({
  revalidatePath: h.revalidatePath,
  revalidateTag: h.revalidateTag,
  unstable_cache: <T,>(fn: T) => fn,
}));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTranslations: async () => (key: string) => key,
}));

const { saveSocialLinksAction } = await import('@/app/(app)/admin/settings/social-links/actions');

const ID = 'ACTION-14BD09590041';
const STORED = { facebook: 'https://www.facebook.com/old-fixture' };
let db: InMemorySupabase;

const form = (revision: string) => {
  const fd = new FormData();
  fd.set('revision', revision);
  fd.set('facebook', 'https://www.facebook.com/new-fixture');
  fd.set('x', 'x.com/no-scheme');
  return fd;
};

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.revalidateTag.mockReset();
  db = newAdminWorld();
  db.seed('app_settings', [{ key: 'social_links', value: STORED, updated_by: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe(`${ID} saveSocialLinksAction`, () => {
  it(`${ID} a super admin replaces the links; the unpublishable one is reported, the old set is audited`, async () => {
    signInAs({ kind: 'super_admin' });
    const result = await saveSocialLinksAction(form(socialLinksRevision(STORED)));
    expect(result).toEqual(expect.objectContaining({ ok: true, saved: { facebook: 'https://www.facebook.com/new-fixture' }, rejected: ['x'] }));
    expect(db.table('app_settings')).toEqual([expect.objectContaining({
      key: 'social_links', value: { facebook: 'https://www.facebook.com/new-fixture' }, updated_by: SUPER_ADMIN.id,
    })]);
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({
      family_id: null, actor_id: SUPER_ADMIN.id, action: 'update', resource: 'app_settings',
      metadata: expect.objectContaining({ key: 'social_links', previous: STORED, via: 'site_admin' }),
    })]);
    expect(h.revalidateTag).toHaveBeenCalledTimes(1);
  });

  it(`${ID} a super admin's form built on another revision is refused and nothing is written`, async () => {
    signInAs({ kind: 'super_admin' });
    const before = snapshot(db);
    expect(await saveSocialLinksAction(form(socialLinksRevision({})))).toEqual({
      ok: false, error: 'actions.socialLinksChangedSinceThisPageLoaded', mustReload: true,
    });
    expect(snapshot(db)).toEqual(before);
  });

  it.each(REFUSED_CALLERS)(`${ID} $label is refused and nothing is written`, async ({ caller }) => {
    signInAs(caller);
    const before = snapshot(db);
    expect(await saveSocialLinksAction(form(socialLinksRevision(STORED)))).toEqual({ ok: false, error: 'actions.forbidden' });
    expect(snapshot(db)).toEqual(before);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });
});
