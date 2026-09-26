// Settings › Navigation Choices edits the SAME saved layout the rail's "All
// Services" launcher pins into, and saveSidebarNavAction replaces
// user_preferences.notification_prefs.sidebarNav wholesale. So if this editor
// loads and saves a list filtered to the free-only NAV_CATALOG, one arrow-click
// deletes every higher-tier service the member pinned — silently, with the card
// still saying "Changes save automatically and sync across your devices".
//
// The outcome these tests hold the code to is the paying member's: after nudging
// Calendar up one place, Family CFO is STILL in the layout that reached the
// server, and it was visible on the screen they edited.

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationChoices } from '@/components/settings/navigation-choices';
import { ALL_SERVICES_KEYS, NAV_CATALOG_KEYS } from '@/lib/constants/navigation';
import { SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_CHILDREN_STORAGE_KEY, SIDEBAR_NAV_EVENT } from '@/lib/navigation/customize';

// Exercise the real component handlers and rendered controls with simulated
// React hooks and browser storage; this is not a browser/DOM test.
const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[],
  load: vi.fn(), save: vi.fn(), success: vi.fn(), error: vi.fn(), dispatch: vi.fn(),
  app: { role: 'parent', isSuperAdmin: false, planLevel: 2, featureTiers: {} as Record<string, string> } }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(),
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
vi.mock('@/components/app/app-context', () => ({ useApp: () => mocks.app }));

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
  const tree = NavigationChoices();
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
/** The whole text of one destination's row in the edited list. */
function rowText(tree: ReactNode, href: string): string {
  const row = nodes(tree).find((node) => node.type === 'li' && node.key === href);
  if (!row) throw new Error(`No row for ${href}`);
  return textOf(row);
}
function savedKeys(): string[] {
  const call = mocks.save.mock.calls.at(-1)?.[0] as { keys?: string[] } | undefined;
  if (!call?.keys) throw new Error('saveSidebarNavAction was not called with a key list');
  return call.keys;
}

// Two services a Family+ plan unlocks and the rail can pin, that the Settings
// picker's free-only catalog has never listed.
const PAID_CFO = '/dashboard/family-cfo';
const PAID_AUTOPILOT = '/dashboard/autopilot';

let storage: Map<string, string>;
let listeners: Map<string, (event: unknown) => void>;
function mount(nav: string[]) {
  mocks.load.mockReset().mockResolvedValue({ nav, children: {} });
  storage = new Map([[SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(nav)], [SIDEBAR_NAV_CHILDREN_STORAGE_KEY, JSON.stringify({})]]);
  listeners = new Map();
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    dispatchEvent: mocks.dispatch,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  });
}
beforeEach(() => {
  mocks.slots = []; mocks.cursor = 0; mocks.effects = [];
  mocks.app = { role: 'parent', isSuperAdmin: false, planLevel: 2, featureTiers: {} };
  mocks.load.mockReset();
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.success.mockReset(); mocks.error.mockReset(); mocks.dispatch.mockReset();
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public options: unknown) {} });
});
afterEach(() => vi.unstubAllGlobals());
async function loaded() { render(); await Promise.resolve(); return render(); }

describe('a settings edit keeps the higher-tier pins that screen cannot offer', () => {
  // A fixture guard, not the regression proof: it passes on the unfixed source
  // too. It is here so the tests below cannot go quietly vacuous — if either
  // service ever joined the free picker's catalog, the old free-only filter
  // would keep it and those tests would stop discriminating; this one fails first.
  it('fixture guard: the paid services live in the pin catalog and not the settings picker', () => {
    for (const href of [PAID_CFO, PAID_AUTOPILOT]) {
      expect(ALL_SERVICES_KEYS).toContain(href);
      expect(NAV_CATALOG_KEYS).not.toContain(href);
    }
  });

  it('still sends Family CFO to the server after the member nudges Calendar up one place', async () => {
    mount(['/home', '/dashboard/calendar', PAID_CFO]);
    const tree = await loaded();

    // The member can see what they pinned, so a removal is a decision and not an
    // accident: the paid row is on the screen with its own controls.
    expect(find(tree, 'Remove Family CFO')).toBeDefined();

    (button(tree, 'Move Calendar up').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    expect(savedKeys()).toEqual(['/dashboard/calendar', '/home', PAID_CFO]);
    expect(JSON.parse(storage.get(SIDEBAR_NAV_STORAGE_KEY)!)).toContain(PAID_CFO);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('keeps an all-paid layout instead of replacing it with the stock free default', async () => {
    mount([PAID_AUTOPILOT, PAID_CFO]);
    const tree = await loaded();

    (button(tree, 'Move Family CFO up').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    expect(savedKeys()).toEqual([PAID_CFO, PAID_AUTOPILOT]);
    expect(savedKeys()).not.toContain('/dashboard/todos'); // a stock default the member never pinned
  });

  it('removes a paid pin only when the member clicks that pin\'s own remove control', async () => {
    mount(['/home', PAID_CFO]);
    const tree = await loaded();

    (button(tree, 'Remove Family CFO').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(savedKeys()).toEqual(['/home']);
  });

  it('keeps a pin the member made from the rail while this screen was open through the next edit here', async () => {
    mount(['/home', '/dashboard/calendar']);
    await loaded();

    // The rail's "All Services" star pins Family CFO in this same tab and
    // broadcasts the new layout; this screen must follow it rather than save
    // its own stale list over it.
    const onBroadcast = listeners.get(SIDEBAR_NAV_EVENT);
    expect(onBroadcast).toBeDefined();
    onBroadcast!({ detail: { nav: ['/home', '/dashboard/calendar', PAID_CFO], children: {} } });
    const tree = render();
    expect(find(tree, 'Remove Family CFO')).toBeDefined();

    (button(tree, 'Move Calendar up').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(savedKeys()).toEqual(['/dashboard/calendar', '/home', PAID_CFO]);
  });

  // The three sentences below are the en-US copy for keys this fix adds
  // (navigationChoices.notInYourPlanShowsLocked, .unavailableNotShownInSidebar,
  // .pinMoreFromAllServices). The orchestrator's catalogue merge lands them in
  // the same commit; until it does these tests are RED on purpose — the mocked
  // translator renders a missing key as the key itself, which is not the sentence.
  const LOCKED_NOTE = 'Not in your plan, so it shows locked in your sidebar.';
  const HIDDEN_NOTE = 'Not available to you right now, so it is not shown in your sidebar.';
  const ALL_SERVICES_HINT = 'Other services in your plan can be pinned from All Services in your sidebar.';

  it('marks a pin the rail shows locked, and one it hides, for what the rail does — and still saves both', async () => {
    // Family Basic, with Family CFO set to the Family+ tier and Autopilot switched off.
    mocks.app = { ...mocks.app, planLevel: 1, featureTiers: { [PAID_CFO]: 'plus', [PAID_AUTOPILOT]: 'off' } };
    mount(['/home', PAID_CFO, PAID_AUTOPILOT]);
    const tree = await loaded();

    expect(rowText(tree, PAID_CFO)).toContain(LOCKED_NOTE);
    expect(rowText(tree, PAID_AUTOPILOT)).toContain(HIDDEN_NOTE);
    expect(rowText(tree, '/home')).not.toContain(LOCKED_NOTE);
    expect(rowText(tree, '/home')).not.toContain(HIDDEN_NOTE);

    // Marked, not dropped: an edit elsewhere in the list keeps both.
    (button(tree, 'Move Home down').props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(savedKeys()).toEqual([PAID_CFO, '/home', PAID_AUTOPILOT]);
  });

  it('shows a pin the plan unlocks as an ordinary row', async () => {
    mocks.app = { ...mocks.app, planLevel: 2, featureTiers: { [PAID_CFO]: 'plus' } };
    mount(['/home', PAID_CFO]);
    const text = rowText(await loaded(), PAID_CFO);
    expect(text).toContain('Family CFO');
    expect(text).not.toContain(LOCKED_NOTE);
    expect(text).not.toContain(HIDDEN_NOTE);
  });

  it('tells the member where the higher-tier services this picker does not list are pinned', async () => {
    mount(['/home', PAID_CFO]);
    (button(await loaded(), 'Add a destination').props.onClick as () => void)();
    const opened = render();

    expect(textOf(opened)).toContain(ALL_SERVICES_HINT);
    // The picker itself still offers the free catalog only (the file header's
    // documented choice), which is why the pointer is needed.
    expect(find(opened, 'Family Autopilot')).toBeUndefined();
  });
});
