// Ticking off a repeating reminder: the next one is still its author's, and a
// next one that failed to save is not reported as done.
//
// Completing a repeating reminder on the Reminders page, or through the chat
// toolbox's `complete_reminder`, marks the row completed and inserts the next
// occurrence as a new row. That row was written with `created_by` set to
// whoever ticked it. `deleteReminderAction` (and held 0479) let a teen or
// child delete a reminder they authored, so a child who ticked a parent's
// daily "Give Mia her inhaler" once could then delete the next one, and every
// one after it. The service's `completeReminder` rolls the same row forward
// and never had this; both inserts now keep the reminder's own author (none
// stays none: an unauthored reminder is a manager's to remove).
//
// On the page, a next occurrence that failed to insert still said "Reminder
// completed": the series ended there and nobody was told. A confirmed
// completion stays completed; a definite refusal of the next insert is
// reported as a partial outcome, with no restore or automatic retry.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

const state = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, reminder: {} as Record<string, unknown>,
  updates: [] as { patch: Record<string, unknown>; filters: [string, string, unknown][] }[],
  inserts: [] as Record<string, unknown>[], insertError: null as unknown,
  success: vi.fn(), error: vi.fn(), refresh: vi.fn(),
}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
}));
// The child is signed in; the reminder is a parent's.
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'child-user', role: 'child', members: [], family: { timezone: 'America/New_York' } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  data: table === 'reminder_lists' ? [] : [state.reminder], loading: false, error: null, refresh: state.refresh,
}) }));
// `run` as the real hook runs it: the work, and a throw goes to `onError`.
vi.mock('@/lib/hooks/use-action', () => ({ useAction: ({ onError }: { onError: (e: unknown) => void }) => ({
  run: async (_key: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { onError(e); } },
  isPending: () => false,
}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({
  update: (patch: Record<string, unknown>) => {
    const entry = { patch, filters: [] as [string, string, unknown][] };
    state.updates.push(entry);
    const b: Record<string, unknown> = {};
    for (const op of ['eq', 'neq']) b[op] = (col: string, value: unknown) => { entry.filters.push([op, col, value]); return b; };
    b.select = () => Promise.resolve({ data: [{ id: 'r1' }], error: null });
    return b;
  },
  insert: (row: Record<string, unknown>) => { state.inserts.push(row); return Promise.resolve({ error: state.insertError }); },
}) }) }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  usePlural: () => (key: string, count: number) => pluralize(getMessages('en-US'), 'en-US', key, count),
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => 'America/New_York',
}));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ loading: _loading, ...props }: Record<string, unknown>) => createElement('button', props) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
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
async function tickOff() {
  state.cursor = 0;
  const tree = expand(RemindersModule());
  const tick = nodes(tree).find((node) => node.props['aria-label'] === en('remindersModule.markComplete'))!;
  await (tick.props.onClick as () => Promise<void>)();
}

const parentsDailyReminder = {
  id: 'r1', family_id: 'family-1', title: 'Give Mia her inhaler', notes: null, kind: 'medication', priority: 'high',
  status: 'active', recurrence: 'daily', remind_at: '2026-10-23T12:00:00+00:00', completed_at: null,
  created_by: 'parent-user', member_id: 'member-mia', assigned_to_id: null, location_name: null, url: null,
  flagged: false, early_reminder_minutes: null, image_url: null, subtasks: [], list_id: null, tags: [],
};

beforeEach(() => {
  state.slots = []; state.updates = []; state.inserts = []; state.insertError = null;
  state.reminder = { ...parentsDailyReminder };
  state.success.mockReset(); state.error.mockReset(); state.refresh.mockReset();
});

describe('the Reminders page', () => {
  it('a child who ticks a parent\'s daily reminder does not become the author of the next one', async () => {
    await tickOff();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ remind_at: '2026-10-24T12:00:00.000Z', created_by: 'parent-user' });
  });

  it('a reminder nobody authored stays unauthored, so it is still a manager\'s to remove', async () => {
    state.reminder = { ...parentsDailyReminder, created_by: null };
    await tickOff();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].created_by).toBeNull();
  });

  it('a definite rejection of the next occurrence keeps completion and reports the partial result', async () => {
    state.insertError = { code: '42501', message: 'new row violates row-level security policy' };
    await tickOff();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch.status).toBe('completed');
    expect(state.updates[0].filters).toEqual(expect.arrayContaining([['eq', 'id', 'r1'], ['eq', 'family_id', 'family-1']]));
    expect(state.inserts).toHaveLength(1);
    expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledExactlyOnceWith(en('remindersModule.completedNextUnconfirmed'));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('a snoozed reminder whose next insert is explicitly rejected stays completed', async () => {
    state.reminder = { ...parentsDailyReminder, status: 'snoozed' };
    state.insertError = { code: '23514', message: 'new row violates check constraint' };
    await tickOff();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch.status).toBe('completed');
    expect(state.inserts).toHaveLength(1);
    expect(state.error).toHaveBeenCalledExactlyOnceWith(en('remindersModule.completedNextUnconfirmed'));
    expect(state.success).not.toHaveBeenCalled();
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});

// ── The chat toolbox's complete_reminder ───────────────────────────────────
type DbArg = Parameters<typeof buildAssistantTools>[0];
/** A client that answers a select with only the columns it asked for, as PostgREST does. */
function toolboxDb(rows: Record<string, unknown>[], inserts: Record<string, unknown>[]): DbArg {
  const make = () => {
    let op: 'select' | 'update' | 'insert' = 'select';
    let columns: string[] | null = null;
    let page = rows;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      eq: chain, ilike: chain, order: chain, limit: chain, not: chain, in: chain,
      select(cols?: string) { if (op === 'select' && cols) columns = cols.split(',').map((c) => c.trim()); return b; },
      range(from: number, to: number) { page = rows.slice(from, to + 1); return b; },
      update() { op = 'update'; return b; },
      insert(row: Record<string, unknown>) { op = 'insert'; inserts.push(row); return b; },
      then(resolve: (v: unknown) => void) {
        const project = (row: Record<string, unknown>) => columns ? Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])) : row;
        resolve(op === 'select' ? { data: page.map(project), error: null } : op === 'update' ? { data: [{ id: 'r1' }], error: null } : { error: null });
      },
    });
    return b;
  };
  return { from: () => make() } as unknown as DbArg;
}

describe('the chat toolbox', () => {
  it('a child\'s "I gave Mia her inhaler" keeps the next occurrence the parent\'s', async () => {
    const ctx: AssistantCtx = { familyId: 'family-1', userId: 'child-user', role: 'child', memberId: 'member-kid', members: [], tz: 'America/New_York' };
    const inserts: Record<string, unknown>[] = [];
    const complete = buildAssistantTools(toolboxDb([{ ...parentsDailyReminder, idempotency_key: null }], inserts), ctx).find((t) => t.name === 'complete_reminder')!;
    const res = await complete.execute({ title: 'inhaler' }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ remind_at: '2026-10-24T12:00:00.000Z', created_by: 'parent-user' });
  });
});
