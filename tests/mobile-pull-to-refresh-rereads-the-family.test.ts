// Pull to refresh is a complete recovery action (N15).
//
// The phone computes the calendar window from the cached family timezone and
// `parseCalendarReply` refuses a reply whose timezone differs from it. The
// cached timezone was re-read only by `freshFamily()`, which runs on Assistant
// focus or foreground; the Today and Calendar refresh paths re-read the data
// alone. So after a parent changed the household timezone on the web, every
// pull on Today and Calendar deterministically reproduced "Calendar account or
// window changed." until the person happened to open the Assistant tab or
// relaunch. Both refresh paths now re-read the family as well, and a changed
// timezone re-keys the calendar hook, which fetches the new window.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return requireMobile.resolve(name); } catch { return name; } };
const slots: unknown[] = []; let cursor = 0;
let effects: Array<() => void> = []; const cleanups = new Map<number, () => void>();
const fetchEvents = vi.fn(); const chores = vi.fn(); const grocery = vi.fn();
let auth: { session: { user: { id: string } } | null; family: Record<string, unknown> | null; familyLoading: boolean; familyError: string | null; refreshFamily: () => Promise<void> };
vi.doMock(resolveNative('react'), async () => ({
  ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
  useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => { const i = cursor++; const old = slots[i] as { fn: unknown; deps: unknown[] } | undefined; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { fn, deps }; return (slots[i] as { fn: unknown }).fn; },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = cursor++; const old = slots[i] as unknown[] | undefined; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(() => { cleanups.get(i)?.(); const cleanup = effect(); if (typeof cleanup === 'function') cleanups.set(i, cleanup); }); } },
}));
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));
vi.doMock('../mobile/src/lib/queries', () => ({ fetchUpcomingEvents: fetchEvents, fetchOpenChores: chores, fetchGroceryList: grocery }));
vi.doMock(resolveNative('react-native'), () => ({ AppState: { addEventListener: () => ({ remove: vi.fn() }) }, RefreshControl: 'RefreshControl', SectionList: 'SectionList', View: 'View', Pressable: 'Pressable' }));
vi.doMock(resolveNative('expo-router'), () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'EmptyState', 'GlassCard', 'ListRow', 'Pill', 'Screen', 'Button']) vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name, Divider: 'Divider' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: {}, spacing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }) }));
vi.doMock('../mobile/src/lib/config', () => ({ webUrl: (path: string) => path }));
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: {} }));
// Web CI has no native dependencies. Keep native UI imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const calendarPath = '../mobile/app/(tabs)/calendar'; const todayPath = '../mobile/app/(tabs)/index';
const { default: CalendarScreen } = await import(calendarPath); const { default: TodayScreen } = await import(todayPath);

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  if (typeof node.type === 'function') return nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props));
  return [node, ...nodes(node.props.children), ...nodes(node.props.refreshControl), ...nodes(node.props.ListHeaderComponent)];
}
const flush = () => { const pending = effects; effects = []; pending.forEach((fn) => fn()); };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const reply = (timezone: string) => ({ userId: 'a', familyId: 'family', timezone, fromDay: '2026-10-10', toDay: '2026-10-24', count: 0, occurrences: [] });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  slots.length = 0; cursor = 0; effects = []; cleanups.clear();
  auth = { session: { user: { id: 'a' } }, family: { familyId: 'family', memberId: 'member', timezone: 'UTC', displayName: 'Parent', familyName: 'Family', role: 'parent' }, familyLoading: false, familyError: null, refreshFamily: vi.fn(async () => {}) };
  fetchEvents.mockReset().mockImplementation(async (owner: { timezone: string }) => reply(owner.timezone));
  chores.mockReset().mockResolvedValue({ rows: [], count: 0, openCount: 0 });
  grocery.mockReset().mockResolvedValue({ familyId: 'family', listId: null, listName: null, otherLists: 0, items: [], count: 0 });
});
afterEach(() => { cleanups.forEach((fn) => fn()); vi.clearAllTimers(); vi.useRealTimers(); });

describe('the Calendar tab', () => {
  const screen = () => { cursor = 0; return CalendarScreen() as Node; };
  it('re-reads the family on pull to refresh, alongside the events', async () => {
    screen(); flush(); await settle();
    const control = nodes(screen()).find((n) => n.type === 'RefreshControl')!;
    await (control.props.onRefresh as () => Promise<void>)(); await settle();
    expect(auth.refreshFamily).toHaveBeenCalledTimes(1);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it('a timezone changed on the web recovers on the next pull: the refreshed family re-keys the hook, which asks for the new window', async () => {
    screen(); flush(); await settle();
    expect(fetchEvents).toHaveBeenLastCalledWith(expect.objectContaining({ timezone: 'UTC' }), 14, expect.anything());
    // The web moved the household to Paris; the server now answers in that zone.
    fetchEvents.mockImplementation(async () => reply('Europe/Paris'));
    (auth.refreshFamily as ReturnType<typeof vi.fn>).mockImplementation(async () => { auth.family = { ...auth.family!, timezone: 'Europe/Paris' }; });
    const control = nodes(screen()).find((n) => n.type === 'RefreshControl')!;
    await (control.props.onRefresh as () => Promise<void>)(); await settle();
    // The stale-zone request was refused; the re-keyed hook fetches for the new zone and succeeds.
    screen(); flush(); await settle();
    expect(fetchEvents).toHaveBeenLastCalledWith(expect.objectContaining({ timezone: 'Europe/Paris' }), 14, expect.anything());
    const tree = screen();
    expect(JSON.stringify(nodes(tree))).not.toContain('window changed');
    expect(nodes(tree).find((n) => n.type === 'SectionList')?.props.ListHeaderComponent ?? null).toBeNull();
  });
});

describe('the Today screen', () => {
  const screen = () => { cursor = 0; return TodayScreen() as Node; };
  it('re-reads the family on pull to refresh, alongside the household batch and the calendar', async () => {
    screen(); flush(); await settle();
    const page = nodes(screen()).find((n) => n.type === 'Screen')!;
    await (page.props.onRefresh as () => Promise<void>)(); await settle();
    expect(auth.refreshFamily).toHaveBeenCalledTimes(1);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(chores).toHaveBeenCalledTimes(2);
  });
});
