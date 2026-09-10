import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopilotModule } from '@/components/modules/autopilot-module';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { Tables } from '@/lib/database.types';

const state = vi.hoisted(() => ({ slots: [] as unknown[], rootSlots: [] as unknown[], childSlots: [] as unknown[], childKey: '', cursor: 0,
  effects: [] as (() => void)[], locale: 'en-US' as LocaleCode, familyId: 'family-1', userId: 'user-1', role: 'parent', memberId: 'member-1',
  data: [] as Tables<'autopilot_suggestions'>[], resolve: vi.fn(), policy: vi.fn(), success: vi.fn(), error: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const slots = state.slots; const index = state.cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (setup: () => (() => void), deps: unknown[]) => {
    const index = state.cursor++; const previous = state.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
      const next = { deps, setup, cleanup: undefined as (() => void) | undefined }; state.slots[index] = next;
      state.effects.push(() => { previous?.cleanup?.(); next.cleanup = setup(); });
    }
  },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: state.familyId, userId: state.userId, role: state.role, selfMember: { id: state.memberId } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: state.data, loading: false, error: null, refresh: state.refresh }) }));
vi.mock('@/app/(app)/dashboard/autopilot/actions', () => ({ resolveAutopilotSuggestionAction: state.resolve }));
vi.mock('@/app/(app)/dashboard/trust/actions', () => ({ acceptPolicySuggestionAction: state.policy }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/ai/why-this', () => ({ WhyThis: () => null }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale), key, params) }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => createElement('a', props) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ loading: _loading, ...props }: Record<string, unknown>) => createElement('button', props) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: ({ title, description, action }: Record<string, ReactNode>) => createElement('header', null, title, description, action) }));

type Node = ReactElement<Record<string, unknown>>;
const t = (key: string) => translate(getMessages(state.locale), `autopilotResolution.${key}`);
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
function render(effects = true): ReactNode {
  state.slots = state.rootSlots; state.cursor = 0;
  const child = AutopilotModule();
  if (child.key !== state.childKey) {
    for (const slot of state.childSlots) {
      const effect = slot as { cleanup?: () => void } | null;
      if (effect?.cleanup) state.effects.push(effect.cleanup);
    }
    state.childKey = String(child.key); state.childSlots = [];
  }
  state.slots = state.childSlots; state.cursor = 0;
  const tree = expand((child.type as (props: unknown) => ReactNode)(child.props));
  if (effects) state.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function button(tree: ReactNode, key: string): Node {
  const result = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === t(key));
  if (!result) throw new Error(`Missing button ${key}`); return result;
}
const click = (node: Node) => (node.props.onClick as () => Promise<void>)();
function suggestion(overrides: Partial<Tables<'autopilot_suggestions'>> = {}): Tables<'autopilot_suggestions'> {
  return { id: 's1', family_id: 'family-1', kind: 'document', status: 'open', title: 'Renewal reminder', detail: 'Source details', confidence: 80, urgency: 2,
    action_type: 'create_reminder', action_label: 'Untrusted label', payload: { href: 'https://untrusted.invalid' }, updated_at: '2026-09-09T10:00:00Z', ...overrides } as Tables<'autopilot_suggestions'>;
}
beforeEach(() => {
  state.rootSlots = []; state.childSlots = []; state.childKey = ''; state.effects = []; state.cursor = 0;
  state.locale = 'en-US'; state.familyId = 'family-1'; state.userId = 'user-1'; state.role = 'parent'; state.memberId = 'member-1';
  state.data = [suggestion()]; state.resolve.mockReset(); state.policy.mockReset(); state.success.mockReset(); state.error.mockReset(); state.refresh.mockReset();
  state.fetch.mockResolvedValue({ ok: true, json: async () => ({ autoExecuted: 0 }) }); vi.stubGlobal('fetch', state.fetch);
});

describe('Autopilot action controls', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('renders honest reminder/review copy in %s', (locale) => {
    state.locale = locale;
    state.data.push(suggestion({ id: 'nudge', action_type: 'nudge', title: 'Chore overdue' }));
    const tree = render();
    expect(text(tree)).toContain(t('executionMethod')); expect(button(tree, 'saveReminder')).toBeDefined();
    const link = nodes(tree).find((node) => node.type === 'a' && text(node).trim() === t('openChores'));
    expect(link?.props.href).toBe('/dashboard/chores'); expect(text(tree)).not.toContain('Untrusted label');
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it.each([['nudge', '/dashboard/chores'], ['plan_meals', '/dashboard/meals'], ['plan_celebration', '/dashboard/celebrations'],
    ['keep_grocery', '/dashboard/grocery'], ['review_conflict', '/dashboard/calendar'], ['review_subscription', '/dashboard/subscriptions'],
    ['review_wellbeing', '/dashboard/family-health']])('%s opens %s without an approval or completion write', (action, href) => {
    state.data = [suggestion({ action_type: action })]; const tree = render();
    expect(nodes(tree).find((node) => node.type === 'a')?.props.href).toBe(href);
    expect(text(tree)).toContain(t('reviewDoesNotComplete'));
    expect(state.resolve).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
    expect(nodes(tree).some((node) => node.type === 'button' && text(node) === 'Send a nudge')).toBe(false);
  });
  it('keeps unknown actions pending without an arbitrary execution or persisted URL', () => {
    state.data = [suggestion({ action_type: 'https://untrusted.invalid' })]; const tree = render();
    expect(text(tree)).toContain(t('noDirectAction')); expect(nodes(tree).some((node) => node.type === 'a')).toBe(false);
  });
  it.each(['__proto__', 'constructor', 'toString'])('treats inherited property %s as an unsupported action', (action) => {
    state.data = [suggestion({ action_type: action })];
    expect(text(render())).toContain(t('noDirectAction'));
  });
  it('gives changed saved proposals a review/refresh path instead of an endless status retry', async () => {
    state.resolve.mockResolvedValue({ ok: false, code: 'sourceChanged', saved: true, reminderId: 'r1' });
    await click(button(render(), 'saveReminder')); const tree = render();
    expect(text(tree)).toContain(t('sourceChanged')); expect(button(tree, 'saveReminder').props.disabled).toBe(true);
    expect(text(tree)).not.toContain(t('retryStatus'));
    state.refresh.mockClear(); await click(button(tree, 'refresh')); expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.resolve).toHaveBeenCalledTimes(1);
  });
  it('separates legacy approved work and never offers reminder creation for it', () => {
    state.data = [suggestion({ status: 'approved' })]; const tree = render();
    expect(text(tree)).toContain(t('previouslyApproved')); expect(text(tree)).toContain(t('completionUnknown'));
    expect(nodes(tree).some((node) => node.type === 'button' && text(node).trim() === t('saveReminder'))).toBe(false);
    expect(nodes(tree).find((node) => node.type === 'a')?.props.href).toBe('/dashboard/reminders');
  });
  it('only sends source identity and current ownership, with a synchronous duplicate-click guard', async () => {
    let finish: (result: unknown) => void = () => {};
    state.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const trigger = button(render(), 'saveReminder'); const pending = click(trigger); await click(trigger);
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.resolve.mock.calls[0][0]).toEqual({ suggestionId: 's1', updatedAt: '2026-09-09T10:00:00Z', action: 'reminder', expectedFamilyId: 'family-1', expectedUserId: 'user-1' });
    finish({ ok: false, code: 'unavailable' }); await pending;
    expect(text(render())).toContain(t('unavailable')); expect(state.success).not.toHaveBeenCalled();
  });
  it('shows saved-but-unresolved status and retries the same source after UI reload', async () => {
    state.resolve.mockResolvedValue({ ok: false, saved: true, code: 'resolutionPending', reminderId: 'r1' });
    await click(button(render(), 'saveReminder'));
    const failed = render(); expect(text(failed)).toContain(t('resolutionPending')); expect(button(failed, 'retryStatus')).toBeDefined();
    expect(nodes(failed).find((node) => node.type === 'a')?.props.href).toBe('/dashboard/reminders'); expect(state.success).not.toHaveBeenCalled();
    state.childSlots = []; state.childKey = ''; state.rootSlots = [];
    state.resolve.mockResolvedValue({ ok: true, status: 'executed', reminderId: 'r1' });
    await click(button(render(), 'saveReminder'));
    expect(state.resolve.mock.calls[1][0]).toEqual(state.resolve.mock.calls[0][0]);
    expect(state.success).toHaveBeenCalledWith(t('reminderSaved'));
  });
  it.each(['familyId', 'userId', 'role', 'memberId'] as const)('hides old rows/outcomes and refuses old callbacks immediately after %s changes', async (field) => {
    let finish: (result: unknown) => void = () => {};
    state.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const trigger = button(render(), 'saveReminder'); const pending = click(trigger);
    state[field] = 'new-owner'; if (field !== 'familyId') state.data = [];
    const next = render(false); expect(text(next)).not.toContain('Renewal reminder');
    await click(trigger); expect(state.resolve).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: 'executed', reminderId: 'r1' }); await pending;
    expect(state.success).not.toHaveBeenCalled(); expect(text(render())).not.toContain(t('reminderSaved'));
  });
  it('effect replay keeps reminder controls active', async () => {
    const tree = render();
    for (const slot of state.childSlots) {
      const effect = slot as { setup?: () => (() => void); cleanup?: () => void } | null;
      if (effect?.setup) { effect.cleanup?.(); effect.cleanup = effect.setup(); }
    }
    state.resolve.mockResolvedValue({ ok: true, status: 'executed', reminderId: 'r1' });
    await click(button(tree, 'saveReminder')); expect(state.resolve).toHaveBeenCalledTimes(1);
  });
  it('policy acceptance continues to use the manager-checked trust action', async () => {
    state.data = [suggestion({ kind: 'policy', action_type: 'accept_policy' })]; state.policy.mockResolvedValue({ ok: false, error: 'Manager required' });
    const trigger = nodes(render()).find((node) => node.type === 'button' && text(node).includes('Trust Bubaly'))!;
    await click(trigger); expect(state.policy).toHaveBeenCalledWith({ suggestionId: 's1' });
    expect(state.resolve).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled(); expect(state.error).toHaveBeenCalledWith('Manager required');
  });
});
