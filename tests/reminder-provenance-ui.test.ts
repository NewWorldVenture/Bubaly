import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RemindersModule } from '@/components/modules/reminders-module';
import { withReminderProvenance, visibleReminderTags } from '@/lib/reminders/provenance';
import { getMessages, translate } from '@/lib/i18n/messages';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, tags: [] as string[], update: vi.fn(), db: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1', members: [] }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  data: table === 'reminder_lists' ? [] : [{ id: 'r1', title: 'A saved reminder', family_id: 'family-1', kind: 'time', status: 'active', priority: 'medium', recurrence: 'none', remind_at: '2026-09-12T09:00:00Z', tags: state.tags }],
  loading: false, error: null, refresh: vi.fn(),
}) }));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ run: vi.fn(), isPending: () => false }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: state.db }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => translate(getMessages('en-US'), key) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ loading: _loading, ...props }: Record<string, unknown>) => createElement('button', props) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: (props: Record<string, unknown>) => createElement('input', props), Textarea: (props: Record<string, unknown>) => createElement('textarea', props),
  Field: ({ children }: { children: ReactNode | ((id: string) => ReactNode) }) => createElement('label', null, typeof children === 'function' ? children('field') : children) }));

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
const fingerprint = `autopilot-source:${'a'.repeat(64)}`;
function render() { state.cursor = 0; return expand(RemindersModule()); }
beforeEach(() => {
  state.slots = []; state.tags = ['school', fingerprint]; state.update.mockReset();
  state.update.mockReturnValue({ eq: () => Promise.resolve({ error: null }) }); state.db.mockReturnValue({ from: () => ({ update: state.update }) });
});

it('hides internal provenance from row/filter chips and the editable tag list, and retains it on an actual edit submission', async () => {
  let tree = render();
  expect(JSON.stringify(tree)).toContain('school'); expect(JSON.stringify(tree)).not.toContain(fingerprint);
  const edit = nodes(tree).find((node) => node.props['aria-label'] === translate(getMessages('en-US'), 'reminders.editReminder'))!;
  (edit.props.onClick as () => void)(); tree = render();
  expect(JSON.stringify(tree)).not.toContain(fingerprint);
  // Remove the ordinary tag in the real editor, leaving the reserved receipt intact.
  const remove = nodes(tree).find((node) => node.props['aria-label'] === 'Remove school')!;
  (remove.props.onClick as () => void)(); tree = render();
  vi.stubGlobal('FormData', class { get(key: string) { return ({ title: 'Edited reminder', remind_at: '2026-09-12T10:00:00Z' } as Record<string, string>)[key] ?? null; } });
  const form = nodes(tree).find((node) => node.type === 'form')!;
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: () => {}, currentTarget: {} });
  expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edited reminder', tags: [fingerprint] }));
  vi.unstubAllGlobals();
});

it('reserves only a full fingerprint and never introduces one from an ordinary tag edit', () => {
  expect(visibleReminderTags(['autopilot-source:notes', 'home', fingerprint])).toEqual(['autopilot-source:notes', 'home']);
  expect(withReminderProvenance(['home', fingerprint], ['new', `autopilot-source:${'b'.repeat(64)}`])).toEqual(['new', fingerprint]);
});
