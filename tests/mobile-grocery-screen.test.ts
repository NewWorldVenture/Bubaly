// The phone's Grocery tab, driven end to end against an in-memory database:
// the real screen, the real queries, the phone's Supabase client being the
// database.
//
// What this holds (audit findings N3, N4, N7, N8, N10, N12):
//   - The default list comes from 0443's `ensure_default_grocery_list`, not a
//     read-then-insert, so two first captures cannot give the family two lists;
//     a name already open on the list is not added twice (the web's rule, the
//     web's normalisation); and one submit in flight is one submit, return key
//     or Add.
//   - A check on an item that is gone is undone and said, not kept as a tick;
//     two quick taps on one row issue one write.
//   - Rows belong to the family they were read for: after a switch the
//     previous family's list is neither shown nor written to; a failed refresh
//     keeps the rows and says so beside them; an add that landed stays shown
//     when the follow-up refresh fails.
//   - The list's name, its siblings and its true size are said.
//   - A family that could not be confirmed is said so, not shown as empty.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeName } from '@/lib/groceries/normalize-name';
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
vi.doMock(resolveNative('react-native'), () => ({ FlatList: 'FlatList', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, Pressable: 'Pressable', RefreshControl: 'RefreshControl', View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.doMock(resolveNative('expo-linking'), () => ({ openURL: vi.fn() }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'Button', 'EmptyState', 'Field', 'GlassCard', 'Screen']) vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name }));
vi.doMock('../mobile/src/components/ListRow', () => ({ Divider: 'Divider', ListRow: 'ListRow' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: { danger: 'red', brand: 'purple', success: 'green', muted: 'grey' }, spacing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }) }));
vi.doMock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://phone.invalid' }, webUrl: (path: string) => path }));
vi.doMock('../mobile/src/lib/mobile-i18n', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/mobile-i18n'), deviceLocale: () => 'en-US' }));
let phoneDb: () => { from: InMemorySupabase['from']; rpc: InMemorySupabase['rpc'] };
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: { from: (table: string) => phoneDb().from(table), rpc: (name: string, args: Record<string, unknown>) => phoneDb().rpc(name, args) } }));
type Auth = { session: { user: { id: string } } | null; family: Record<string, unknown> | null; familyLoading: boolean; familyError: string | null; refreshFamily: () => Promise<void> };
let auth: Auth;
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));

const { mobileTranslate } = await import('../mobile/src/lib/mobile-i18n');
const queriesModule = '../mobile/src/lib/queries';
const { normalizeGroceryName } = await import(queriesModule);
// Web CI has no native dependencies. Keep native UI imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const screenModule = '../mobile/app/(tabs)/grocery';
const { default: GroceryScreen } = await import(screenModule);

const FAMILY = 'family-a';
const OTHER = 'family-b';
const USER = 'user-1';
const LIST_A = 'list-a';
const LIST_A2 = 'list-a-second';
const LIST_B = 'list-b';
const t = (key: string, params?: Record<string, string | number>) => mobileTranslate('en-US', key, params);
const familyOf = (familyId: string) => ({ familyId, familyName: familyId, timezone: 'UTC', memberId: `member-${familyId}`, role: 'parent', displayName: 'Dana' });
const DEFAULTS = { grocery_lists: { is_archived: false, archived_at: null, sort_order: null }, grocery_items: { is_checked: false, quantity: null } };

let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];
type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  if (typeof node.type === 'function') return nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props));
  return [node, ...nodes(node.props.children), ...nodes(node.props.leading), ...nodes(node.props.ListHeaderComponent), ...nodes(node.props.ListFooterComponent), ...nodes(node.props.ListEmptyComponent), ...nodes(node.props.action)];
}
const screen = () => { cursor = 0; return GroceryScreen() as Node; };
const flush = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const list = (tree: Node) => nodes(tree).find((n) => n.type === 'FlatList')!;
const field = (tree: Node) => nodes(tree).find((n) => n.type === 'Field')!;
const addButton = (tree: Node) => nodes(tree).find((n) => n.type === 'Button' && n.props.title === 'Add')!;
const rows = (tree: Node) => (list(tree).props.data as { id: string; name: string; is_checked: boolean }[]);
const rowFor = (tree: Node, item: unknown) => nodes((list(tree).props.renderItem as (a: { item: unknown }) => unknown)({ item }));
const rowPress = (tree: Node, item: unknown) => rowFor(tree, item).find((n) => n.type === 'ListRow')!.props.onPress as (() => Promise<void>) | undefined;
const checkbox = (tree: Node, item: unknown) => rowFor(tree, item).find((n) => n.props.accessibilityRole === 'checkbox')!;
/** Everything on screen (or in one slot of it), function components expanded. */
const text = (tree: unknown) => JSON.stringify(nodes(tree));
const typeAndSubmit = async (tree: Node, name: string) => {
  (field(tree).props.onChangeText as (value: string) => void)(name);
  const typed = screen();
  await (addButton(typed).props.onPress as () => Promise<void>)();
  await settle();
};
/** A phone client whose every read answers one database error, as supabase-js does: a PostgrestError, which extends Error. */
const failingReads = (message: string, code: string) => ({
  from: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'abortSignal']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: Object.assign(new Error(message), { code, details: null, hint: null }) }).then(resolve);
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args),
});

beforeEach(() => {
  slots.length = 0; cursor = 0; effects = []; rpcCalls = [];
  db = createInMemorySupabase({
    defaults: DEFAULTS,
    // 0443's get-or-create, as the database answers it: the oldest open list, or a new one, under a lock.
    rpc: { ensure_default_grocery_list: (args, store) => {
      rpcCalls.push(args);
      const open = store.table('grocery_lists').filter((l) => l.family_id === args.p_family_id && !l.is_archived && l.archived_at === null).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (open[0]) return open[0].id;
      const created = store.withDefaults('grocery_lists', { family_id: args.p_family_id, name: args.p_name, created_by: args.p_created_by });
      store.table('grocery_lists').push(created);
      return created.id;
    } },
  });
  phoneDb = () => db;
  db.seed('grocery_lists', [{ id: LIST_B, family_id: OTHER, name: 'Groceries', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('grocery_items', [{ id: 'item-b', family_id: OTHER, list_id: LIST_B, name: 'Rice', created_at: '2026-01-02T00:00:00Z' }]);
  auth = { session: { user: { id: USER } }, family: familyOf(FAMILY), familyLoading: false, familyError: null, refreshFamily: vi.fn(async () => {}) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const seedFamilyA = () => {
  db.seed('grocery_lists', [{ id: LIST_A, family_id: FAMILY, name: 'Weekly shop', created_at: '2026-02-01T00:00:00Z', sort_order: 1 }]);
  db.seed('grocery_items', [
    { id: 'milk', family_id: FAMILY, list_id: LIST_A, name: 'Milk', created_at: '2026-02-02T00:00:00Z' },
    { id: 'bread', family_id: FAMILY, list_id: LIST_A, name: 'Bread', created_at: '2026-02-03T00:00:00Z', is_checked: true },
  ]);
};

describe('the default list is one operation (N8)', () => {
  it('asks the database for the family’s default list and files the item on it, inserting no list itself', async () => {
    screen(); flush(); await settle();
    expect(text(screen())).toContain('Your list is empty');
    await typeAndSubmit(screen(), 'Milk');
    expect(rpcCalls).toEqual([{ p_family_id: FAMILY, p_name: 'Groceries', p_created_by: USER }]);
    const lists = db.table('grocery_lists').filter((l) => l.family_id === FAMILY);
    expect(lists).toHaveLength(1);
    expect(db.table('grocery_items').filter((i) => i.family_id === FAMILY)).toMatchObject([{ name: 'Milk', list_id: lists[0].id }]);
    const tree = screen();
    expect(rows(tree).map((r) => r.name)).toEqual(['Milk']);
    expect(field(tree).props.value).toBe('');
  });

  it('still adds on a database without 0443, and still makes only one list', async () => {
    const legacy = createInMemorySupabase({ defaults: DEFAULTS });
    phoneDb = () => legacy;
    screen(); flush(); await settle();
    await typeAndSubmit(screen(), 'Milk');
    await typeAndSubmit(screen(), 'Eggs');
    expect(legacy.table('grocery_lists')).toHaveLength(1);
    expect(legacy.table('grocery_items').map((i) => i.name)).toEqual(['Milk', 'Eggs']);
  });

  it('runs one add for the return key and the Add button pressed before it resolved', async () => {
    screen(); flush(); await settle();
    (field(screen()).props.onChangeText as (value: string) => void)('Milk');
    const typed = screen();
    const first = (field(typed).props.onSubmitEditing as () => Promise<void>)();
    const second = (addButton(typed).props.onPress as () => Promise<void>)();
    await Promise.all([first, second]); await settle();
    expect(rpcCalls).toHaveLength(1);
    expect(db.table('grocery_items').filter((i) => i.family_id === FAMILY)).toHaveLength(1);
    expect(db.table('grocery_lists').filter((l) => l.family_id === FAMILY)).toHaveLength(1);
    expect(addButton(screen()).props.loading).toBe(false);
    expect(field(screen()).props.onSubmitEditing).toBeTypeOf('function');
  });
});

describe('a name already on the list is not added twice (N8)', () => {
  it('skips an open item under the web’s normalisation and says so, with the draft cleared', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    await typeAndSubmit(screen(), ' milks ');
    expect(db.table('grocery_items').filter((i) => i.family_id === FAMILY).map((i) => i.name)).toEqual(['Milk', 'Bread']);
    const tree = screen();
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.groceryAlreadyListed', { name: 'milks' }));
    expect(field(tree).props.value).toBe('');
    // A checked item is in the cart, not on the list: adding it again is a new line.
    await typeAndSubmit(screen(), 'bread');
    expect(db.table('grocery_items').filter((i) => i.family_id === FAMILY).map((i) => i.name)).toEqual(['Milk', 'Bread', 'bread']);
  });

  it('normalises exactly as lib/groceries/normalize-name does', () => {
    for (const name of ['Milk', 'milk  ', 'Milks', ' two   Eggs ', 'BANANAS', 'glass', '']) expect(normalizeGroceryName(name)).toBe(normalizeName(name));
  });
});

describe('a check on an item (N3, N8)', () => {
  it('that is gone is undone, said, and the list re-read — never a tick kept on nothing', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    const before = screen();
    expect(rows(before).map((r) => r.name)).toEqual(['Milk', 'Bread']);
    const milk = rows(before)[0];
    db.replace('grocery_items', db.table('grocery_items').filter((i) => i.id !== 'milk'));
    await rowPress(before, milk)!(); await settle();
    const tree = screen();
    expect(rows(tree).map((r) => r.name)).toEqual(['Bread']);
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.groceryItemGone'));
  });

  it('writes a check that lands, and undoes one the database refuses in fixed words', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    const milk = rows(screen())[0];
    await rowPress(screen(), milk)!(); await settle();
    expect(db.table('grocery_items').find((i) => i.id === 'milk')).toMatchObject({ is_checked: true });
    expect(rows(screen()).find((r) => r.id === 'milk')?.is_checked).toBe(true);
    const failing = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: Object.assign(new Error('new row violates row-level security policy for table "grocery_items"'), { code: '42501' }) }) }) }) }) }) }), rpc: db.rpc.bind(db) };
    phoneDb = () => failing as never;
    const checked = rows(screen()).find((r) => r.id === 'milk')!;
    await rowPress(screen(), checked)!(); await settle();
    const tree = screen();
    expect(rows(tree).find((r) => r.id === 'milk')?.is_checked).toBe(true);
    expect(text(tree)).toContain(t('mobileAssistant.groceryUpdateFailed'));
    expect(text(tree)).not.toContain('row-level security');
  });

  it('issues one write for two quick taps on the same row, and disables the row while it is pending', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    const before = screen();
    const milk = rows(before)[0];
    const writesBefore = db.log.filter((entry) => entry.table === 'grocery_items').length;
    const first = rowPress(before, milk)!();
    const second = (checkbox(before, milk).props.onPress as () => Promise<void>)();
    const pending = screen();
    expect(rowPress(pending, rows(pending)[0])).toBeUndefined();
    expect(checkbox(pending, rows(pending)[0]).props.disabled).toBe(true);
    await Promise.all([first, second]); await settle();
    expect(db.log.filter((entry) => entry.table === 'grocery_items').length - writesBefore).toBe(1);
    expect(db.table('grocery_items').find((i) => i.id === 'milk')).toMatchObject({ is_checked: true });
    const after = screen();
    expect(checkbox(after, rows(after).find((r) => r.id === 'milk')).props.disabled).toBe(false);
  });
});

describe('the list belongs to the family it was read for (N7, N10)', () => {
  it('hides the previous family’s items before the new read, and files an add under the new family’s list', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    expect(rows(screen()).map((r) => r.name)).toEqual(['Milk', 'Bread']);
    auth = { ...auth, family: familyOf(OTHER) };
    const switched = screen();
    expect(rows(switched)).toEqual([]);
    expect(text(switched)).not.toContain('Milk');
    expect(text(switched)).not.toContain('Your list is empty');
    // An add before the new family's list has loaded: nothing of family A's may be written to.
    (field(switched).props.onChangeText as (value: string) => void)('Eggs');
    await (addButton(screen()).props.onPress as () => Promise<void>)(); await settle();
    const eggs = db.table('grocery_items').find((i) => i.name === 'Eggs')!;
    expect(eggs).toMatchObject({ family_id: OTHER, list_id: LIST_B });
    expect(db.table('grocery_items').filter((i) => i.list_id === LIST_A).map((i) => i.name)).toEqual(['Milk', 'Bread']);
    flush(); await settle();
    expect(rows(screen()).map((r) => r.name)).toEqual(['Eggs', 'Rice']);
  });

  it('keeps the rows when a refresh fails, and says so beside them — the error used to live only in the empty state', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    expect(rows(screen()).map((r) => r.name)).toEqual(['Milk', 'Bread']);
    phoneDb = () => failingReads('JWT expired', 'PGRST301') as never;
    const onRefresh = (list(screen()).props.refreshControl as Node).props.onRefresh as () => Promise<void>;
    await onRefresh(); await settle();
    const tree = screen();
    expect(rows(tree).map((r) => r.name)).toEqual(['Milk', 'Bread']);
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.refreshFailed'));
    for (const raw of ['JWT expired', 'PGRST']) expect(text(tree)).not.toContain(raw);
    expect(text(tree)).not.toContain('Your list is empty');
  });

  it('an add that landed stays on screen when the follow-up refresh fails', async () => {
    seedFamilyA();
    screen(); flush(); await settle();
    (field(screen()).props.onChangeText as (value: string) => void)('Eggs');
    // The add's own reads (the duplicate check) and its insert reach the
    // database; every read after the insert — the follow-up refresh — fails.
    const reads = failingReads('fetch failed', '');
    let pendingInsert = true;
    const original = db.from.bind(db);
    phoneDb = () => ({
      from: (table: string) => {
        const builder = original(table);
        if (!pendingInsert) return reads.from();
        const insert = builder.insert.bind(builder);
        builder.insert = ((rowsToInsert: never) => { pendingInsert = false; return insert(rowsToInsert); }) as typeof builder.insert;
        return builder;
      },
      rpc: db.rpc.bind(db),
    }) as never;
    await (addButton(screen()).props.onPress as () => Promise<void>)(); await settle();
    expect(db.table('grocery_items').find((i) => i.name === 'Eggs')).toMatchObject({ family_id: FAMILY, list_id: LIST_A });
    const tree = screen();
    expect(rows(tree).map((r) => r.name)).toEqual(['Eggs', 'Milk', 'Bread']);
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.refreshFailed'));
    expect(field(tree).props.value).toBe('');
  });
});

describe('what is said about the list (N4, N12)', () => {
  it('names the list, counts the siblings the web shows, and says how many items are shown', async () => {
    seedFamilyA();
    db.seed('grocery_lists', [{ id: LIST_A2, family_id: FAMILY, name: 'Party', created_at: '2026-03-01T00:00:00Z', sort_order: 2 }]);
    db.seed('grocery_items', Array.from({ length: 205 }, (_, n) => ({ id: `bulk-${n}`, family_id: FAMILY, list_id: LIST_A, name: `Item ${n}`, created_at: `2026-04-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00Z`, is_checked: n % 2 === 0 })));
    screen(); flush(); await settle();
    const tree = screen();
    expect(rows(tree)).toHaveLength(200);
    expect(nodes(tree).find((n) => n.type === 'Screen')?.props.subtitle).toMatch(/^Weekly shop · \d+ to buy · \d+ in the cart$/);
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.otherListsOne'));
    expect(text(list(tree).props.ListFooterComponent)).toContain(t('mobileAssistant.showingItems', { shown: 200, total: 207 }));
  });

  it('a read that fails shows the fixed copy, not the database’s wording or an empty list', async () => {
    phoneDb = () => failingReads('permission denied for table grocery_lists', '42501') as never;
    screen(); flush(); await settle();
    const tree = screen();
    expect(text(list(tree).props.ListHeaderComponent)).toContain(t('mobileAssistant.groceryUnavailable'));
    expect(text(tree)).not.toContain('permission denied');
    expect(text(tree)).not.toContain('Your list is empty');
  });
});

describe('a family that could not be confirmed (N4)', () => {
  it('shows the failure and a retry, not "Your list is empty"', async () => {
    auth = { ...auth, family: null, familyError: t('mobileAssistant.familyUnavailable') };
    screen(); flush(); await settle();
    const tree = screen();
    expect(text(tree)).toContain(t('mobileAssistant.familyLoadFailed'));
    expect(text(tree)).not.toContain('Your list is empty');
    expect(db.log.filter((entry) => entry.table.startsWith('grocery'))).toEqual([]);
    (nodes(tree).find((n) => n.type === 'Button' && n.props.accessibilityLabel === t('mobileAssistant.retry'))!.props.onPress as () => void)();
    expect(auth.refreshFamily).toHaveBeenCalledTimes(1);
    auth = { ...auth, familyError: null, familyLoading: true };
    const loading = screen();
    expect(text(loading)).not.toContain('Your list is empty');
    expect(nodes(loading).some((n) => n.type === 'ActivityIndicator')).toBe(true);
  });
});
