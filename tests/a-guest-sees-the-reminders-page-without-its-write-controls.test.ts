// A guest's Reminders page offers no write controls.
//
// The actions and services now refuse a guest's reminder writes
// (tests/a-guest-views-the-familys-reminders-and-changes-none). The page still
// offered a guest Quick add, New reminder, the tick, snooze, edit and delete
// on every row, and the editor and the tick write family_reminders straight
// from the browser, where RLS lets any member through. So the page now hides
// them for a guest, as the to-dos page does; every other role keeps them.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, role: 'guest', empty: false }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1', role: state.role, members: [], family: { timezone: 'UTC' } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  data: table === 'reminder_lists' ? [{ id: 'list-1', family_id: 'family-1', name: 'Medicines', sort_order: 0 }] : state.empty ? [] : [
    { id: 'r1', title: 'Give Mia her inhaler', family_id: 'family-1', kind: 'medication', status: 'active', priority: 'high', recurrence: 'daily', remind_at: '2026-10-24T12:00:00Z', tags: [], list_id: 'list-1',
      subtasks: [{ id: 's1', title: 'Shake it first', done: false }] },
  ],
  loading: false, error: null, refresh: vi.fn(),
}) }));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ run: vi.fn(), isPending: () => false }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  usePlural: () => (key: string, count: number) => pluralize(getMessages('en-US'), 'en-US', key, count),
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => 'UTC',
}));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ loading: _loading, ...props }: Record<string, unknown>) => createElement('button', props) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: ({ action }: { action?: ReactNode }) => createElement('header', null, action) }));
vi.mock('@/components/ui/input', () => ({ Input: (props: Record<string, unknown>) => createElement('input', props), Textarea: (props: Record<string, unknown>) => createElement('textarea', props),
  Field: ({ children }: { children: ReactNode | ((id: string) => ReactNode) }) => createElement('label', null, typeof children === 'function' ? children('field') : children) }));

const { RemindersModule } = await import('@/components/modules/reminders-module');
const en = (key: string) => translate(getMessages('en-US'), key);

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
function render() { state.cursor = 0; return expand(RemindersModule()); }
const text = (node: Node) => JSON.stringify(node.props.children ?? '');

/** Every control on the page that would write a reminder, by what it says. */
function writeControls(tree: ReactNode) {
  const all = nodes(tree);
  const labelled = (key: string) => all.some((n) => n.props['aria-label'] === en(key));
  const button = (key: string) => all.some((n) => n.type === 'button' && text(n).includes(en(key)));
  return {
    newReminder: button('reminders.newReminder'),
    quickAdd: button('reminders.quickAdd'),
    tick: labelled('remindersModule.markComplete'),
    snooze: labelled('reminders.snoozeReminder'),
    edit: labelled('reminders.editReminder'),
    remove: labelled('reminders.deleteReminder'),
    subtask: all.some((n) => n.type === 'button' && text(n).includes('Shake it first') && !n.props.disabled),
    removeList: labelled('reminders.deleteList'),
  };
}
const NONE = { newReminder: false, quickAdd: false, tick: false, snooze: false, edit: false, remove: false, subtask: false, removeList: false };

/** Open the row's subtasks and pick the list in the list filter, as a reader may. */
function browse(): ReactNode {
  let tree = render();
  const open = nodes(tree).find((n) => n.props['aria-expanded'] === false)!;
  (open.props.onClick as () => void)(); tree = render();
  const listFilter = nodes(tree).find((n) => n.type === 'select' && n.props['aria-label'] === en('reminders.list'))!;
  (listFilter.props.onChange as (e: unknown) => void)({ target: { value: 'list-1' } });
  return render();
}

beforeEach(() => { state.slots = []; state.empty = false; });

describe('the Reminders page', () => {
  it('shows a guest the reminders and no control that writes one', () => {
    state.role = 'guest';
    const tree = browse();
    expect(JSON.stringify(tree)).toContain('Give Mia her inhaler');
    expect(JSON.stringify(tree)).toContain('Shake it first');
    expect(writeControls(tree)).toEqual(NONE);
  });

  it('offers a guest no "Add reminder" on an empty page', () => {
    state.role = 'guest'; state.empty = true;
    expect(nodes(render()).some((n) => n.type === 'button' && text(n).includes(en('reminders.addReminder')))).toBe(false);
    state.role = 'teen'; state.slots = [];
    expect(nodes(render()).some((n) => n.type === 'button' && text(n).includes(en('reminders.addReminder')))).toBe(true);
  });

  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('keeps every control for a %s', (role) => {
    state.role = role;
    expect(Object.values(writeControls(browse())).every(Boolean)).toBe(true);
  });
});
