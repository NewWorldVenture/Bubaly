// A4 (the invite half) — the invite form wrote an invite to any address, a kid
// login's synthetic child.<username>@kids.bubaly.app included, and the invite
// email went to a domain Bubaly does not hold. The form refuses one before the
// invite row is written. Driven through the real InviteForm on hook slots.
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { form, render, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);

const { InviteForm } = await import('@/components/family/invite-form');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
let db: ReturnType<typeof createInMemorySupabase>;
let sent: boolean[];
const screen = () => render(h.hooks, createElement(InviteForm, { familyId: FAMILY, userId: 'user-1', onSent: (emailed: boolean) => sent.push(emailed), onCancel: () => {} }));

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.toasts = { success: [], error: [] };
  sent = [];
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1', role: 'parent' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

describe('the invite form', () => {
  it('refuses a kid login\'s address, in any case, and writes no invite', async () => {
    await submit(form(screen()), { email: 'Child.Ella@Kids.Bubaly.App' });
    expect(db.table('invites')).toEqual([]);
    expect(h.toasts.error).toEqual(['A kid login can’t be invited. Add the child from Kid Logins instead.']);
    expect(sent).toEqual([]);
  });

  it('still invites an ordinary address (control)', async () => {
    await submit(form(screen()), { email: 'gran@example.test' });
    expect(db.table('invites')).toEqual([expect.objectContaining({ family_id: FAMILY, email: 'gran@example.test' })]);
    expect(sent).toEqual([true]);
  });
});
