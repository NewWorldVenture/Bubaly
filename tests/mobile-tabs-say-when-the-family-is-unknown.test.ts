// A family read that is still running, or that failed, is not an empty household (N4).
//
// FamilySession reports a failed `resolveActiveFamily` as family null plus
// familyError, and the first read of a session as family null plus
// familyLoading. The Chores, Grocery and Calendar tabs read only `family`:
// with no family id their loaders resolved to nothing, loading went false, and
// each showed its healthy empty state — "Nothing open", "Your list is empty",
// "A clear fortnight" — for a read that had failed, with no way to retry; the
// same states flashed on every cold start. Today showed "Finish setting up
// your family" and its web link while the family was still loading, and
// Settings said "No family yet". Now every screen says which of the three
// states it is in, through one FamilyGate.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return requireMobile.resolve(name); } catch { return name; } };
const slots: unknown[] = []; let cursor = 0; let effects: Array<() => void> = [];
vi.doMock(resolveNative('react'), async () => ({
  ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
  useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => { const i = cursor++; const old = slots[i] as { fn: unknown; deps: unknown[] } | undefined; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { fn, deps }; return (slots[i] as { fn: unknown }).fn; },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => void, deps: unknown[]) => { const i = cursor++; const old = slots[i] as unknown[] | undefined; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(effect); } },
}));
vi.doMock(resolveNative('react-native'), () => ({ AppState: { addEventListener: () => ({ remove: vi.fn() }) }, FlatList: 'FlatList', SectionList: 'SectionList', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, Pressable: 'Pressable', RefreshControl: 'RefreshControl', View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('expo-router'), () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.doMock(resolveNative('expo-constants'), () => ({ default: { expoConfig: { version: 'test' } } }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'Button', 'EmptyState', 'Field', 'GlassCard', 'Pill', 'Screen']) vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name }));
vi.doMock('../mobile/src/components/ListRow', () => ({ Divider: 'Divider', ListRow: 'ListRow' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: {}, spacing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], radius: {}, layout: { touchTarget: 44 }, preference: 'dark', mode: 'dark', setPreference: vi.fn() }) }));
vi.doMock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://phone.invalid' }, webUrl: (path: string) => path }));
vi.doMock('../mobile/src/lib/mobile-i18n', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/mobile-i18n'), deviceLocale: () => 'en-US' }));
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: {} }));
const reads = { chores: vi.fn(), grocery: vi.fn(), events: vi.fn() };
vi.doMock('../mobile/src/lib/queries', () => ({ fetchOpenChores: reads.chores, fetchGroceryList: reads.grocery, fetchUpcomingEvents: reads.events, completeChore: vi.fn(), addGroceryItem: vi.fn(), setGroceryChecked: vi.fn() }));
type Auth = { session: { user: { id: string } } | null; family: Record<string, unknown> | null; familyLoading: boolean; familyError: string | null; refreshFamily: () => Promise<void>; signOut: () => Promise<void> };
let auth: Auth;
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));

const { mobileTranslate } = await import('../mobile/src/lib/mobile-i18n');
// Web CI has no native dependencies. Keep native UI imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const choresModule = '../mobile/app/(tabs)/chores'; const groceryModule = '../mobile/app/(tabs)/grocery'; const calendarModule = '../mobile/app/(tabs)/calendar';
const todayModule = '../mobile/app/(tabs)/index'; const settingsModule = '../mobile/app/settings';
const { default: ChoresScreen } = await import(choresModule);
const { default: GroceryScreen } = await import(groceryModule);
const { default: CalendarScreen } = await import(calendarModule);
const { default: TodayScreen } = await import(todayModule);
const { default: SettingsScreen } = await import(settingsModule);

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  if (typeof node.type === 'function') return nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props));
  return [node, ...nodes(node.props.children), ...nodes(node.props.right), ...nodes(node.props.ListHeaderComponent), ...nodes(node.props.ListEmptyComponent), ...nodes(node.props.action)];
}
const t = (key: string) => mobileTranslate('en-US', key);
const flush = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const family = { familyId: 'family', familyName: 'Family', timezone: 'UTC', memberId: 'member', role: 'parent', displayName: 'Dana' };

const TABS = [
  ['Chores', ChoresScreen, 'Nothing open'],
  ['Grocery', GroceryScreen, 'Your list is empty'],
  ['Calendar', CalendarScreen, 'A clear fortnight'],
] as const;

beforeEach(() => {
  slots.length = 0; cursor = 0; effects = [];
  reads.chores.mockReset().mockResolvedValue({ rows: [], count: 0, openCount: 0 });
  reads.grocery.mockReset().mockResolvedValue({ familyId: 'family', listId: null, listName: null, otherLists: 0, items: [], count: 0 });
  reads.events.mockReset().mockResolvedValue({ userId: 'user', familyId: 'family', timezone: 'UTC', fromDay: '2026-10-14', toDay: '2026-10-28', count: 0, occurrences: [] });
  auth = { session: { user: { id: 'user' } }, family: { ...family }, familyLoading: false, familyError: null, refreshFamily: vi.fn(async () => {}), signOut: vi.fn(async () => {}) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(TABS)('the %s tab', (_name, Screen, healthy) => {
  const render = () => { cursor = 0; return nodes(Screen()); };
  const text = () => JSON.stringify(render());

  it('shows its healthy empty state only for a confirmed family whose read came back empty', async () => {
    render(); flush(); await settle();
    expect(text()).toContain(healthy);
  });

  it('says the family could not be loaded, with a retry, when the family read failed', async () => {
    auth = { ...auth, family: null, familyError: t('mobileAssistant.familyUnavailable') };
    render(); flush(); await settle();
    const tree = render();
    const json = JSON.stringify(tree);
    expect(json).toContain(t('mobileAssistant.familyLoadFailed'));
    expect(json).toContain(t('mobileAssistant.familyUnavailable'));
    expect(json).not.toContain(healthy);
    const retry = tree.find((n) => n.type === 'Button' && n.props.accessibilityLabel === t('mobileAssistant.retry'))!;
    (retry.props.onPress as () => void)();
    expect(auth.refreshFamily).toHaveBeenCalledTimes(1);
    expect(reads.chores).not.toHaveBeenCalled();
    expect(reads.grocery).not.toHaveBeenCalled();
    expect(reads.events).not.toHaveBeenCalled();
  });

  it('shows neither the healthy state nor an error while the family is still loading', async () => {
    auth = { ...auth, family: null, familyLoading: true };
    render(); flush(); await settle();
    const tree = render();
    expect(JSON.stringify(tree)).not.toContain(healthy);
    expect(JSON.stringify(tree)).not.toContain(t('mobileAssistant.familyLoadFailed'));
    expect(tree.some((n) => n.type === 'ActivityIndicator')).toBe(true);
  });

  it('points a person with no household to the web app', async () => {
    auth = { ...auth, family: null };
    render(); flush(); await settle();
    const json = text();
    expect(json).toContain(t('mobileAssistant.familyNeeded'));
    expect(json).not.toContain(healthy);
  });
});

describe('the Today screen', () => {
  const render = () => { cursor = 0; return nodes(TodayScreen()); };

  it('shows a loading card, not the onboarding card, while the family is still being read', async () => {
    auth = { ...auth, family: null, familyLoading: true };
    render(); flush(); await settle();
    const tree = render();
    const json = JSON.stringify(tree);
    expect(json).not.toContain(t('mobileAssistant.familyNeeded'));
    expect(json).not.toContain(t('mobileAssistant.openWebApp'));
    expect(json).not.toContain(t('mobileAssistant.familyLoadFailed'));
    expect(tree.some((n) => n.type === 'ActivityIndicator')).toBe(true);
  });

  it('says the family could not be loaded when the read failed, and the onboarding card only when there is none', async () => {
    auth = { ...auth, family: null, familyError: t('mobileAssistant.familyUnavailable') };
    render(); flush(); await settle();
    const failed = JSON.stringify(render());
    expect(failed).toContain(t('mobileAssistant.familyLoadFailed'));
    expect(failed).not.toContain(t('mobileAssistant.familyNeeded'));
    auth = { ...auth, familyError: null, familyLoading: false };
    const none = JSON.stringify(render());
    expect(none).toContain(t('mobileAssistant.familyNeeded'));
    expect(none).toContain(t('mobileAssistant.openWebApp'));
  });
});

describe('the Settings screen', () => {
  const render = () => { cursor = 0; return JSON.stringify(nodes(SettingsScreen())); };

  it('says "No family yet" only once the family read has answered with none', () => {
    auth = { ...auth, family: null, familyLoading: true };
    expect(render()).toContain(t('mobileAssistant.checking'));
    expect(render()).not.toContain('No family yet');
    auth = { ...auth, familyLoading: false, familyError: t('mobileAssistant.familyUnavailable') };
    expect(render()).toContain(t('mobileAssistant.familyLoadFailed'));
    expect(render()).not.toContain('No family yet');
    auth = { ...auth, familyError: null };
    expect(render()).toContain('No family yet');
  });
});
