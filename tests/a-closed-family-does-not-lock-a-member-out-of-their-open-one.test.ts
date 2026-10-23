// Closing one family does not lock a member out of their other, open families.
//
// GatedShell (app/(app)/layout.tsx) resolves ONE family — the stored preference,
// else the earliest membership (chooseActiveMembership never looks at
// closed_at) — and when that family is closed it replaces every (app) route
// with <AccountClosedGate />. The gate offered "Reopen my account", which the
// action refuses for a non-parent, and "Log out". The family switcher that
// calls setActiveFamilyAction lives in AppShell, rendered by the section
// layouts BELOW the gate. So a caregiver, guest or adult in two households,
// whose active one a parent closed, lost the open household too until the
// closed one reopened or removed them.
//
// The layout now hands the gate the member's other OPEN families and whether
// they may reopen; the gate offers a switch into each, and tells a non-parent
// to ask a parent rather than fail after the click. Driven through the REAL
// layout against the in-memory database, and the REAL gate through the harness.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const state = vi.hoisted(() => ({ db: null as unknown, setActiveFamily: vi.fn(), assign: vi.fn() }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => ({
  ...(await import('./helpers/module-harness')).localeProviderModule(h),
  FamilyTimeZoneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/auth/sign-out-form', () => ({
  SignOutForm: ({ children }: { children: (s: { signingOut: boolean }) => unknown }) => children({ signingOut: false }),
}));
vi.mock('@/app/(app)/account/actions', () => ({ reopenAccountAction: async () => { throw new Error('not under test'); } }));
vi.mock('@/app/(app)/actions', () => ({ setActiveFamilyAction: (id: string) => state.setActiveFamily(id) }));

// The layout's surroundings. The gate is a MARKER here so the layout's own
// decision — which props it hands the gate — can be read off the tree; the real
// gate is imported with importActual below.
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false }));
vi.mock('@/lib/server/family-time-zone', () => ({ activeFamilyTimeZone: async () => 'UTC' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/i18n/scoped-locale-provider', () => ({ ScopedLocaleProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/confirm', () => ({ ConfirmProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/auth/session-keeper', () => ({ SessionKeeper: () => null }));
vi.mock('@/components/app/app-lock-gate', () => ({ AppLockGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/app/trial-paywall-gate', () => ({ TrialPaywallGate: (props: object) => createElement('paywall-gate', props) }));
vi.mock('@/components/app/account-closed-gate', () => ({ AccountClosedGate: (props: object) => createElement('closed-gate', props) }));

const { default: AppGroupLayout } = await import('@/app/(app)/layout');
const { AccountClosedGate } = await vi.importActual<typeof import('@/components/app/account-closed-gate')>('@/components/app/account-closed-gate');

const CLOSED = '00000000-0000-4000-8000-00000000c105';
const OPEN = '00000000-0000-4000-8000-00000000a0e1';
const CARER = 'user-carer';
const PARENT = 'user-parent';

type Db = ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let db: Db;

function household(userId: string) {
  db = createInMemorySupabase<SupabaseClient<Database>>({ userId });
  db.seed('families', [
    { id: CLOSED, name: 'Closed House', timezone: 'UTC', trial_ends_at: null, closed_at: '2026-10-01T09:00:00Z' },
    { id: OPEN, name: 'Open House', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('family_members', [
    // The carer joined the closed house first, so with no stored preference it
    // is the family the gate judges.
    { id: 'm-carer-closed', family_id: CLOSED, user_id: CARER, role: 'caregiver', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'm-carer-open', family_id: OPEN, user_id: CARER, role: 'caregiver', is_active: true, created_at: '2026-06-01T00:00:00Z' },
    { id: 'm-parent-closed', family_id: CLOSED, user_id: PARENT, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
  ]);
  state.db = db;
  return db;
}

/** Call every function component — the async server ones included — until only host elements remain. */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === 'function') return resolveTree(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props));
  const { children, ...rest } = props;
  if (children === undefined) return node;
  return createElement(type as string, rest, await resolveTree(children as ReactNode));
}

function find(tree: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(tree)) { for (const child of tree) { const hit = find(child, type); if (hit) return hit; } return null; }
  if (!isValidElement<Record<string, unknown>>(tree)) return null;
  if (tree.type === type) return tree;
  return find(tree.props.children as ReactNode, type);
}

const layout = async () => resolveTree(await AppGroupLayout({ children: 'THE-APP' }));

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  state.setActiveFamily.mockReset().mockResolvedValue({ ok: true });
  state.assign.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { location: { assign: state.assign, reload: vi.fn(), pathname: '/home', search: '' }, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the (app) layout, for a caregiver whose active family closed', () => {
  it('shows the closed gate instead of the app, naming their open family and withholding a reopen they cannot make', async () => {
    household(CARER);
    const tree = await layout();
    const gate = find(tree, 'closed-gate');
    expect(gate, 'the gate replaces the app').not.toBeNull();
    expect(has(tree, 'THE-APP')).toBe(false);
    expect(gate!.props).toMatchObject({ canReopen: false, otherFamilies: [{ id: OPEN, name: 'Open House' }] });
  });

  it('a parent of the closed family, with no other family, keeps the reopen and is offered nothing else', async () => {
    household(PARENT);
    const gate = find(await layout(), 'closed-gate');
    expect(gate!.props).toMatchObject({ canReopen: true, otherFamilies: [] });
  });

  it('once the preference names the open family, the app renders and no gate does (control)', async () => {
    household(CARER);
    db.seed('user_preferences', [{ user_id: CARER, active_family_id: OPEN }]);
    const tree = await layout();
    expect(find(tree, 'closed-gate')).toBeNull();
    expect(has(tree, 'THE-APP')).toBe(true);
  });

  it('a closed family that is the only one still names nothing to switch to', async () => {
    household(CARER);
    db.table('families').find((f) => f.id === OPEN)!.closed_at = '2026-10-02T09:00:00Z';
    const gate = find(await layout(), 'closed-gate');
    expect(gate!.props).toMatchObject({ canReopen: false, otherFamilies: [] });
  });
});

describe('the gate itself (the harness translates through the real en-US catalogue)', () => {
  it('offers a switch into each open family, and takes the member there', async () => {
    const tree = render(h.hooks, createElement(AccountClosedGate, { canReopen: false, otherFamilies: [{ id: OPEN, name: 'Open House' }] }));
    expect(has(tree, 'Your other families are still open:')).toBe(true);
    // No reopen for a non-parent — the action would only refuse — but a reason.
    expect(allByName(tree, 'Reopen my account')).toHaveLength(0);
    expect(has(tree, 'Only a parent can reopen this account. Ask a parent to reopen it.')).toBe(true);

    await click(byName(tree, 'Switch to Open House'));
    expect(state.setActiveFamily).toHaveBeenCalledWith(OPEN);
    expect(state.assign).toHaveBeenCalledWith('/home');
    expect(h.toasts.error).toEqual([]);
  });

  it('a switch the server refused is said, and nobody is sent anywhere', async () => {
    state.setActiveFamily.mockResolvedValue({ ok: false, error: 'You are not a member of that family.' });
    const tree = render(h.hooks, createElement(AccountClosedGate, { canReopen: false, otherFamilies: [{ id: OPEN, name: 'Open House' }] }));
    await click(byName(tree, 'Switch to Open House'));
    expect(state.assign).not.toHaveBeenCalled();
    expect(h.toasts.error).toEqual(['You are not a member of that family.']);
  });

  it('a parent keeps the reopen button, and with no other family sees no switch', () => {
    const tree = render(h.hooks, createElement(AccountClosedGate, { canReopen: true, otherFamilies: [] }));
    expect(allByName(tree, 'Reopen my account')).toHaveLength(1);
    expect(has(tree, 'Your other families are still open:')).toBe(false);
    expect(allByName(tree, /^Switch to /)).toHaveLength(0);
  });
});
