// A1 (the household half) — nothing in the app could revoke an invite.
//
// Only the super admin console set an invite to 'revoked', so a mistaken
// invite, a resubmitted one or a second invite still held by someone the family
// removed stayed live for its full 14 days. Settings now lists the family's
// pending invites to a manager, with a Revoke that writes the one transition
// invites_update (0482) allows a manager: pending -> revoked.
//
// Driven through the real component, on hook slots, against the in-memory
// database.
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: (iso: string) => iso.slice(0, 10) }) }));
vi.mock('@/components/ui/card', () => ({ Card: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);

const { PendingInvites } = await import('@/components/family/pending-invites');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
let db: ReturnType<typeof createInMemorySupabase>;
const screen = () => render(h.hooks, createElement(PendingInvites, { familyId: FAMILY }));
const app = () => h.app as typeof h.app & { role: string };

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.toasts = { success: [], error: [] }; h.calls = []; h.fault = null;
  Object.assign(h.app, { familyId: FAMILY, role: 'parent' });
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  db.seed('invites', [
    { id: 'i-ex', family_id: FAMILY, email: 'ex@example.test', role: 'adult', status: 'pending', expires_at: soon },
    { id: 'i-gran', family_id: FAMILY, email: 'gran@example.test', role: 'guest', status: 'pending', expires_at: soon },
    { id: 'i-old', family_id: FAMILY, email: 'old@example.test', role: 'adult', status: 'accepted', expires_at: soon },
    { id: 'i-other', family_id: 'another-family', email: 'stranger@example.test', role: 'adult', status: 'pending', expires_at: soon },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a manager can revoke a pending invite', () => {
  it('lists only this family\'s pending invites, and Revoke closes the one asked for', async () => {
    let tree = screen();
    await settle();
    tree = screen();
    expect(has(tree, 'ex@example.test')).toBe(true);
    expect(has(tree, 'gran@example.test')).toBe(true);
    expect(has(tree, 'old@example.test')).toBe(false);
    expect(has(tree, 'stranger@example.test')).toBe(false);

    await click(byName(tree, 'Revoke the invite for ex@example.test'));
    expect(db.table('invites').find((i) => i.id === 'i-ex')!.status).toBe('revoked');
    expect(db.table('invites').find((i) => i.id === 'i-gran')!.status).toBe('pending');
    expect(h.toasts.success).toEqual(['The invite for ex@example.test was revoked.']);

    tree = screen();
    await settle();
    tree = screen();
    expect(has(tree, 'ex@example.test')).toBe(false);
    expect(has(tree, 'gran@example.test')).toBe(true);
  });

  it('says so when the revoke changed nothing (refused, or no longer pending)', async () => {
    screen();
    await settle();
    const tree = screen();
    db.table('invites').find((i) => i.id === 'i-ex')!.status = 'accepted';
    await click(byName(tree, 'Revoke the invite for ex@example.test'));
    expect(h.toasts.error).toEqual(["That change wasn't saved — you may not have permission. Refresh and try again."]);
    expect(h.toasts.success).toEqual([]);
    expect(db.table('invites').find((i) => i.id === 'i-ex')!.status).toBe('accepted');
  });

  it('shows a child nothing to revoke', async () => {
    app().role = 'child';
    screen();
    await settle();
    const tree = screen();
    expect(allByName(tree, /Revoke the invite/)).toEqual([]);
    expect(h.calls.filter((c) => c.table === 'invites')).toEqual([]);
  });
});
