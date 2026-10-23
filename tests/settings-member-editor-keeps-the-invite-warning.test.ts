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
// Driven through the real SettingsModule on hook slots.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, form, nodes, render, settle, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const actions = vi.hoisted(() => ({ update: vi.fn(), remove: vi.fn() }));
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

const { SettingsModule } = await import('@/components/modules/settings-module');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000002';
const DAD = { id: 'dad', family_id: FAMILY, user_id: 'u-dad', role: 'parent', is_active: true, display_name: 'Dad', color: null, birthday: null, updated_at: '2026-10-01T00:00:00.000Z' };
const MUM = { id: 'mum', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Mum', color: null, birthday: null, updated_at: '2026-10-01T00:00:00.000Z' };
const WARNING = translate(SOURCE_MESSAGES, 'familyModule.roleChangedButInviteStillOpen');
const UPDATED = translate(SOURCE_MESSAGES, 'settingsModule.memberUpdated');
let reload: ReturnType<typeof vi.fn>;

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
  h.db = createInMemorySupabase();
  h.toasts = { success: [], error: [] };
  actions.update.mockReset();
  Object.assign(h.app, {
    familyId: FAMILY, userId: 'user-1', role: 'parent', userEmail: 'mum@example.test', defaultDashboard: 'personal',
    family: { id: FAMILY, name: 'Fixture family' }, members: [DAD, MUM],
  });
  reload = vi.fn();
  vi.stubGlobal('window', { location: { hash: '#members', reload }, history: { replaceState: () => {} } });
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
