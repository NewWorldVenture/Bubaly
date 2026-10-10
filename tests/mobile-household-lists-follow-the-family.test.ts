import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Chores and Grocery tabs stay mounted while the active family changes
// underneath them — the Assistant tab re-reads the family on every focus and
// every return to the foreground, so switching households on the web and
// coming back to the phone moves the whole app to the other family.
//
// Both tabs load through useAsyncData, which kept the PREVIOUS family's rows
// while the new family's read was in flight — and for good when that read
// failed, because the error only renders in the empty-list slot and the list
// was not empty. Under the new family's name the phone showed the old
// family's grocery list and chores, its toggles and Done buttons wrote to the
// old family, and Grocery's Add sent the old family's list id beside the new
// family's id. The Today tab already tags its data with the owner it was
// loaded for; these two did not.
//
// Real screens and hook, with React's hooks simulated so a render can be
// inspected before and after effects (same harness as mobile-owner-render).
const mobileRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
const resolveNative = (name: string) => { try { return mobileRequire.resolve(name); } catch { return name; } };
const slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
const hooks = {
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (update: unknown) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
  },
  useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = cursor++; const previous = slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { effects.push(effect); slots[index] = deps; }
  },
};
vi.doMock(resolveNative('react'), async () => ({ ...await vi.importActual<Record<string, unknown>>(resolveNative('react')), ...hooks }));
vi.doMock(resolveNative('react-native'), () => ({ FlatList: 'FlatList', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' },
  Pressable: 'Pressable', RefreshControl: 'RefreshControl', View: 'View' }));
vi.doMock(resolveNative('@expo/vector-icons'), () => ({ Ionicons: 'Ionicons' }));
for (const name of ['AppText', 'Button', 'EmptyState', 'Field', 'GlassCard', 'Pill', 'Screen']) {
  vi.doMock(`../mobile/src/components/${name}`, () => ({ [name]: name }));
}
vi.doMock('../mobile/src/components/ListRow', () => ({ ListRow: 'ListRow', Divider: 'Divider' }));
vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: {}, spacing: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }) }));
vi.doMock('../mobile/src/lib/supabase', () => ({ supabase: { client: 'session' } }));
const q = {
  fetchGroceryList: vi.fn(), addGroceryItem: vi.fn(), setGroceryChecked: vi.fn(),
  fetchOpenChores: vi.fn(), completeChore: vi.fn(),
};
vi.doMock('../mobile/src/lib/queries', () => q);
type Family = { familyId: string; familyName: string; timezone: string; memberId: string; role: string; displayName: string };
let auth: { family: Family | null; session: { user: { id: string } } | null };
vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => auth }));

const groceryModule = '../mobile/app/(tabs)/grocery';
const choresModule = '../mobile/app/(tabs)/chores';
const { default: GroceryScreen } = await import(groceryModule) as { default: () => unknown };
const { default: ChoresScreen } = await import(choresModule) as { default: () => unknown };

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.ListHeaderComponent), ...nodes(node.props.ListEmptyComponent)];
}
const find = (tree: unknown, type: string) => {
  const node = nodes(tree).find((n) => n.type === type);
  if (!node) throw new Error(`Missing ${type}`);
  return node;
};
const text = (tree: unknown) => JSON.stringify(nodes(tree).map((n) => typeof n.props.children === 'string' ? n.props.children : ''));
const flushEffects = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const A: Family = { familyId: 'family-a', familyName: 'Household A', timezone: 'UTC', memberId: 'member-a', role: 'parent', displayName: 'Dana' };
const B: Family = { familyId: 'family-b', familyName: 'Household B', timezone: 'UTC', memberId: 'member-b', role: 'parent', displayName: 'Dana' };
const pending = () => new Promise<never>(() => {});

beforeEach(() => {
  slots.length = 0; cursor = 0; effects = [];
  Object.values(q).forEach((fn) => fn.mockReset());
  auth = { family: A, session: { user: { id: 'user-1' } } };
});

describe('Grocery after the active family changes', () => {
  const render = () => { cursor = 0; return GroceryScreen(); };
  const loadA = async () => {
    q.fetchGroceryList.mockImplementation(async (_db: unknown, familyId: string) => {
      if (familyId === 'family-a') return { listId: 'list-a', items: [{ id: 'milk-a', name: 'Private item A', quantity: null, is_checked: false, created_at: '2026-10-01T00:00:00Z' }] };
      return pending();
    });
    render(); flushEffects(); await settle();
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ id: 'milk-a' }]);
  };

  it('does not show the previous family’s list while the new family’s list loads', async () => {
    await loadA();
    auth.family = B;
    expect(find(render(), 'FlatList').props.data).toEqual([]);
    flushEffects(); await settle();
    expect(q.fetchGroceryList).toHaveBeenLastCalledWith(expect.anything(), 'family-b');
    expect(find(render(), 'FlatList').props.data).toEqual([]);
  });

  it('does not keep the previous family’s list, and shows the error, when the new read fails', async () => {
    await loadA();
    q.fetchGroceryList.mockRejectedValue(new Error('Grocery list unavailable for B'));
    auth.family = B; render(); flushEffects(); await settle();
    const tree = render();
    expect(find(tree, 'FlatList').props.data).toEqual([]);
    expect(text(find(tree, 'FlatList').props.ListEmptyComponent)).toContain('Grocery list unavailable for B');
  });

  it('never adds to the previous family’s list', async () => {
    await loadA();
    auth.family = B; render(); flushEffects(); await settle();
    (find(render(), 'Field').props.onChangeText as (value: string) => void)('Eggs');
    void (find(render(), 'Button').props.onPress as () => Promise<void>)(); await settle();
    for (const call of q.addGroceryItem.mock.calls) expect(call[1]).not.toMatchObject({ listId: 'list-a' });
    expect(q.addGroceryItem).not.toHaveBeenCalled();
  });

  it('still adds to the current family’s own list once it has loaded', async () => {
    q.fetchGroceryList.mockResolvedValue({ listId: 'list-a', items: [] });
    q.addGroceryItem.mockResolvedValue('list-a');
    render(); flushEffects(); await settle();
    (find(render(), 'Field').props.onChangeText as (value: string) => void)('Eggs');
    await (find(render(), 'Button').props.onPress as () => Promise<void>)();
    expect(q.addGroceryItem).toHaveBeenCalledWith(expect.anything(), { familyId: 'family-a', listId: 'list-a', name: 'Eggs', userId: 'user-1' });
  });
});

describe('Chores after the active family changes', () => {
  const render = () => { cursor = 0; return ChoresScreen(); };
  it('does not offer the previous family’s chores under the new family', async () => {
    q.fetchOpenChores.mockImplementation(async (_db: unknown, familyId: string) => familyId === 'family-a'
      ? [{ id: 'chore-a', status: 'todo', due_at: null, member_id: 'member-a', chores: { title: 'Private chore A', points: 5, requires_approval: true }, family_members: { display_name: 'Sam' } }]
      : pending());
    render(); flushEffects(); await settle();
    expect(find(render(), 'FlatList').props.data).toMatchObject([{ id: 'chore-a' }]);
    auth.family = B;
    expect(find(render(), 'FlatList').props.data).toEqual([]);
    flushEffects(); await settle();
    expect(find(render(), 'FlatList').props.data).toEqual([]);
  });
});
