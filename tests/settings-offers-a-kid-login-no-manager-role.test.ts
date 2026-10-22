// A7 (the screen half) — Settings' member editor offered Parent and Adult to a
// member who signs in with a kid PIN, and wrote the role from the browser.
//
// The family page's editor narrows the roles with rolesForAKidLogin; Settings
// rendered all of ROLE_ORDER. It now offers the same set (the actor's own rank,
// and never a manager for a kid login), refuses a role outside it before any
// write, and saves through updateFamilyMemberAction with the version it opened.
//
// Driven through the real SettingsModule on hook slots.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, form, nodes, render, settle, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const ELLA = { id: 'ella', family_id: FAMILY, user_id: 'u-ella', role: 'child', is_active: true, display_name: 'Ella', color: null, birthday: '2016-05-01', updated_at: '2026-10-01T00:00:00.000Z' };
const NAN = { id: 'nan', family_id: FAMILY, user_id: 'u-nan', role: 'caregiver', is_active: true, display_name: 'Nan', color: null, birthday: null, updated_at: '2026-10-01T00:00:00.000Z' };
const MUM = { id: 'mum', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Mum', color: null, birthday: null, updated_at: '2026-10-01T00:00:00.000Z' };
let db: ReturnType<typeof createInMemorySupabase>;

const screen = () => render(h.hooks, createElement(SettingsModule));
async function openEditor(index: number) {
  screen();
  await settle();
  await click(allByName(screen(), 'Edit member')[index]);
  screen();
  await settle();
  return screen();
}
const offered = (tree: ReactNode) => nodes(form(tree)).filter((n) => n.type === 'option').map((n) => n.props.value);

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.toasts = { success: [], error: [] };
  actions.update.mockReset().mockResolvedValue({ ok: true });
  Object.assign(h.app, {
    familyId: FAMILY, userId: 'user-1', role: 'parent', userEmail: 'mum@example.test', defaultDashboard: 'personal',
    family: { id: FAMILY, name: 'Fixture family' }, members: [ELLA, NAN, MUM],
  });
  db.seed('child_logins', [{ id: 'cl-ella', family_id: FAMILY, member_id: 'ella', user_id: 'u-ella', username: 'ella' }]);
  vi.stubGlobal('window', { location: { hash: '#members', reload: vi.fn() }, history: { replaceState: () => {} } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Settings member editor', () => {
  it('offers a kid login no parent or adult role', async () => {
    const tree = await openEditor(0);
    expect(offered(tree)).toEqual(['teen', 'child', 'caregiver', 'guest']);
  });

  it('refuses a manager role for a kid login before anything is written', async () => {
    db.seed('family_members', [ELLA, NAN, MUM]);
    const tree = await openEditor(0);
    await submit(form(tree), { role: 'adult' });
    expect(actions.update).not.toHaveBeenCalled();
    expect(db.table('family_members').find((m) => m.id === 'ella')).toMatchObject({ role: 'child', updated_at: ELLA.updated_at });
    expect(h.toasts.error).toEqual(['That change wasn\'t saved — you may not have permission. Refresh and try again.']);
    expect(h.toasts.success).toEqual([]);
  });

  it('saves an allowed change through the server action, with the version it opened', async () => {
    const tree = await openEditor(0);
    await submit(form(tree), { role: 'teen' });
    expect(actions.update).toHaveBeenCalledWith({
      memberId: 'ella', expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
      changes: { display_name: 'Ella', role: 'teen', birthday: '2016-05-01' },
    });
  });

  it('still offers every role for an ordinary account to a parent (control)', async () => {
    const tree = await openEditor(1);
    expect(offered(tree)).toEqual(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest']);
  });

  it('shows the server\'s refusal, such as a member removed meanwhile', async () => {
    actions.update.mockResolvedValue({ ok: false, error: 'That member was removed from the family, so the change was not saved.' });
    const tree = await openEditor(1);
    await submit(form(tree));
    expect(h.toasts.error).toEqual(['That member was removed from the family, so the change was not saved.']);
    expect(h.toasts.success).toEqual([]);
  });
});
