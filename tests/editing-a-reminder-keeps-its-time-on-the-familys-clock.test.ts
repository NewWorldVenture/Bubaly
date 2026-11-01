// Editing a reminder keeps its time, and a typed time is the family's (TIME-003).
//
// The reminders list shows `remind_at` on the family's clock, but the editor
// filled its `datetime-local` box with `remind_at.slice(0, 16)` (the stored
// UTC reading) and saved the box through `new Date(value)` (the DEVICE's
// clock). A New York family's 9:00 AM reminder opened as 13:00. Fixing a typo
// in its title saved it as 1:00 PM, four hours late, and every later edit
// moved it again. A new reminder typed on a phone in another zone was stored at
// that zone's reading, and the "pick a time in the future" check asked the
// device whether it had passed.
//
// The box is now read and written with the wall-clock helpers on the family's
// zone, as the voting, homework and trip forms do. A reading the family's
// clock does not hold is refused, and the past check uses that same instant.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';

const state = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, zone: 'America/New_York',
  update: vi.fn(), insert: vi.fn(), db: vi.fn(), success: vi.fn(), error: vi.fn(),
  form: {} as Record<string, string>,
}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1', members: [], family: { timezone: state.zone } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  // 9:00 AM in New York on 23 October 2026 (EDT, UTC-4), in PostgREST's text form.
  data: table === 'reminder_lists' ? [] : [{ id: 'r1', title: 'Take the morning pills', family_id: 'family-1', kind: 'medication', status: 'active', priority: 'medium', recurrence: 'none', remind_at: '2026-10-23T13:00:00+00:00', tags: [] }],
  loading: false, error: null, refresh: vi.fn(),
}) }));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ run: vi.fn(), isPending: () => false }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: state.db }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  usePlural: () => (key: string, count: number) => pluralize(getMessages('en-US'), 'en-US', key, count),
  useLocale: () => ({ code: 'en-US' }),
  // The family's zone, which the list already formats in.
  useFamilyTimeZone: () => state.zone,
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

function openEditor(): ReactNode {
  const edit = nodes(render()).find((node) => node.props['aria-label'] === en('reminders.editReminder'))!;
  (edit.props.onClick as () => void)();
  return render();
}
function openNew(): ReactNode {
  const add = nodes(render()).find((node) => node.type === 'button' && JSON.stringify(node.props.children ?? '').includes(en('reminders.newReminder')))!;
  (add.props.onClick as () => void)();
  return render();
}
function timeBox(tree: ReactNode): Node {
  return nodes(tree).find((node) => node.type === 'input' && node.props.name === 'remind_at')!;
}
async function submit(tree: ReactNode, form: Record<string, string>) {
  state.form = form;
  const el = nodes(tree).find((node) => node.type === 'form')!;
  await (el.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: () => {}, currentTarget: {} });
}

beforeEach(() => {
  state.slots = []; state.zone = 'America/New_York';
  state.update.mockReset(); state.insert.mockReset(); state.success.mockReset(); state.error.mockReset();
  const builder: Record<string, unknown> = {};
  builder.eq = () => builder;
  builder.select = () => Promise.resolve({ data: [{ id: 'r1' }], error: null });
  state.update.mockReturnValue(builder);
  state.insert.mockReturnValue({ select: () => Promise.resolve({ data: [{ id: 'r2' }], error: null }) });
  state.db.mockReturnValue({ from: () => ({ update: state.update, insert: state.insert }) });
  vi.stubGlobal('FormData', class { get(key: string) { return state.form[key] ?? null; } });
  // 10:00 AM in New York; 11:00 PM in Tokyo.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T14:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the reminder editor reads and writes the family clock', () => {
  it('opens a 9:00 AM New York reminder at 09:00, not at its UTC reading', () => {
    expect(timeBox(openEditor()).props.defaultValue).toBe('2026-10-23T09:00');
  });

  it('saving a title fix with the time untouched keeps the reminder at 9:00 AM, on a phone at home in New York', async () => {
    // The ordinary case: the device is in the family's own zone. (On a UTC
    // host the two wrong readings cancel out, which is how this hid.)
    const hostZone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const tree = openEditor();
      await submit(tree, { title: 'Take the morning pills (with food)', remind_at: String(timeBox(tree).props.defaultValue) });
    } finally {
      process.env.TZ = hostZone;
    }
    expect(state.error).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ remind_at: '2026-10-23T13:00:00.000Z' }));
  });

  it('a new 8:00 PM reminder is 8:00 PM in the family\'s zone, whatever the device\'s', async () => {
    await submit(openNew(), { title: 'Bins out', remind_at: '2026-10-23T20:00' });
    expect(state.error).not.toHaveBeenCalled();
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ remind_at: '2026-10-24T00:00:00.000Z' }));
  });

  it('a time already past on the family\'s clock is refused, though it is ahead on the device\'s', async () => {
    state.zone = 'Asia/Tokyo'; // 11:00 PM there; 8:00 PM has gone
    await submit(openNew(), { title: 'Call grandma', remind_at: '2026-10-23T20:00' });
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(en('remindersModule.pickATimeInThe'));
  });

  it('a date the calendar does not have is refused, not rolled into March', async () => {
    await submit(openNew(), { title: 'Pay rent', remind_at: '2027-02-30T09:00' });
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(en('errors.thatTimeIsNotOnTheFamilysClock'));
  });
});
