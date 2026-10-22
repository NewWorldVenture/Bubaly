// A1 (the wiring) — nothing checked that Settings shows Pending invites.
//
// The revoke list is its own component (components/family/pending-invites.tsx)
// and is tested on its own, so taking it out of Settings > Members broke no
// test, and a household would be back to having no way to cancel an invite.
// Here the real SettingsModule renders the real PendingInvites, against the
// in-memory database, on hook slots.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const Stub = () => null;

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtMoney: () => '$0', fmtDate: (iso: string) => iso.slice(0, 10) }) }));
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
vi.mock('@/app/(app)/actions', () => ({ setDefaultDashboardAction: vi.fn(), updateMyProfileAction: vi.fn() }));
vi.mock('@/app/(app)/family/member-actions', () => ({ updateFamilyMemberAction: vi.fn(), removeFamilyMemberAction: vi.fn() }));

const { SettingsModule } = await import('@/components/modules/settings-module');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const MUM = { id: 'mum', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Mum', color: null, birthday: null, updated_at: '2026-10-01T00:00:00.000Z' };
const ELLA = { id: 'ella', family_id: FAMILY, user_id: 'user-2', role: 'child', is_active: true, display_name: 'Ella', color: null, birthday: '2016-05-01', updated_at: '2026-10-01T00:00:00.000Z' };
const REVOKE = 'Revoke the invite for gran@example.test';

async function screen() {
  render(h.hooks, createElement(SettingsModule));
  await settle();
  render(h.hooks, createElement(SettingsModule));
  await settle();
  return render(h.hooks, createElement(SettingsModule));
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  const db = createInMemorySupabase();
  h.db = db;
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, {
    familyId: FAMILY, userId: 'user-1', role: 'parent', userEmail: 'mum@example.test', defaultDashboard: 'personal',
    family: { id: FAMILY, name: 'Fixture family' }, members: [MUM, ELLA],
  });
  db.seed('invites', [{
    id: 'i-gran', family_id: FAMILY, email: 'gran@example.test', role: 'guest', status: 'pending',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }]);
  vi.stubGlobal('window', { location: { hash: '#members', reload: vi.fn() }, history: { replaceState: () => {} } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Settings > Members', () => {
  it('shows a parent the family\'s pending invite, with a Revoke control', async () => {
    const tree = await screen();
    expect(has(tree, 'gran@example.test')).toBe(true);
    expect(allByName(tree, REVOKE)).toHaveLength(1);
  });

  it('shows a child no pending invites and no Revoke', async () => {
    Object.assign(h.app, { userId: 'user-2', role: 'child', userEmail: 'ella@example.test' });
    const tree = await screen();
    expect(has(tree, 'gran@example.test')).toBe(false);
    expect(allByName(tree, REVOKE)).toEqual([]);
  });
});
