// The phone's Chores tab, driven end to end: the real screen, the real
// queries, the phone's Supabase client being an in-memory database.
//
// What this holds (audit findings N1, N3, N4, N7, N10, N12, N13):
//   - "Done" settles a no-approval chore to done, as the web service does, and
//     a chore that needs approval waits as submitted.
//   - Done is offered only on your own chore (or on anyone's to a parent or
//     adult), and the write carries the same rule plus "still open": a row that
//     no longer matches — a sibling's, one the web approved meanwhile, one that
//     is gone — writes nothing, is shown in its own words and is re-read, where
//     the unconditional write with no `.select()` was shown as "Waiting for
//     approval" whatever had happened to the row.
//   - Rows belong to the family they were read for: a family switch hides them
//     before the new read; a failed refresh keeps them and says so beside them;
//     a failed first read is fixed copy, never the database's wording.
//   - The counts are the household's, not the page's.
//   - A family that could not be confirmed is said so, not shown as "Nothing open".
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

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
vi.doMock(resolveNative('react-native'), () => ({ FlatList: 'FlatList', RefreshControl: 'RefreshControl', View: 'View', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable' }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'Button', 'EmptyState', 'GlassCard', 'Pill', 'Screen']) vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: { danger: 'red', brand: 'purple' }, spacing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }) }));
vi.doMock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://phone.invalid' }, webUrl: (path: string) => path }));
vi.doMock('../mobile/src/lib/mobile-i18n', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/mobile-i18n'), deviceLocale: () => 'en-US' }));
/** The phone's client: the shared database, or one made to fail. */
let phoneDb: () => { from: InMemorySupabase['from']; rpc: InMemorySupabase['rpc'] };
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: { from: (table: string) => phoneDb().from(table), rpc: (name: string, args: Record<string, unknown>) => phoneDb().rpc(name, args) } }));
type Auth = { family: Record<string, unknown> | null; familyLoading: boolean; familyError: string | null; refreshFamily: () => Promise<void> };
let auth: Auth;
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));

const { mobileTranslate } = await import('../mobile/src/lib/mobile-i18n');
// Web CI has no native dependencies. Keep native UI imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const screenModule = '../mobile/app/(tabs)/chores';
const { default: ChoresScreen } = await import(screenModule);

// ── the household ───────────────────────────────────────────────────────────
const FAMILY = '00000000-0000-4000-8000-0000000e0001';
const OTHER_FAMILY = '00000000-0000-4000-8000-0000000e0002';
const CHILD = { member: '00000000-0000-4000-8000-0000000e1001' };
const SIBLING = { member: '00000000-0000-4000-8000-0000000e1002' };
const PARENT = { member: '00000000-0000-4000-8000-0000000e1003' };
const CHILD_ELSEWHERE = { member: '00000000-0000-4000-8000-0000000e1004' };
const BED = '00000000-0000-4000-8000-0000000e3001';
const DISHES = '00000000-0000-4000-8000-0000000e3002';
const LAWN = '00000000-0000-4000-8000-0000000e3003';
const BED_TODAY = '00000000-0000-4000-8000-0000000e4001';
const DISHES_TODAY = '00000000-0000-4000-8000-0000000e4002';
const TRASH_TODAY = '00000000-0000-4000-8000-0000000e4003';
const LAWN_ELSEWHERE = '00000000-0000-4000-8000-0000000e4004';
const t = (key: string, params?: Record<string, string | number>) => mobileTranslate('en-US', key, params);
const familyOf = (who: { member: string }, role: string, familyId = FAMILY) => ({ familyId, familyName: 'The Riveras', timezone: 'America/New_York', memberId: who.member, role, displayName: 'Someone' });
const signIn = (who: { member: string }, role: string) => {
  auth = { family: familyOf(who, role), familyLoading: false, familyError: null, refreshFamily: vi.fn(async () => {}) };
};

let db: InMemorySupabase;
const row = (id: string) => db.table('chore_assignments').find((r) => r.id === id)!;

// ── rendering ───────────────────────────────────────────────────────────────
type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  if (typeof node.type === 'function') return nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props));
  return [node, ...nodes(node.props.children), ...nodes(node.props.ListHeaderComponent), ...nodes(node.props.ListFooterComponent), ...nodes(node.props.ListEmptyComponent), ...nodes(node.props.action)];
}
const screen = () => { cursor = 0; return ChoresScreen() as Node; };
const flush = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const list = (tree: Node) => nodes(tree).find((n) => n.type === 'FlatList')!;
const ids = (tree: Node) => (list(tree).props.data as { id: string }[]).map((r) => r.id);
const statusOf = (tree: Node, id: string) => (list(tree).props.data as { id: string; status: string }[]).find((r) => r.id === id)?.status;
const cards = (tree: Node) => { const l = list(tree); return (l.props.data as { id: string }[]).map((item) => nodes((l.props.renderItem as (a: { item: unknown }) => unknown)({ item }))); };
const doneButtons = (tree: Node) => cards(tree).flatMap((card) => card.filter((n) => n.type === 'Button' && String(n.props.accessibilityLabel).startsWith('Mark ')));
const doneButton = (tree: Node, title: string) => doneButtons(tree).find((b) => b.props.accessibilityLabel === `Mark ${title} done`)!;
const header = (tree: Node) => JSON.stringify(list(tree).props.ListHeaderComponent ?? null);
const subtitle = (tree: Node) => nodes(tree).find((n) => n.type === 'Screen')?.props.subtitle;
/** Everything on screen, function components expanded and every card rendered. */
const text = (tree: Node) => JSON.stringify([nodes(tree), nodes(tree).some((n) => n.type === 'FlatList') ? cards(tree) : []]);
/** A phone client whose every read answers one database error, as supabase-js does: a PostgrestError, which extends Error. */
const failingClient = (message: string, code: string) => ({
  from: () => {
    const chain: Record<string, unknown> = {};
    const reply = () => ({ data: null, count: null, error: Object.assign(new Error(message), { code, details: null, hint: null }) });
    for (const method of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'abortSignal']) chain[method] = () => chain;
    chain.maybeSingle = async () => reply();
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(reply()).then(resolve);
    return chain;
  },
  rpc: async () => ({ data: null, error: null }),
});

beforeEach(() => {
  slots.length = 0; cursor = 0; effects = [];
  db = createInMemorySupabase();
  phoneDb = () => db;
  db.seed('families', [
    { id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' },
    { id: OTHER_FAMILY, name: 'The Chens', timezone: 'UTC' },
  ]);
  db.seed('chores', [
    { id: BED, family_id: FAMILY, title: 'Make bed', points: 2, requires_approval: false, recurrence: 'daily' },
    { id: DISHES, family_id: FAMILY, title: 'Dishes', points: 5, requires_approval: true, recurrence: 'none' },
    { id: LAWN, family_id: OTHER_FAMILY, title: 'Mow the lawn', points: 9, requires_approval: true, recurrence: 'none' },
  ]);
  db.seed('chore_assignments', [
    { id: BED_TODAY, family_id: FAMILY, chore_id: BED, member_id: CHILD.member, status: 'todo', due_at: '2026-10-14T20:00:00Z', submitted_at: null, approved_at: null, points_awarded: null },
    { id: DISHES_TODAY, family_id: FAMILY, chore_id: DISHES, member_id: CHILD.member, status: 'todo', due_at: '2026-10-14T21:00:00Z', submitted_at: null, approved_at: null, points_awarded: null },
    { id: TRASH_TODAY, family_id: FAMILY, chore_id: DISHES, member_id: SIBLING.member, status: 'todo', due_at: '2026-10-14T22:00:00Z', submitted_at: null, approved_at: null, points_awarded: null },
    { id: LAWN_ELSEWHERE, family_id: OTHER_FAMILY, chore_id: LAWN, member_id: CHILD_ELSEWHERE.member, status: 'todo', due_at: '2026-10-15T20:00:00Z', submitted_at: null, approved_at: null, points_awarded: null },
  ]);
  signIn(CHILD, 'child');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Done settles the chore the way the service does (N1)', () => {
  it('settles a no-approval chore to done and drops it from the open list; the daily one is the cron sweep’s to respawn', async () => {
    screen(); flush(); await settle();
    let tree = screen();
    expect(ids(tree)).toEqual([BED_TODAY, DISHES_TODAY, TRASH_TODAY]);
    expect(subtitle(tree)).toBe('3 open');
    await (doneButton(tree, 'Make bed').props.onPress as () => Promise<void>)();
    tree = screen();
    expect(row(BED_TODAY)).toMatchObject({ status: 'done' });
    expect(row(BED_TODAY).submitted_at).toEqual(expect.any(String));
    expect(ids(tree)).toEqual([DISHES_TODAY, TRASH_TODAY]);
    expect(subtitle(tree)).toBe('2 open');
    expect(header(tree)).toBe('null');
  });

  it('shows a chore that needs approval as waiting, and writes it so', async () => {
    screen(); flush(); await settle();
    await (doneButton(screen(), 'Dishes').props.onPress as () => Promise<void>)();
    const tree = screen();
    expect(statusOf(tree, DISHES_TODAY)).toBe('submitted');
    expect(row(DISHES_TODAY)).toMatchObject({ status: 'submitted' });
    expect(text(tree)).toContain('Waiting for approval');
  });
});

describe('whose chore it is, and whether it is still open (N1, N3, N13)', () => {
  it('offers Done only on the child’s own rows, and on every open row to a parent', async () => {
    screen(); flush(); await settle();
    expect(doneButtons(screen()).map((b) => b.props.accessibilityLabel)).toEqual(['Mark Make bed done', 'Mark Dishes done']);
    slots.length = 0; effects = []; signIn(PARENT, 'parent');
    screen(); flush(); await settle();
    expect(doneButtons(screen()).map((b) => b.props.accessibilityLabel)).toEqual(['Mark Make bed done', 'Mark Dishes done', 'Mark Dishes done']);
  });

  it('a tap on a row that is no longer the child’s writes nothing, says so, and re-reads the list', async () => {
    // The handler of a row the child may not complete, exercised the way a
    // stale card would be: theirs on screen, handed to a sibling meanwhile.
    screen(); flush(); await settle();
    const press = doneButton(screen(), 'Dishes').props.onPress as () => Promise<void>;
    Object.assign(row(DISHES_TODAY), { member_id: SIBLING.member });
    await press(); await settle();
    const tree = screen();
    expect(header(tree)).toContain(t('mobileAssistant.choreNotYours'));
    expect(row(DISHES_TODAY)).toMatchObject({ status: 'todo', submitted_at: null });
    expect(statusOf(tree, DISHES_TODAY)).toBe('todo');
    expect(text(tree)).not.toContain('Waiting for approval');
  });

  it('a parent’s stale tap on a chore the web approved meanwhile leaves it approved — points and all', async () => {
    signIn(PARENT, 'parent');
    screen(); flush(); await settle();
    const press = doneButton(screen(), 'Dishes').props.onPress as () => Promise<void>;
    Object.assign(row(DISHES_TODAY), { status: 'approved', approved_at: '2026-10-14T18:00:00Z', approved_by: PARENT.member, points_awarded: 5 });
    await press(); await settle();
    const tree = screen();
    expect(header(tree)).toContain(t('mobileAssistant.choreApprovedIsSettled'));
    expect(row(DISHES_TODAY)).toMatchObject({ status: 'approved', approved_at: '2026-10-14T18:00:00Z', points_awarded: 5, submitted_at: null });
    // The re-read list no longer carries the approved row at all.
    expect(statusOf(tree, DISHES_TODAY)).toBeUndefined();
    expect(text(tree)).not.toContain('Waiting for approval');
  });

  it('a chore that is gone is said to be gone, not shown as waiting for approval', async () => {
    screen(); flush(); await settle();
    const press = doneButton(screen(), 'Make bed').props.onPress as () => Promise<void>;
    db.replace('chore_assignments', db.table('chore_assignments').filter((r) => r.id !== BED_TODAY));
    await press(); await settle();
    const tree = screen();
    expect(header(tree)).toContain(t('mobileAssistant.choreGone'));
    expect(ids(tree)).toEqual([DISHES_TODAY, TRASH_TODAY]);
    expect(text(tree)).not.toContain('Waiting for approval');
  });

  it('a write the database refuses is shown as fixed copy, never the policy’s wording', async () => {
    screen(); flush(); await settle();
    const press = doneButton(screen(), 'Make bed').props.onPress as () => Promise<void>;
    phoneDb = () => failingClient('new row violates row-level security policy for table "chore_assignments"', '42501') as never;
    await press(); await settle();
    const tree = screen();
    expect(header(tree)).toContain(t('mobileAssistant.choreUpdateFailed'));
    expect(text(tree)).not.toContain('row-level security');
    expect(statusOf(tree, BED_TODAY)).toBe('todo');
  });
});

describe('the rows belong to the family they were read for (N7, N10)', () => {
  it('hides the previous family’s rows the moment the family changes, before any effect runs', async () => {
    screen(); flush(); await settle();
    expect(text(screen())).toContain('Make bed');
    auth = { ...auth, family: familyOf(CHILD_ELSEWHERE, 'child', OTHER_FAMILY) };
    const tree = screen();
    expect(list(tree).props.data).toEqual([]);
    expect(doneButtons(tree)).toEqual([]);
    expect(text(tree)).not.toContain('Make bed');
    expect(subtitle(tree)).toBeUndefined();
    expect(text(tree)).not.toContain('Nothing open');
    flush(); await settle();
    const after = screen();
    expect(ids(after)).toEqual([LAWN_ELSEWHERE]);
    expect(text(after)).not.toContain('Make bed');
  });

  it('keeps the previous family’s rows off screen when the new family’s read fails', async () => {
    screen(); flush(); await settle();
    auth = { ...auth, family: familyOf(CHILD_ELSEWHERE, 'child', OTHER_FAMILY) };
    phoneDb = () => failingClient('fetch failed', '') as never;
    screen(); flush(); await settle();
    const tree = screen();
    expect(list(tree).props.data).toEqual([]);
    expect(text(tree)).not.toContain('Make bed');
    expect(header(tree)).toContain(t('mobileAssistant.choresUnavailable'));
  });

  it('keeps the rows when a refresh fails, and says so beside them in fixed words', async () => {
    screen(); flush(); await settle();
    phoneDb = () => failingClient('permission denied for table chore_assignments', '42501') as never;
    const onRefresh = (list(screen()).props.refreshControl as Node).props.onRefresh as () => Promise<void>;
    await onRefresh(); await settle();
    const tree = screen();
    expect(ids(tree)).toEqual([BED_TODAY, DISHES_TODAY, TRASH_TODAY]);
    expect(header(tree)).toContain(t('mobileAssistant.refreshFailed'));
    expect(text(tree)).not.toContain('permission denied');
    expect(text(tree)).not.toContain('Nothing open');
    // The next refresh that succeeds clears it.
    phoneDb = () => db;
    await onRefresh(); await settle();
    expect(header(screen())).toBe('null');
  });

  it('a first read that fails shows the fixed copy and no healthy empty state, never the database’s wording', async () => {
    phoneDb = () => failingClient('JWT expired', 'PGRST301') as never;
    screen(); flush(); await settle();
    const tree = screen();
    expect(header(tree)).toContain(t('mobileAssistant.choresUnavailable'));
    for (const raw of ['JWT expired', 'PGRST']) expect(text(tree)).not.toContain(raw);
    expect(text(tree)).not.toContain('Nothing open');
    expect(subtitle(tree)).toBeUndefined();
  });
});

describe('the counts are the household’s (N12)', () => {
  it('reports every open chore and says how many of them are shown', async () => {
    db.seed('chore_assignments', Array.from({ length: 130 }, (_, n) => ({
      id: `00000000-0000-4000-8000-00000000${(0x5000 + n).toString(16).padStart(4, '0')}`, family_id: FAMILY, chore_id: BED, member_id: CHILD.member,
      status: n % 10 === 0 ? 'submitted' : 'todo', due_at: `2026-10-${String(15 + (n % 10)).padStart(2, '0')}T20:00:00Z`, submitted_at: null, approved_at: null, points_awarded: null,
    })));
    screen(); flush(); await settle();
    const tree = screen();
    expect((list(tree).props.data as unknown[]).length).toBe(100);
    // 3 seeded open + 117 of the 130 (13 are submitted).
    expect(subtitle(tree)).toBe('120 open');
    expect(JSON.stringify(list(tree).props.ListFooterComponent)).toContain(t('mobileAssistant.showingChores', { shown: 100, total: 133 }));
  });
});

describe('a family that could not be confirmed (N4)', () => {
  it('shows the failure and a retry, not "Nothing open"', async () => {
    auth = { ...auth, family: null, familyError: t('mobileAssistant.familyUnavailable') };
    screen(); flush(); await settle();
    const tree = screen();
    expect(text(tree)).toContain(t('mobileAssistant.familyLoadFailed'));
    expect(text(tree)).toContain(t('mobileAssistant.familyUnavailable'));
    expect(text(tree)).not.toContain('Nothing open');
    expect(db.log.filter((entry) => entry.table === 'chore_assignments')).toEqual([]);
    const retry = nodes(tree).find((n) => n.type === 'Button' && n.props.accessibilityLabel === t('mobileAssistant.retry'))!;
    (retry.props.onPress as () => void)();
    expect(auth.refreshFamily).toHaveBeenCalledTimes(1);
  });

  it('shows nothing healthy while the family is still loading, and the web link when there is none', async () => {
    auth = { ...auth, family: null, familyLoading: true };
    expect(text(screen())).not.toContain('Nothing open');
    expect(nodes(screen()).some((n) => n.type === 'ActivityIndicator')).toBe(true);
    auth = { ...auth, family: null, familyLoading: false };
    const tree = screen();
    expect(text(tree)).toContain(t('mobileAssistant.familyNeeded'));
    expect(text(tree)).not.toContain('Nothing open');
  });
});
