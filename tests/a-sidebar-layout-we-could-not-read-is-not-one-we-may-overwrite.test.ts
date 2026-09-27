// The left rail seeds from a localStorage CACHE, and on a cold cache that seed
// is DEFAULT_SIDEBAR_NAV_KEYS — which looks exactly like "this member never
// customized anything". saveSidebarNavAction replaces
// user_preferences.notification_prefs.sidebarNav wholesale, so if the rail lets
// a member pin something while the authoritative read has FAILED (or has not
// come back yet), the plan defaults plus that one pin become their saved layout
// on every device. The member's ~30 pins are gone, and nothing said a word.
//
// These tests hold the code to the member's outcome: on a failed or pending
// read, the star click reaches no server at all and the member is told — while a
// successful read leaves pinning working exactly as before.

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeTierSidebar } from '@/components/app/free-tier-sidebar';
import { DEFAULT_SIDEBAR_NAV_KEYS } from '@/lib/constants/navigation';
import { SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_CHILDREN_STORAGE_KEY } from '@/lib/navigation/customize';

// Exercise the real component handlers and rendered controls with simulated
// React hooks and browser storage; this is not a browser/DOM test.
const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[],
  load: vi.fn(), save: vi.fn(), success: vi.fn(), error: vi.fn(), dispatch: vi.fn() }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (fn: unknown) => fn,
  useId: () => 'test-sidebar',
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [mocks.slots[index], (value: unknown) => { mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value; }];
  },
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = mocks.cursor++;
    const previous = mocks.slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) mocks.effects.push(effect);
    mocks.slots[index] = deps;
  },
}));
vi.mock('@/app/(app)/dashboard/navigation-actions', () => ({ loadSidebarPrefs: mocks.load, saveSidebarNavAction: mocks.save }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, vars?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, vars) };
});
// The unread-badge subscription is not under test; keep it inert.
vi.mock('@/lib/supabase/client', () => {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'neq', 'not']) query[method] = () => query;
  query.then = (resolve: (value: unknown) => unknown) => resolve({ count: 0 });
  const channel: Record<string, unknown> = {};
  channel.on = () => channel;
  channel.subscribe = () => channel;
  return { createClient: () => ({ from: () => query, channel: () => channel, removeChannel: () => undefined }) };
});
vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'fam-1', userId: 'user-1', unreadMessages: 0, role: 'parent', isSuperAdmin: false, planLevel: 2, featureTiers: {} }),
}));
vi.mock('@/components/services/service-tooltip', () => ({
  ServiceTooltip: () => null,
  useServiceDescriptions: () => ({}),
}));
vi.mock('@/components/app/nav-shared', async (original) => ({
  ...await original<typeof import('@/components/app/nav-shared')>(),
  NavEntry: () => null,
  AiAssistantNavButton: () => null,
}));
vi.mock('@/components/app/sidebar-account', () => ({ SidebarAccount: () => null }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render() {
  mocks.cursor = 0;
  const tree = FreeTierSidebar({ onLocked: () => undefined });
  mocks.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function find(tree: ReactNode, label: string) {
  return nodes(tree).find((node) => typeof node.props.onClick === 'function' &&
    (node.props['aria-label'] === label || textOf(node.props.children as ReactNode).trim() === label));
}
function button(tree: ReactNode, label: string) {
  const result = find(tree, label);
  if (!result) throw new Error(`Missing control: ${label}`);
  return result;
}
function alerts(tree: ReactNode): string[] {
  return nodes(tree).filter((node) => node.props.role === 'alert').map((node) => textOf(node.props.children as ReactNode));
}

/** Open "All Services" and render the launcher's own contents. */
function allServices(tree: ReactNode) {
  (button(tree, 'All Services').props.onClick as () => void)();
  const opened = render();
  const modal = nodes(opened).find((node) => typeof node.props.onTogglePin === 'function');
  if (!modal) throw new Error('All Services launcher not found');
  if (modal.props.open !== true) throw new Error('All Services launcher did not open');
  return { rail: opened, modal, body: (modal.type as (props: unknown) => ReactNode)(modal.props) };
}
function clickStar(body: ReactNode, label: string) {
  const star = button(body, `Pin ${label} to sidebar`);
  (star.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation: () => undefined });
  return star;
}

// A Family+ service the member pinned from "All Services"; not in the plan default.
const PAID_CFO = '/dashboard/family-cfo';
// What this member actually saved: a rail trimmed down to three destinations.
const REAL_LAYOUT = ['/dashboard/meals', '/dashboard/calendar', '/home'];

let storage: Map<string, string>;
beforeEach(() => {
  mocks.slots = []; mocks.cursor = 0; mocks.effects = [];
  mocks.load.mockReset();
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.success.mockReset(); mocks.error.mockReset(); mocks.dispatch.mockReset();
  storage = new Map(); // cold cache: a new laptop, a private window, cleared site data
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    dispatchEvent: mocks.dispatch,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public options: unknown) {} });
});
afterEach(() => vi.unstubAllGlobals());
async function mounted() { render(); await Promise.resolve(); return render(); }

describe('a sidebar layout we could not read is not one we may overwrite', () => {
  it('pins nothing and says so when the preference read failed and the cache is cold', async () => {
    mocks.load.mockResolvedValue({ nav: null, children: null, error: 'Your navigation could not be loaded or saved. Please try again.' });
    const tree = await mounted();

    // The failure is on screen rather than passing for "nothing saved".
    expect(alerts(tree).join(' ')).toContain('could not be loaded');

    const { modal, body } = allServices(tree);
    expect(clickStar(body, 'Family CFO').props.disabled).toBe(true);
    expect(button(body, 'Pin all in my plan').props.disabled).toBe(true);
    expect(modal.props.busy).toBe(true);

    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    // The member's real saved layout is untouched: nothing reached the server…
    expect(mocks.save).not.toHaveBeenCalled();
    // …and the defaults-derived list was not cached as if it were theirs either.
    expect(storage.has(SIDEBAR_NAV_STORAGE_KEY)).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('pins nothing while the read is still in flight, so a fast click cannot win the race', async () => {
    mocks.load.mockReturnValue(new Promise(() => undefined)); // never settles
    const { body } = allServices(await mounted());

    clickStar(body, 'Family CFO');
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(mocks.save).not.toHaveBeenCalled();
    expect(storage.has(SIDEBAR_NAV_STORAGE_KEY)).toBe(false);
  });

  it('refuses the Reset button too, rather than writing over a layout it only has cached', async () => {
    // Warm cache, failed read: the rail shows the member's real three pins, but
    // nothing has confirmed them, and a reset would replace the stored layout AND
    // wipe every group's sub-page order (children: {}).
    storage.set(SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(REAL_LAYOUT));
    mocks.load.mockResolvedValue({ nav: null, children: null, error: 'unavailable' });
    const { body } = allServices(await mounted());

    const reset = button(body, 'Reset');
    expect(reset.props.disabled).toBe(true);
    await (reset.props.onClick as () => Promise<void>)();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(SIDEBAR_NAV_STORAGE_KEY)!)).toEqual(REAL_LAYOUT);
    expect(storage.has(SIDEBAR_NAV_CHILDREN_STORAGE_KEY)).toBe(false);
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('still pins onto the real layout once the read has landed', async () => {
    mocks.load.mockResolvedValue({ nav: REAL_LAYOUT, children: null });
    const tree = await mounted();
    expect(alerts(tree)).toEqual([]);

    const { modal, body } = allServices(tree);
    expect(modal.props.busy).toBe(false);
    expect(clickStar(body, 'Family CFO').props.disabled).toBe(false);

    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({ keys: [...REAL_LAYOUT, PAID_CFO] });
    expect(mocks.save.mock.calls[0][0].keys).not.toEqual(expect.arrayContaining([DEFAULT_SIDEBAR_NAV_KEYS[2]]));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('reads again on Refresh, and once that read lands pins onto the real layout', async () => {
    mocks.load
      .mockResolvedValueOnce({ nav: null, children: null, error: 'unavailable' })
      .mockResolvedValueOnce({ nav: REAL_LAYOUT, children: null });
    const failed = await mounted();
    expect(alerts(failed).join(' ')).toContain('could not be loaded');

    (button(failed, 'Refresh this page').props.onClick as () => void)();
    render(); await Promise.resolve();
    const tree = render();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(alerts(tree)).toEqual([]);

    const { modal, body } = allServices(tree);
    expect(modal.props.busy).toBe(false);
    clickStar(body, 'Family CFO');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({ keys: [...REAL_LAYOUT, PAID_CFO] });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('treats a clean read with nothing saved as authoritative and writable', async () => {
    mocks.load.mockResolvedValue({ nav: null, children: null });
    const { body } = allServices(await mounted());

    clickStar(body, 'Family CFO');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({ keys: [...DEFAULT_SIDEBAR_NAV_KEYS, PAID_CFO] });
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
