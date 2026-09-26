// What a TAP on /dashboard/moments sends, driven through the real MomentsView.
//
// tests/a-moment-never-guesses-what-the-family-already-did.test.ts renders the
// page and proves the markup: no "0/5", no "need prep", disabled boxes. Markup
// cannot prove the write guard, though. The lines that keep a failed read from
// being saved are in the handlers — `toggle`'s `if (prepFailed) return` and the
// `!prepFailed &&` in front of the tick that "Add 3" and "Remind" fire on their
// own — and a static render never runs a handler. An edit that kept
// `disabled={prepFailed}` and dropped either guard would stay green there.
//
// So this suite runs the handlers (a hook-slot harness: the suite has no DOM),
// and asserts what reaches the server:
//   - while the saved ticks are unknown, NO prep save at all — not from the box,
//     not from "Add 3", not from "Remind" — while the grocery add and the
//     reminder, which the family did ask for, still happen;
//   - once they are known, each tap names ONE step and the direction the screen
//     shows, never the event's whole list (setMomentPrepDoneAction merges it into
//     what is really saved, so a stale screen cannot delete a tick).
//
// Copy is asserted as the English sentence from the real catalogue. The alert's
// key is added by this change and merged into the catalogues by the audit's
// i18n pass (scratchpad/i18n-asks/m22+m23+m24.json); until that lands, the one
// assertion on it below is RED on purpose.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const say = (key: string) => MESSAGES[key] ?? key;
const PREP_FAILED = 'We could not load which prep steps you have already ticked.';

// Saturday's soccer game: leave-by (Remind), forecast, "Pack kit, water &
// cleats" (Remind), snacks (Add 3), photos (Remind).
const EVENT = {
  id: 'evt-soccer', family_id: 'fam-1', title: 'Soccer game', category: 'sports', location: 'Riverside Park',
  starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), ends_at: null, all_day: false, description: null,
};
const PACK = 'Pack kit, water & cleats';
const SNACKS = 'Add team snacks to Grocery';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  save: vi.fn(),
  addGroceries: vi.fn(),
  removeGroceries: vi.fn(),
  remind: vi.fn(),
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
}));

vi.mock('@/app/(app)/dashboard/moment-actions', () => ({
  setMomentPrepDoneAction: state.save,
  addMomentGroceryAction: state.addGroceries,
  removeMomentGroceryAction: state.removeGroceries,
  createMomentReminderAction: state.remind,
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'fam-1', members: [] }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: [EVENT], loading: false, error: null, refresh: async () => {} }),
}));
vi.mock('@/components/moments/use-default-forecast', () => ({ useDefaultForecast: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => say,
  useLocale: () => ({ code: 'en-US' }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => createElement('a', props) }));
vi.mock('@/components/app/page-header', () => ({
  PageHeader: ({ title, description }: Record<string, ReactNode>) => createElement('header', null, title, description),
}));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, EmptyState: () => null, ErrorState: () => null }));

const { MomentsView } = await import('@/components/moments/moments-view');

type Props = NonNullable<Parameters<typeof MomentsView>[0]>;
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

let props: Props;
function render(): ReactNode {
  state.cursor = 0;
  return expand(MomentsView(props));
}
/** The tick box of the step whose label contains `label`. */
function box(label: string): Node {
  const found = nodes(render()).find((n) => n.type === 'button' && String(n.props['aria-label'] ?? '').includes(label));
  if (!found) throw new Error(`No tick box for "${label}"`);
  return found;
}
/** The row (li) holding the step `label`, and the action button in it. */
function action(label: string, name: RegExp): Node {
  const row = nodes(render()).find((n) => n.type === 'li'
    && nodes(n.props.children as ReactNode).some((c) => c.type === 'button' && String(c.props['aria-label'] ?? '').includes(label)));
  if (!row) throw new Error(`No row for "${label}"`);
  const found = nodes(row.props.children as ReactNode).find((n) => n.type === 'button' && name.test(text(n).trim()));
  if (!found) throw new Error(`No ${name} button in the "${label}" row`);
  return found;
}
async function tap(node: Node) {
  await (node.props.onClick as () => unknown)();
  // The tick "Add"/"Remind" fire is a `void toggle(...)`: let it land.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
beforeEach(() => {
  state.slots = [];
  state.cursor = 0;
  for (const fn of [state.save, state.addGroceries, state.removeGroceries, state.remind, state.success, state.error]) fn.mockReset();
  state.save.mockResolvedValue({ ok: true });
  state.addGroceries.mockResolvedValue({ ok: true, added: 3, ids: ['g1', 'g2', 'g3'] });
  state.remind.mockResolvedValue({ ok: true });
});

describe('a tap while the saved ticks could not be read', () => {
  beforeEach(() => { props = { savedTicks: null, prepFailed: true }; });

  it('the tick box is inert, and its handler saves nothing even if it runs', async () => {
    const pack = box(PACK);
    expect(pack.props.disabled, 'the box cannot be tapped').toBe(true);
    expect(pack.props['aria-pressed'], 'the box claims neither done nor not done').toBeUndefined();

    // React never delivers a click to a disabled button; the handler is run
    // directly so the guard INSIDE it is tested on its own — `disabled` must not
    // be the only thing between an unknown state and a save.
    await tap(pack);

    expect(state.save, 'no prep save on ticks we could not read').not.toHaveBeenCalled();
    // Red until the i18n merge lands (see the note at the top of this file).
    expect(state.error, 'the tap says why it did nothing').toHaveBeenCalledWith(PREP_FAILED);
  });

  it('"Add 3" puts the snacks on the list and leaves the tick alone', async () => {
    await tap(action(SNACKS, /^Add \d+$/));

    expect(state.addGroceries, 'the add the family asked for still happens').toHaveBeenCalledTimes(1);
    expect(state.success).toHaveBeenCalledTimes(1);
    expect(state.save, 'but no tick is saved on top of ticks we could not read').not.toHaveBeenCalled();
    expect(state.error, 'and a successful add raises no error toast').not.toHaveBeenCalled();
  });

  it('"Remind" sets the reminder and leaves the tick alone', async () => {
    await tap(action(PACK, /Remind/));

    expect(state.remind, 'the reminder the family asked for still happens').toHaveBeenCalledTimes(1);
    expect(state.save, 'but no tick is saved on top of ticks we could not read').not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
  });
});

describe('a tap once the saved ticks were read', () => {
  beforeEach(() => { props = { savedTicks: { 'evt-soccer': ['leave-by'] }, prepFailed: false }; });

  it('saves the one step tapped, in the direction the screen shows — never a list', async () => {
    const pack = box(PACK);
    expect(pack.props.disabled).toBe(false);
    expect(pack.props['aria-pressed']).toBe(false);

    await tap(pack);

    expect(state.save.mock.calls).toEqual([[{ eventId: 'evt-soccer', stepId: 'pack', done: true }]]);
    expect(box(PACK).props['aria-pressed'], 'the tap shows at once').toBe(true);

    await tap(box('Leave by'));
    expect(state.save.mock.calls[1]).toEqual([{ eventId: 'evt-soccer', stepId: 'leave-by', done: false }]);
  });

  it('"Add 3" ticks the shopping step it just did', async () => {
    await tap(action(SNACKS, /^Add \d+$/));

    expect(state.addGroceries).toHaveBeenCalledTimes(1);
    expect(state.save.mock.calls).toEqual([[{ eventId: 'evt-soccer', stepId: 'shop', done: true }]]);
  });

  it('"Remind" ticks the step it set a reminder for', async () => {
    await tap(action(PACK, /Remind/));

    expect(state.remind).toHaveBeenCalledTimes(1);
    expect(state.save.mock.calls).toEqual([[{ eventId: 'evt-soccer', stepId: 'pack', done: true }]]);
  });

  it('puts the box back and says so when the save fails', async () => {
    state.save.mockResolvedValue({ ok: false, error: 'canceling statement due to statement timeout' });

    await tap(box(PACK));

    expect(box(PACK).props['aria-pressed'], 'an unsaved tick does not stay ticked').toBe(false);
    expect(state.error).toHaveBeenCalledWith('canceling statement due to statement timeout');
  });
});
