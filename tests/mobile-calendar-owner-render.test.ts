import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Execute the actual hook with simulated React scheduling, including renders
// before effect cleanup. No claim of native device rendering.
const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return requireMobile.resolve(name); } catch { return name; } };
const slots: unknown[] = []; let cursor = 0;
let effects: Array<() => void> = []; const cleanups = new Map<number, () => void>();
const fetchEvents = vi.fn();
const chores = vi.fn(); const grocery = vi.fn();
let auth: { session: { user: { id: string } } | null; family: { familyId: string; memberId: string; timezone: string } | null };
vi.doMock(resolveNative('react'), async () => ({
  ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
  useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { slots[i] = next; }]; },
  useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => { const i = cursor++; const old = slots[i] as { fn: unknown; deps: unknown[] } | undefined; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { fn, deps }; return (slots[i] as { fn: unknown }).fn; },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => (() => void), deps: unknown[]) => { const i = cursor++; const old = slots[i] as unknown[] | undefined; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(() => { cleanups.get(i)?.(); cleanups.set(i, effect()); }); } },
}));
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));
vi.doMock('../mobile/src/lib/queries', () => ({ fetchUpcomingEvents: fetchEvents, fetchOpenChores: chores, fetchGroceryList: grocery }));
vi.doMock(resolveNative('react-native'), () => ({ RefreshControl: 'RefreshControl', SectionList: 'SectionList', View: 'View', Pressable: 'Pressable' }));
vi.doMock(resolveNative('expo-router'), () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'EmptyState', 'GlassCard', 'ListRow', 'Pill', 'Screen', 'Button']) vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name, Divider: 'Divider' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: {}, spacing: [0,1,2,3,4,5] }) }));
vi.doMock('../mobile/src/lib/config', () => ({ webUrl: (path: string) => path }));
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: {} }));
const modulePath = '../mobile/src/hooks/use-calendar';
const { useCalendar } = await import(modulePath);
const calendarPath = '../mobile/app/(tabs)/calendar'; const todayPath = '../mobile/app/(tabs)/index';
const { default: CalendarScreen } = await import(calendarPath); const { default: TodayScreen } = await import(todayPath);
let windowDays = 3;
function TestHookScreen() { cursor = 0; return useCalendar(windowDays); }
const render = TestHookScreen;
const flush = () => { const pending = effects; effects = []; pending.forEach(fn => fn()); };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => { windowDays = 3; slots.length = 0; effects = []; cleanups.clear(); auth = { session: { user: { id: 'a' } }, family: { familyId: 'family', memberId: 'member', timezone: 'UTC', displayName: 'Parent', familyName: 'Family' } as never }; fetchEvents.mockReset().mockResolvedValue({ count: 9, timezone: 'UTC', occurrences: [{ title: 'Private A', starts_at: '2026-10-10T09:00:00Z', ends_at: null, all_day: false, category: 'family', occurrenceKey: 'occurrence-a' }] }); chores.mockReset().mockResolvedValue([{ id: 'chore', status: 'todo', chores: { title: 'Private chore A', points: 1 }, family_members: { display_name: 'Parent' } }]); grocery.mockReset().mockResolvedValue({ items: [{ is_checked: false }] }); });
describe('actual calendar hook owner boundary', () => {
  it.each(['signout', 'user', 'family', 'member'])('hides previous results before effects after %s', async reason => {
    render(); flush(); await settle(); expect(render().data?.count).toBe(9);
    if (reason === 'signout') auth.session = null;
    if (reason === 'user') auth.session = { user: { id: 'b' } };
    if (reason === 'family') auth.family = { ...auth.family!, familyId: 'other' };
    if (reason === 'member') auth.family = { ...auth.family!, memberId: 'other' };
    expect(render().data).toBeNull(); expect(render().error).toBeNull();
  });
  it('aborts old requests and ignores late completion before and after cleanup', async () => {
    let finish!: (v: unknown) => void; fetchEvents.mockReturnValueOnce(new Promise(done => { finish = done; }));
    render(); flush(); const signal = fetchEvents.mock.calls[0][2] as AbortSignal;
    auth.session = { user: { id: 'b' } }; expect(render().data).toBeNull();
    finish({ count: 99, occurrences: [] }); await settle(); expect(render().data).toBeNull();
    fetchEvents.mockRejectedValueOnce(new Error('offline')); flush(); await settle();
    expect(signal.aborted).toBe(true); expect(render().data).toBeNull(); expect(render().error).toBe('offline');
  });
  it('aborts on unmount and cannot publish a late result', async () => {
    let finish!: (v: unknown) => void; fetchEvents.mockReturnValueOnce(new Promise(done => { finish = done; }));
    render(); flush(); const signal = fetchEvents.mock.calls[0][2] as AbortSignal;
    cleanups.forEach(fn => fn()); finish({ count: 99 }); await settle();
    expect(signal.aborted).toBe(true); expect(render().data).toBeNull();
  });
  it('does not resurrect previous results on an A to B to A render sequence before effects', async () => {
    render(); flush(); await settle(); expect(render().data).not.toBeNull();
    auth.session = { user: { id: 'b' } }; expect(render().data).toBeNull(); auth.session = { user: { id: 'a' } }; expect(render().data).toBeNull();
  });
  it('hides a previous window before effects when days change for the same owner', async () => {
    render(); flush(); await settle(); expect(render().data?.count).toBe(9); windowDays = 14; expect(render().data).toBeNull();
  });
  it.each(['user', 'family', 'signout'])('actual Today tree hides calendar, chores and grocery counts before effects after %s', async reason => {
    const screen = () => { cursor = 0; return TodayScreen(); };
    screen(); flush(); await settle(); const before = JSON.stringify(screen()); expect(before).toContain('Private chore A'); expect(before).toContain('Private A'); expect(before).toContain('"value":"9"');
    if (reason === 'user') auth.session = { user: { id: 'b' } };
    if (reason === 'family') auth.family = { ...auth.family!, familyId: 'other' };
    if (reason === 'signout') { auth.session = null; auth.family = null; }
    const after = JSON.stringify(screen()); expect(after).not.toContain('Private chore A'); expect(after).not.toContain('Private A'); expect(after).not.toContain('"value":"9"'); expect(after).not.toContain('"value":"1"');
    fetchEvents.mockRejectedValue(new Error('offline')); chores.mockRejectedValue(new Error('offline')); flush(); await settle(); expect(JSON.stringify(screen())).not.toContain('Private');
  });
  it('actual Calendar tree uses stable occurrence keys and removes old sections before effects', async () => {
    const screen = () => { cursor = 0; return CalendarScreen(); };
    screen(); flush(); await settle(); const tree = screen();
    const list = tree.props.children; expect(list.props.sections[0].data[0].title).toBe('Private A'); expect(list.props.keyExtractor(list.props.sections[0].data[0])).toBe('occurrence-a');
    auth.session = { user: { id: 'b' } }; expect(screen().props.children.props.sections).toEqual([]);
  });
});
