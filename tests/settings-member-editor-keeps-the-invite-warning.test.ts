// The Settings member editor keeps the "invite still open" warning on screen
// (N3-S1).
//
// updateFamilyMemberAction revokes the invites a demoted manager sent at a role
// they can no longer give, and answers `invitesRevoked: false` when it could
// not. EditMemberModal showed that warning and then called
// `window.location.reload()` on the next line; a toast lives in React state
// (components/ui/toast.tsx), so the reload cleared it at once and nobody read
// it. It now does what removeMember on the same screen does: the warning is
// said, the editor closes, and there is no reload.
//
// N3-S1-stale-roster: that reload was also the only thing that refreshed the
// roster here (family_members has no realtime publication), so after the
// warning Dad's row still said Parent, and a second edit sent his old
// updated_at and was refused as "changed meanwhile" until a manual reload.
// removeMember's three warnings left the removed member listed the same way.
// Each warning now re-reads the roster (useApp().refreshMembers), as the
// family page's editor does after a save.
//
// Driven through the real SettingsModule on hook slots; the roster cases also
// through the REAL member actions against the in-memory database, with only
// the follow-up whose failure a warning reports stood in for.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, form, nodes, render, settle, submit, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const actions = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn() }));
/** The removal and demotion follow-ups whose failure each warning reports. */
const followUps = vi.hoisted(() => ({ login: vi.fn(), location: vi.fn(), invitesToThem: vi.fn(), invitesTheyIssued: vi.fn() }));
const Stub = () => null;

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtMoney: () => '$0' }) }));
for (const path of ['@/components/ui/button', '@/components/ui/modal', '@/components/ui/input', '@/components/ui/badge', '@/components/ui/avatar', '@/components/app/page-header', '@/components/ai/ai-insight']) {
  vi.doMock(path, async () => (await import('./helpers/module-harness')).ui);
}
vi.mock('@/components/ui/card', () => ({ Card: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('@/components/ui/avatar-picker', () => ({ AvatarPicker: Stub }));
vi.mock('@/components/ui/phone-input', () => ({ PhoneInput: Stub }));
vi.mock('@/components/settings/ai-settings', () => ({ AISettingsPanel: Stub }));
vi.mock('@/components/dashboard/calendar-sync-panel', () => ({ CalendarSyncPanel: Stub }));
vi.mock('@/components/settings/app-lock-settings', () => ({ AppLockSettings: Stub }));
vi.mock('@/components/settings/security-panel', () => ({ SecurityPanel: Stub }));
vi.mock('@/components/settings/privacy-center', () => ({ PrivacyCenter: Stub }));
vi.mock('@/components/settings/navigation-choices', () => ({ NavigationChoices: Stub }));
vi.mock('@/components/settings/notification-email-preference', () => ({ NotificationEmailPreference: Stub }));
vi.mock('@/components/family/invite-form', () => ({ InviteForm: Stub }));
vi.mock('@/components/family/pending-invites', () => ({ PendingInvites: Stub }));
vi.mock('@/app/(app)/actions', () => ({ setDefaultDashboardAction: vi.fn(), updateMyProfileAction: vi.fn() }));
vi.mock('@/app/(app)/family/member-actions', () => ({ updateFamilyMemberAction: actions.update, removeFamilyMemberAction: actions.remove }));
// What the real member actions run on: Mum's session and the service role, both
// the in-memory database, and the real catalogue.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, memberships: [], active: { familyId: h.app.familyId, role: 'parent', member: { id: 'mum' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: lookup } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => lookup(messages, key, params) };
});
vi.mock('@/lib/server/member-invites', () => ({ closePendingInvitesFor: followUps.invitesToThem, revokeInvitesIssuedBy: followUps.invitesTheyIssued }));
vi.mock('@/lib/location/retention', () => ({ forgetMemberLocation: followUps.location }));
vi.mock('@/lib/server/child-account', async (original) => ({ ...await original<object>(), revokeRemovedChildLogin: followUps.login }));

const { SettingsModule } = await import('@/components/modules/settings-module');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000002';
const DAD = { id: 'dad', family_id: FAMILY, user_id: 'u-dad', role: 'parent', is_active: true, display_name: 'Dad', color: null, birthday: null, email: null, phone: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' };
const MUM = { id: 'mum', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Mum', color: null, birthday: null, email: null, phone: null, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' };
const WARNING = translate(SOURCE_MESSAGES, 'familyModule.roleChangedButInviteStillOpen');
const UPDATED = translate(SOURCE_MESSAGES, 'settingsModule.memberUpdated');
const CHANGED_MEANWHILE = translate(SOURCE_MESSAGES, 'familyModule.thatMemberChangedMeanwhile');
const PARENT = translate(SOURCE_MESSAGES, 'trustRole.parent');
const ADULT = translate(SOURCE_MESSAGES, 'trustRole.adult');
let reload: ReturnType<typeof vi.fn>;

/**
 * The 0003 `set_updated_at` trigger: every write to a member row moves its
 * updated_at, which updateFamilyMemberAction compares with the one the editor
 * opened. The in-memory store applies only the patch, so it is modelled here.
 */
function withUpdatedAtTrigger(db: InMemorySupabase): InMemorySupabase {
  const from = db.from.bind(db);
  let tick = 0;
  db.from = ((table: string) => {
    const builder = from(table);
    if (table === 'family_members') {
      const update = builder.update.bind(builder);
      builder.update = ((patch: Record<string, unknown>, opts?: { count?: 'exact' }) =>
        update({ ...patch, updated_at: `2026-10-23T00:00:${String(++tick).padStart(2, '0')}.000Z` }, opts)) as never;
    }
    return builder;
  }) as typeof db.from;
  return db;
}
const stored = (id: string) => (h.db as InMemorySupabase).table('family_members').find((m) => m.id === id)!;
/** What the Members list shows: one line per member, name and role. */
const roster = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'li').map((n) => text(n));
async function throughTheRealActions() {
  const real = await vi.importActual<typeof import('@/app/(app)/family/member-actions')>('@/app/(app)/family/member-actions');
  actions.update.mockImplementation(real.updateFamilyMemberAction);
  actions.remove.mockImplementation(real.removeFamilyMemberAction);
}

const screen = () => render(h.hooks, createElement(SettingsModule));
const editorOpen = (tree: ReactNode) => nodes(tree).some((n) => n.props.role === 'dialog');
async function demoteDad() {
  screen();
  await settle();
  await click(allByName(screen(), 'Edit member')[0]);
  screen();
  await settle();
  await submit(form(screen()), { role: 'adult' });
  return screen();
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  const db = withUpdatedAtTrigger(createInMemorySupabase());
  db.seed('family_members', [{ ...DAD }, { ...MUM }]);
  Object.assign(db.auth, {
    admin: { getUserById: async (id: string) => ({ data: { user: { id, email: `${id}@example.test`, user_metadata: {} } }, error: null }) },
  });
  h.db = db;
  h.toasts = { success: [], error: [] };
  actions.update.mockReset();
  actions.remove.mockReset();
  // Every follow-up lands unless a case says otherwise.
  followUps.login.mockReset().mockResolvedValue('none');
  followUps.location.mockReset().mockResolvedValue({ ok: true });
  followUps.invitesToThem.mockReset().mockResolvedValue(true);
  followUps.invitesTheyIssued.mockReset().mockResolvedValue(true);
  Object.assign(h.app, {
    familyId: FAMILY, userId: 'user-1', role: 'parent', userEmail: 'mum@example.test', defaultDashboard: 'personal',
    family: { id: FAMILY, name: 'Fixture family' }, members: [{ ...DAD }, { ...MUM }],
    // What AppProvider's refreshMembers does (components/app/app-context.tsx):
    // re-read the family's active roster and put it on screen.
    refreshMembers: async () => {
      const { data } = await (h.db as InMemorySupabase).from('family_members').select('*')
        .eq('family_id', FAMILY).eq('is_active', true).order('created_at');
      if (data) h.app.members = data as typeof h.app.members;
    },
  });
  reload = vi.fn();
  vi.stubGlobal('window', { location: { hash: '#members', reload }, history: { replaceState: () => {} } });
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Settings member editor, after a demotion whose open invite could not be revoked', () => {
  it('shows the warning, closes the editor, and does not reload it away', async () => {
    actions.update.mockResolvedValue({ ok: true, invitesRevoked: false });
    const tree = await demoteDad();
    expect(actions.update).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'dad', changes: expect.objectContaining({ role: 'adult' }) }));
    expect(WARNING).toMatch(/^Role changed, but an invite/);
    expect(h.toasts.error).toEqual([WARNING]);
    expect(h.toasts.success).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(editorOpen(tree)).toBe(false);
  });

  it('still says "Member updated" and reloads when the invites were revoked (control)', async () => {
    actions.update.mockResolvedValue({ ok: true, invitesRevoked: true });
    const tree = await demoteDad();
    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([UPDATED]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(editorOpen(tree)).toBe(false);
  });
});

describe('the Members list after a warning (N3-S1-stale-roster)', () => {
  it('shows the new role after the demotion warning, and a second edit of the same member is accepted', async () => {
    await throughTheRealActions();
    followUps.invitesTheyIssued.mockResolvedValueOnce(false);
    expect(roster(screen()).find((line) => line.includes('Dad'))).toContain(PARENT);

    const tree = await demoteDad();
    expect(stored('dad').role).toBe('adult');
    expect(h.toasts.error).toEqual([WARNING]);
    expect(reload).not.toHaveBeenCalled();
    const dad = roster(tree).find((line) => line.includes('Dad'));
    expect(dad).toContain(ADULT);
    expect(dad).not.toContain(PARENT);

    // Reopened from the refreshed row, the editor carries the row's new
    // updated_at, so the server takes the edit rather than calling it stale.
    await click(allByName(screen(), 'Edit member')[0]);
    screen();
    await settle();
    await submit(form(screen()), { display_name: 'Dad R' });
    expect(h.toasts.error).not.toContain(CHANGED_MEANWHILE);
    expect(h.toasts.error).toEqual([WARNING]);
    expect(h.toasts.success).toEqual([UPDATED]);
    expect(stored('dad')).toMatchObject({ display_name: 'Dad R', role: 'adult' });
  });

  it.each([
    ['their kid login could not be switched off', 'familyModule.removedButLoginStillActive', () => followUps.login.mockResolvedValue('failed')],
    ['their last position could not be cleared', 'familyModule.removedButLocationStillVisible', () => followUps.location.mockResolvedValue({ ok: false, failures: [] })],
    ['an invite to them could not be revoked', 'familyModule.removedButInviteStillOpen', () => followUps.invitesToThem.mockResolvedValue(false)],
  ])('no longer lists a removed member when %s', async (_case, warningKey, fail) => {
    await throughTheRealActions();
    fail();
    screen();
    await settle();
    await click(allByName(screen(), 'Remove member')[0]);
    const tree = screen();
    expect(stored('dad').is_active).toBe(false);
    expect(h.toasts.error).toEqual([translate(SOURCE_MESSAGES, warningKey)]);
    expect(reload).not.toHaveBeenCalled();
    expect(roster(tree).some((line) => line.includes('Dad'))).toBe(false);
    expect(roster(tree).some((line) => line.includes('Mum'))).toBe(true);
  });
});
