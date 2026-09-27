import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphModule } from '@/components/modules/graph-module';
import type { Tables } from '@/lib/database.types';

// The Knowledge Graph screen used to lie about its own writes.
//
// `graph_entities` and `graph_edges` are NOT in the realtime publication
// (lib/realtime/published-tables.ts — REALTIME_TABLES lists neither, and
// `realtimeChannelFor` returns null for them, so useRealtimeQuery deliberately
// opens no socket). Nothing pushes a new graph row to a mounted client.
//
// "Rebuild from data" nevertheless ran the twin projector — which upserts
// entities, DELETES the pruned ones and upserts edges — and then went straight
// to `success('Twin synced — N entities, M links from your data')` with no
// refetch of any kind (no refresh, no setData, no router.refresh). So a family
// was told 42 entities existed while the list beside the toast still showed the
// pre-click graph, or, on a first run, still showed "Build your family's graph"
// with nothing in it. The two hand-add paths had the same hole.
//
// The pruning half is what makes it more than cosmetic: AddEdgeModal is fed
// `entities={graph.entities}` from that stale list, so picking a node the
// rebuild had just deleted inserted a graph_edges row pointing at a dead
// graph_entities id, which the foreign key in 0129_family_graph.sql rejects —
// a database error out of a dropdown the app itself offered.
//
// These tests drive the real component through a hook-slot harness (this suite
// has no DOM) and assert what a parent would see on the screen, not that some
// function was called.
//
// Copy goes through the REAL en-US catalogue with production's own lookup
// (`messages[key] ?? key`), and every assertion names the English sentence, so
// a key that is missing from the catalogue renders as its key and fails here.
// The two "…ButNotOnScreen" sentences are new with this fix and are merged into
// the catalogues centrally: until that merge lands, the three tests that assert
// them are red — on purpose, because a parent would otherwise read a key name.

type Entity = Tables<'graph_entities'>;
type Edge = Tables<'graph_edges'>;
type Table = 'graph_entities' | 'graph_edges';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  familyId: 'family-1',
  userId: 'user-1',
  // The database, and the rows this screen currently has in hand. The two only
  // agree after the component reads back.
  db: { graph_entities: [] as unknown[], graph_edges: [] as unknown[] },
  rows: { graph_entities: [] as unknown[], graph_edges: [] as unknown[] },
  // Each table's read error, as the hook exposes it; a failed read sets it and
  // a good one clears it, exactly like use-realtime-query.ts's refresh.
  errors: { graph_entities: null as string | null, graph_edges: null as string | null },
  failing: [] as string[],
  gate: null as Promise<void> | null,
  confirms: [] as string[],
  project: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => {
      state.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(state.slots[index]) : value;
    }];
  },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = { current: initial };
    return state.slots[index] as { current: unknown };
  },
}));

vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: ({ table }: { table: Table }) => ({
    data: state.rows[table],
    loading: false,
    error: state.errors[table],
    stale: state.errors[table] !== null,
    updatedAt: 0,
    refresh: async () => { state.rows[table] = [...state.db[table]]; state.errors[table] = null; },
    // Mirrors the real primitive (lib/hooks/use-realtime-query.ts refresh +
    // refreshAndConfirm): a confirmed read hands over the committed rows and
    // clears the error; a failed one keeps the rows it had, sets `error`, and
    // confirms nothing.
    refreshAndConfirm: async () => {
      state.confirms.push(table);
      if (state.gate) await state.gate;
      if (state.failing.includes(table)) {
        state.errors[table] = 'Could not load data. Please try again.';
        return { ok: false as const, reason: 'error' as const, error: state.errors[table] };
      }
      state.rows[table] = [...state.db[table]];
      state.errors[table] = null;
      return { ok: true as const };
    },
    setData: () => {},
  }),
}));

vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: state.familyId, userId: state.userId }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/app/(app)/dashboard/graph/twin-actions', () => ({ projectTwinAction: state.project }));
// The modals' own insert: the row lands in the database, not on the screen —
// only a read-back moves it from `db` to `rows`.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: Table) => ({
      insert: async (row: Record<string, unknown>) => {
        state.db[table] = [...state.db[table], { id: `new-${state.db[table].length}`, ...row }];
        return { error: null };
      },
    }),
  }),
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/components/app/page-header', () => ({
  PageHeader: ({ title, description, action }: Record<string, ReactNode>) => createElement('header', null, title, description, action),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ loading: _loading, variant: _variant, ...props }: Record<string, unknown>) => createElement('button', props),
}));
vi.mock('@/components/ui/states', () => ({
  SkeletonList: () => null,
  ErrorState: ({ message }: Record<string, ReactNode>) => createElement('div', null, message),
}));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: Record<string, ReactNode>) => createElement('div', null, children) }));
vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props),
  Select: (props: Record<string, unknown>) => createElement('select', props),
  Field: ({ label, children }: Record<string, unknown>) => createElement('label', null, label as ReactNode,
    typeof children === 'function' ? (children as (id: string) => ReactNode)('field') : (children as ReactNode)),
}));

type Node = ReactElement<Record<string, unknown>>;

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === 'function') return expand((node.type as (props: unknown) => ReactNode)(node.props));
  return createElement(node.type, { ...node.props, key: node.key }, expand(node.props.children as ReactNode));
}
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
/** The whole screen, every component expanded — what the family looks at. */
function render(): ReactNode {
  state.cursor = 0;
  return expand(createElement(GraphModule));
}
function button(tree: ReactNode, label: string): Node {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === label);
  if (!found) throw new Error(`Missing button "${label}"`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => Promise<void> | void)();
/** Let an un-awaited write run up to the (gated) read-back it is waiting on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Names in the left-hand entity list — the panel a parent reads. */
function listed(tree: ReactNode): string[] {
  const box = nodes(tree).find((node) => typeof node.props.className === 'string' && node.props.className.includes('max-h-80'));
  if (!box) return [];
  return nodes(box.props.children as ReactNode)
    .filter((node) => node.type === 'button')
    .map((node) => text((node.props.children as ReactNode[])[0]).trim());
}
/** The entities the From picker offers — the same list AddEdgeModal is fed. */
function offered(tree: ReactNode): { id: string; name: string }[] {
  const select = nodes(tree).find((node) => node.type === 'select');
  if (!select) return [];
  return nodes(select.props.children as ReactNode)
    .filter((node) => node.type === 'option' && node.props.value !== '')
    .map((node) => ({ id: String(node.props.value), name: text(node).trim() }));
}
/** The open modal's form. */
function form(tree: ReactNode): Node {
  const found = nodes(tree).find((node) => node.type === 'form');
  if (!found) throw new Error('No modal is open');
  return found;
}
const isOpen = (tree: ReactNode) => nodes(tree).some((node) => node.type === 'form');
/** The n-th field of that kind in the open modal. */
function field(tree: ReactNode, kind: 'input' | 'select', n: number): Node {
  const found = nodes(form(tree).props.children as ReactNode).filter((node) => node.type === kind)[n];
  if (!found) throw new Error(`No ${kind} #${n} in the open modal`);
  return found;
}
/** Type into, or pick from, the n-th field of that kind in the open modal. */
function fill(kind: 'input' | 'select', n: number, value: string) {
  (field(render(), kind, n).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
/** Submit the open modal, as its Add/Link button would. */
const submit = () => (form(render()).props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });

const COULD_NOT_LOAD = 'Could not load the knowledge graph. Refresh and try again.';
// New copy, merged into the catalogues centrally (see the note at the top).
const REBUILT_BUT_NOT_ON_SCREEN = 'Your graph was rebuilt, but this screen could not load the new version. Refresh the page to see it.';
const SAVED_BUT_NOT_ON_SCREEN = 'Saved, but this screen could not load the new version. Refresh the page to see it.';

function entity(id: string, name: string): Entity {
  return {
    id, family_id: 'family-1', kind: 'person', name, ref_table: 'family_members', ref_id: `${id}-ref`,
    attributes: {}, created_by: 'user-1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  } as Entity;
}
function edge(id: string, sourceId: string, targetId: string): Edge {
  return {
    id, family_id: 'family-1', source_id: sourceId, target_id: targetId, relation: 'plays', weight: 0.8,
    attributes: {}, created_by: 'user-1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  } as Edge;
}
/** Seed what the screen already had in hand before the click under test. */
function seed(entities: Entity[], edges: Edge[] = []) {
  state.db = { graph_entities: [...entities], graph_edges: [...edges] };
  state.rows = { graph_entities: [...entities], graph_edges: [...edges] };
}

beforeEach(() => {
  state.slots = []; state.cursor = 0;
  state.familyId = 'family-1'; state.userId = 'user-1';
  seed([], []);
  state.errors = { graph_entities: null, graph_edges: null }; state.failing = [];
  state.gate = null; state.confirms = [];
  state.project.mockReset(); state.success.mockReset(); state.error.mockReset();
});

describe('a rebuilt graph is on screen before the toast says so', () => {
  it('a first rebuild replaces the empty state with the entities it just claimed', async () => {
    state.project.mockImplementation(async () => {
      state.db.graph_entities = [entity('e1', 'Emma'), entity('e2', 'Soccer')];
      state.db.graph_edges = [edge('x1', 'e1', 'e2')];
      return { ok: true, entities: 2, edges: 1 };
    });

    const before = render();
    expect(text(before)).toContain("Build your family's graph");
    expect(listed(before)).toEqual([]);

    await click(button(before, 'Rebuild from data'));

    const after = render();
    // The outcome: what the toast promises is what the screen shows.
    expect(state.success).toHaveBeenCalledWith('Twin synced — 2 entities, 1 links from your data');
    expect(listed(after)).toEqual(['Emma', 'Soccer']);
    expect(text(after)).not.toContain("Build your family's graph");
    expect(state.error).not.toHaveBeenCalled();
  });

  it('a node the rebuild pruned stops being listed and stops being offered as a link end', async () => {
    seed([entity('old', 'Old Car'), entity('e1', 'Emma')]);
    state.project.mockImplementation(async () => {
      // What lib/twin/project-server.ts does: upsert the current world, then
      // DELETE the nodes that are no longer part of it.
      state.db.graph_entities = [entity('e1', 'Emma'), entity('e3', 'New Car')];
      return { ok: true, entities: 2, edges: 0 };
    });

    const before = render();
    expect(listed(before)).toContain('Old Car');
    expect(offered(before).map((o) => o.id)).toContain('old');

    await click(button(before, 'Rebuild from data'));

    const after = render();
    expect(listed(after)).toEqual(['Emma', 'New Car']);
    // The FK hazard: no picker may still name a deleted graph_entities id.
    expect(offered(after)).toEqual([{ id: 'e1', name: 'Emma' }, { id: 'e3', name: 'New Car' }]);
  });

  it('says the screen is stale instead of "Twin synced" when the read-back fails', async () => {
    seed([entity('e1', 'Emma')]);
    state.project.mockImplementation(async () => {
      state.db.graph_entities = [entity('e1', 'Emma'), entity('e2', 'Soccer')];
      return { ok: true, entities: 2, edges: 0 };
    });
    state.failing = ['graph_entities', 'graph_edges'];

    await click(button(render(), 'Rebuild from data'));

    const after = render();
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(REBUILT_BUT_NOT_ON_SCREEN);
    // Fail closed: the panel says it could not read rather than showing the
    // pre-rebuild list as if it were current.
    expect(text(after)).toContain(COULD_NOT_LOAD);
    expect(text(after)).not.toContain('Soccer');
    expect(state.confirms).toEqual(['graph_entities', 'graph_edges']);
  });

  it('keeps the button on "Syncing…" until the new rows are actually in hand', async () => {
    let openGate: () => void = () => {};
    state.gate = new Promise<void>((resolve) => { openGate = resolve; });
    state.project.mockImplementation(async () => {
      state.db.graph_entities = [entity('e1', 'Emma')];
      return { ok: true, entities: 1, edges: 0 };
    });

    const pending = click(button(render(), 'Rebuild from data'));
    await settle();

    // Projection done, read-back in flight: nothing claimed, nothing shown yet.
    const midway = render();
    expect(button(midway, 'Syncing…').props.disabled).toBe(true);
    expect(listed(midway)).toEqual([]);
    expect(state.success).not.toHaveBeenCalled();

    openGate();
    await pending;

    const after = render();
    expect(button(after, 'Rebuild from data').props.disabled).toBe(false);
    expect(listed(after)).toEqual(['Emma']);
    expect(state.success).toHaveBeenCalledWith('Twin synced — 1 entities, 0 links from your data');
  });

  it('a hand-added entity keeps its modal on "Adding…" until it is in the list, then closes and says so', async () => {
    seed([entity('e1', 'Emma')]);
    let openGate: () => void = () => {};
    state.gate = new Promise<void>((resolve) => { openGate = resolve; });
    click(button(render(), 'Entity'));
    fill('input', 0, 'Grandma');

    const pending = submit();
    await settle();

    // Inserted, read-back in flight: the same rule as "Syncing…" — the control
    // that did the write is still visibly busy, the list has not moved yet, and
    // nothing has been claimed.
    const midway = render();
    expect(state.db.graph_entities).toHaveLength(2);
    expect(button(form(midway), 'Adding…').props.disabled).toBe(true);
    expect(listed(midway)).toEqual(['Emma']);
    expect(state.success).not.toHaveBeenCalled();

    openGate();
    await pending;

    const after = render();
    expect(isOpen(after)).toBe(false);
    expect(listed(after)).toEqual(['Emma', 'Grandma']);
    expect(state.success).toHaveBeenCalledWith('Added Grandma');
    expect(state.error).not.toHaveBeenCalled();
  });

  it('a hand-added link keeps its modal on "Linking…" until it shows in the hub counts', async () => {
    seed([entity('e1', 'Emma'), entity('e2', 'Soccer')]);
    let openGate: () => void = () => {};
    state.gate = new Promise<void>((resolve) => { openGate = resolve; });
    click(button(render(), 'Link'));
    // "Household hubs" only renders once something has a link, so its arrival is
    // proof the new edge reached the screen.
    expect(text(render())).not.toContain('Household hubs');
    fill('select', 0, 'e1');
    fill('input', 0, 'plays');
    fill('select', 1, 'e2');

    const pending = submit();
    await settle();

    const midway = render();
    expect(state.db.graph_edges).toHaveLength(1);
    expect(button(form(midway), 'Linking…').props.disabled).toBe(true);
    expect(text(midway)).not.toContain('Household hubs');
    expect(state.success).not.toHaveBeenCalled();

    openGate();
    await pending;

    const after = render();
    expect(isOpen(after)).toBe(false);
    expect(text(after)).toContain('Household hubs');
    expect(text(after)).toContain('1 links');
    expect(state.success).toHaveBeenCalledWith('Linked');
  });

  it('says the screen is stale instead of "Added" when a hand-add cannot be read back', async () => {
    seed([entity('e1', 'Emma')]);
    click(button(render(), 'Entity'));
    fill('input', 0, 'Grandma');
    state.failing = ['graph_entities', 'graph_edges'];

    await submit();

    const after = render();
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(SAVED_BUT_NOT_ON_SCREEN);
    // The row exists, so the modal closes rather than re-arming "Add" over it.
    expect(isOpen(after)).toBe(false);
    expect(text(after)).toContain(COULD_NOT_LOAD);
    expect(listed(after)).toEqual([]);
  });

  // Why a write to ONE table reads back BOTH. The entity list renders only
  // while the entity read and the link read are both healthy, so an entity is
  // on screen only when both confirm.
  it('an entity whose own read confirmed is still not on screen while the link read fails, and "Added" is not said', async () => {
    seed([entity('e1', 'Emma')]);
    click(button(render(), 'Entity'));
    fill('input', 0, 'Grandma');
    state.failing = ['graph_edges'];

    await submit();

    const after = render();
    expect(state.confirms).toEqual(['graph_entities', 'graph_edges']);
    expect(listed(after)).toEqual([]);
    expect(text(after)).toContain(COULD_NOT_LOAD);
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(SAVED_BUT_NOT_ON_SCREEN);
  });

  it('an entity added over a failed link read re-reads the links too, so "Added" is said over the list, not over an error', async () => {
    seed([entity('e1', 'Emma')]);
    // An earlier link read failed: the panel is an error, not a list.
    state.errors.graph_edges = 'Could not load data. Please try again.';
    expect(text(render())).toContain(COULD_NOT_LOAD);

    click(button(render(), 'Entity'));
    fill('input', 0, 'Grandma');
    await submit();

    // Reading back only graph_entities would leave the error panel up and
    // still announce "Added Grandma" beside it.
    const after = render();
    expect(listed(after)).toEqual(['Emma', 'Grandma']);
    expect(state.success).toHaveBeenCalledWith('Added Grandma');
  });

  // Cancel stays live while "Adding…"/"Linking…" — a read-back settles only when
  // its network round trip does, and a parent must not be trapped behind one
  // that stalls. So the read-back that eventually returns may find a DIFFERENT
  // opening of the modal on screen. It must not close that one: the parent
  // would lose what they had typed into it. The write it reads back still
  // landed, so it is still reported, and the list beside them still moves.
  it('a read-back the parent cancelled out of does not close the modal they opened next', async () => {
    seed([entity('e1', 'Emma')]);
    let openGate: () => void = () => {};
    state.gate = new Promise<void>((resolve) => { openGate = resolve; });
    click(button(render(), 'Entity'));
    fill('input', 0, 'Grandma');
    const pending = submit();
    await settle();

    // Cancel mid-read-back, open a fresh modal, start a second entity.
    click(button(form(render()), 'Cancel'));
    expect(isOpen(render())).toBe(false);
    click(button(render(), 'Entity'));
    fill('input', 0, 'Uncle');

    openGate();
    await pending;

    // The first write landed and is said; the second modal is left alone.
    const after = render();
    expect(isOpen(after)).toBe(true);
    expect(field(after, 'input', 0).props.value).toBe('Uncle');
    expect(listed(after)).toEqual(['Emma', 'Grandma']);
    expect(state.success).toHaveBeenCalledWith('Added Grandma');
    expect(state.error).not.toHaveBeenCalled();

    // And that second modal is still a working one: its own read-back closes it.
    state.gate = null;
    await submit();
    const done = render();
    expect(isOpen(done)).toBe(false);
    expect(listed(done)).toEqual(['Emma', 'Grandma', 'Uncle']);
    expect(state.success).toHaveBeenLastCalledWith('Added Uncle');
  });

  it('the same for a link: a cancelled "Linking…" read-back leaves the next link modal open', async () => {
    seed([entity('e1', 'Emma'), entity('e2', 'Soccer'), entity('e3', 'Piano')]);
    let openGate: () => void = () => {};
    state.gate = new Promise<void>((resolve) => { openGate = resolve; });
    click(button(render(), 'Link'));
    fill('select', 0, 'e1');
    fill('input', 0, 'plays');
    fill('select', 1, 'e2');
    const pending = submit();
    await settle();

    click(button(form(render()), 'Cancel'));
    expect(isOpen(render())).toBe(false);
    click(button(render(), 'Link'));
    fill('input', 0, 'learns');
    fill('select', 1, 'e3');

    openGate();
    await pending;

    const after = render();
    expect(isOpen(after)).toBe(true);
    expect(field(after, 'input', 0).props.value).toBe('learns');
    // The first link reached the screen: the hubs panel now has something to show.
    expect(text(after)).toContain('Household hubs');
    expect(state.success).toHaveBeenCalledWith('Linked');
    expect(state.error).not.toHaveBeenCalled();
  });
});
