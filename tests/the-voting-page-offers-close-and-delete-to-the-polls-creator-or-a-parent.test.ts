// The Group Voting page offers Close, Reopen and delete only to the poll's
// creator or a parent or another adult, and runs them through the checked
// server actions (tests/a-poll-is-closed-or-removed-by-its-creator-or-a-parent).
//
// It used to show all three on every poll to every member and write
// family_polls straight from the browser, so a child could close or delete the
// parent's poll from this page.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';

const state = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, role: 'child', userId: 'user-kid',
  setStatus: vi.fn(async (id: string, status: string) => ({ ok: true, id, status, closesAt: null })),
  remove: vi.fn(async (id: string) => ({ ok: true, id })),
  clientWrites: [] as string[],
}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({
  familyId: 'family-1', userId: state.userId, role: state.role, members: [],
  selfMember: { id: `member-${state.userId}`, family_id: 'family-1' },
}) }));
const POLLS = [
  { id: 'poll-parent', family_id: 'family-1', question: 'Where this summer?', description: null, kind: 'single', status: 'open', closes_at: null, created_by: 'user-parent', vacation_id: null, decision_category: 'general', budget_cents: null, required_tags: [], created_at: '2026-10-20T00:00:00Z' },
  { id: 'poll-kid', family_id: 'family-1', question: 'Movie night pick?', description: null, kind: 'single', status: 'open', closes_at: null, created_by: 'user-kid', vacation_id: null, decision_category: 'general', budget_cents: null, required_tags: [], created_at: '2026-10-21T00:00:00Z' },
];
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  data: table === 'family_polls' ? POLLS : [], loading: false, error: null, refresh: vi.fn(),
}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  const b: Record<string, unknown> = {};
  for (const op of ['update', 'delete', 'insert']) b[op] = () => { state.clientWrites.push(`${op}:${table}`); return b; };
  for (const op of ['eq', 'select']) b[op] = () => b;
  b.then = (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'x', status: 'closed', closes_at: null }], error: null });
  return b;
} }) }));
vi.mock('@/app/(app)/dashboard/voting/actions', () => ({ setPollStatusAction: state.setStatus, deletePollAction: state.remove }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => 'UTC',
}));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ai/why-this', () => ({ WhyThis: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ loading: _loading, ...props }: Record<string, unknown>) => createElement('button', props) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, ErrorState: () => null, EmptyState: () => null }));
vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props), Textarea: (props: Record<string, unknown>) => createElement('textarea', props),
  Select: (props: Record<string, unknown>) => createElement('select', props),
  Field: ({ children }: { children: ReactNode | ((id: string) => ReactNode) }) => createElement('label', null, typeof children === 'function' ? children('field') : children),
}));

const { VotingModule } = await import('@/components/modules/voting-module');
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
function render() { state.cursor = 0; return expand(VotingModule()); }

/** The poll card for a question, and the run controls inside it. */
function controls(question: string) {
  const card = nodes(render()).find((n) => n.type === 'div' && n.key === POLLS.find((p) => p.question === question)!.id)!;
  const inside = nodes(card);
  return {
    close: inside.find((n) => n.type === 'button' && n.props.children === 'Close'),
    remove: inside.find((n) => n.props['aria-label'] === en('voting.delete')),
  };
}

beforeEach(() => {
  state.slots = []; state.clientWrites = [];
  state.setStatus.mockClear(); state.remove.mockClear();
  vi.stubGlobal('confirm', () => true);
});

describe('who is offered Close and delete', () => {
  it('a child is not offered them on a parent\'s poll', () => {
    state.role = 'child'; state.userId = 'user-kid';
    expect(controls('Where this summer?')).toEqual({ close: undefined, remove: undefined });
  });

  it.each(['teen', 'caregiver', 'guest'])('nor is a %s', (role) => {
    state.role = role; state.userId = 'user-someone';
    expect(controls('Where this summer?')).toEqual({ close: undefined, remove: undefined });
    expect(controls('Movie night pick?')).toEqual({ close: undefined, remove: undefined });
  });

  it('a child closes and deletes the poll they asked, through the checked actions', async () => {
    state.role = 'child'; state.userId = 'user-kid';
    const { close, remove } = controls('Movie night pick?');
    await (close!.props.onClick as () => Promise<void>)();
    expect(state.setStatus).toHaveBeenCalledWith('poll-kid', 'closed');
    await (remove!.props.onClick as () => Promise<void>)();
    expect(state.remove).toHaveBeenCalledWith('poll-kid');
    expect(state.clientWrites).toEqual([]);
  });

  it.each(['parent', 'adult'])('a %s is offered them on every poll', (role) => {
    state.role = role; state.userId = 'user-parent-2';
    for (const q of ['Where this summer?', 'Movie night pick?']) {
      const c = controls(q);
      expect(c.close).toBeDefined();
      expect(c.remove).toBeDefined();
    }
  });
});
