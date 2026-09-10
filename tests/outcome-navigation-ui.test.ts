import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationChoices } from '@/components/settings/navigation-choices';
import { SIDEBAR_NAV_STORAGE_KEY, SIDEBAR_NAV_CHILDREN_STORAGE_KEY, SIDEBAR_NAV_EVENT } from '@/lib/navigation/customize';

// Exercise the real component handlers and rendered controls with simulated
// React hooks and browser storage; this is not a browser/DOM test.
const mocks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[],
  load: vi.fn(), save: vi.fn(), success: vi.fn(), error: vi.fn(), dispatch: vi.fn() }));
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
function button(tree: ReactNode, label: string) {
  const result = nodes(tree).find((node) => typeof node.props.onClick === 'function' &&
    (node.props['aria-label'] === label || textOf(node.props.children as ReactNode).trim() === label));
  if (!result) throw new Error(`Missing control: ${label}`);
  return result;
}
const original = ['/home', '/dashboard/meals'];
const children = { '/dashboard/meals': [] };
let storage: Map<string, string>;
beforeEach(() => {
  mocks.slots = []; mocks.cursor = 0; mocks.effects = [];
  mocks.load.mockReset().mockResolvedValue({ nav: original, children });
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.success.mockReset(); mocks.error.mockReset(); mocks.dispatch.mockReset();
  storage = new Map([[SIDEBAR_NAV_STORAGE_KEY, JSON.stringify(original)], [SIDEBAR_NAV_CHILDREN_STORAGE_KEY, JSON.stringify(children)]]);
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, dispatchEvent: mocks.dispatch });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public options: unknown) {} });
});
afterEach(() => vi.unstubAllGlobals());
async function loaded() { render(); await Promise.resolve(); return render(); }

describe('navigation preference recovery', () => {
  it('restores the previous layout/cache/broadcast and unlocks controls after a manual transport failure', async () => {
    const tree = await loaded();
    mocks.save.mockRejectedValueOnce(new Error('transport unavailable'));
    (button(tree, 'Remove Meals').props.onClick as () => void)();
    expect(JSON.parse(storage.get(SIDEBAR_NAV_STORAGE_KEY)!)).toEqual(['/home']);
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(JSON.parse(storage.get(SIDEBAR_NAV_STORAGE_KEY)!)).toEqual(original);
    expect(JSON.parse(storage.get(SIDEBAR_NAV_CHILDREN_STORAGE_KEY)!)).toEqual(children);
    expect(mocks.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: SIDEBAR_NAV_EVENT, options: { detail: { nav: original, children } } }));
    expect(button(render(), 'Remove Meals').props.disabled).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('does not claim reset succeeded when its save rejects, and permits a subsequent retry', async () => {
    mocks.save.mockRejectedValueOnce(new Error('transport unavailable'));
    await (button(await loaded(), 'Reset').props.onClick as () => Promise<void>)();
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
    const retry = button(render(), 'Reset');
    expect(retry.props.disabled).toBe(false);
    await (retry.props.onClick as () => Promise<void>)();
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('only persists the personal preset after an explicit click and keeps the prior cache on transport failure', async () => {
    const tree = await loaded();
    expect(mocks.save).not.toHaveBeenCalled();
    const preset = button(tree, 'Use outcome-first navigation');
    mocks.save.mockRejectedValueOnce(new Error('transport unavailable'));
    (preset.props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({ preset: 'outcomes' });
    expect(JSON.parse(storage.get(SIDEBAR_NAV_STORAGE_KEY)!)).toEqual(original);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
