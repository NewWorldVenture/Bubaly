import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionCandidateReview, SubscriptionsModule, SubscriptionsWorkspace } from '@/components/modules/subscriptions-module';
import { detectSubscriptionCandidates, subscriptionReviewContextKey, type SubscriptionCandidateResponse, type SubscriptionReviewContext } from '@/lib/finance/subscription-candidates';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, createClient: vi.fn(), insert: vi.fn(), fetch: vi.fn(),
  key: null as string | null, effects: [] as (() => void)[], cleanups: new Set<() => void>(),
  context: { familyId: 'family-a', userId: 'user-a', selfMember: { id: 'member-a', role: 'parent', is_active: true } },
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    const previous = slots[index] as Effect | undefined;
    if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    mocks.effects.push(() => {
      if (previous?.cleanup) { previous.cleanup(); mocks.cleanups.delete(previous.cleanup); }
      const cleanup = effect();
      slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      if (typeof cleanup === 'function') mocks.cleanups.add(cleanup);
    });
  },
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  // These tests call components as plain functions with hand-mocked hooks, so
  // useContext is unavailable. Resolve through the real catalogue rather than
  // returning the key, so assertions keep checking the words a user sees.
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string) => SOURCE_MESSAGES[key] ?? key,
    useLocale: () => ({ code: 'en-US', language: 'en', region: 'US', dir: 'ltr' }),
    useLocaleSource: () => 'default',
  };
});
vi.mock('@/components/app/app-context', () => ({ useApp: () => mocks.context }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/modules/savings-coach-card', () => ({ SavingsCoachCard: () => null }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render<T>(factory: () => T): T {
  mocks.cursor = 0;
  const result = factory();
  mocks.effects.splice(0).forEach((effect) => effect());
  return result;
}
function unmount() {
  mocks.cleanups.forEach((cleanup) => cleanup());
  mocks.cleanups.clear();
  mocks.effects = [];
  mocks.slots = [];
  mocks.key = null;
}
function keyed<T>(key: string, factory: () => T): T {
  if (mocks.key !== key) { unmount(); mocks.key = key; }
  return render(factory);
}
function renderWorkspace() {
  const wrapper = SubscriptionsModule();
  expect(wrapper.type).toBe(SubscriptionsWorkspace);
  return keyed(`workspace:${wrapper.key}`, () => SubscriptionsWorkspace(wrapper.props));
}
function mountPanel(context: SubscriptionReviewContext, onPrefill = vi.fn()) {
  return keyed(`panel:${subscriptionReviewContextKey(context)}`, () => SubscriptionCandidateReview({ context, tracked: [], onPrefill }));
}
function changeContext(context: SubscriptionReviewContext) {
  mocks.context = { familyId: context.familyId, userId: context.userId, selfMember: { id: context.memberId ?? '', role: context.role ?? 'guest', is_active: context.active } };
}
function click(root: ReactNode, label: string) {
  const target = nodes(root).find((node) => typeof node.props.onClick === 'function' && textOf(node.props.children as ReactNode) === label);
  if (!target) throw new Error(`Missing button: ${label}`);
  return (target.props.onClick as () => unknown)();
}
const candidates = detectSubscriptionCandidates(['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({
  id: `txn-${i}`, name: 'Example Media', amount: 15, currency: 'USD', date, type: 'expense', category: null, accountId: 'account-a', memberId: 'member-a',
})), [], { from: '2026-01-01', to: '2026-09-06' });
const context: SubscriptionReviewContext = { familyId: 'family-a', userId: 'user-a', memberId: 'member-a', role: 'parent', active: true };
const payload: SubscriptionCandidateResponse = { familyId: 'family-a', context, candidates, window: { from: '2026-01-01', to: '2026-09-06' }, recordsRead: 3, limited: false, unsupportedCurrencyRecords: 0 };

beforeEach(() => {
  unmount();
  changeContext(context);
  mocks.cursor = 0;
  mocks.insert.mockReset().mockResolvedValue({ error: null });
  mocks.createClient.mockReset().mockReturnValue({ from: (table: string) => {
    if (table !== 'subscriptions_tracked') throw new Error('Unexpected write target');
    return { insert: mocks.insert };
  } });
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('reachable subscription candidate review', () => {
  it('loads only on request and puts source evidence before an explicit prefill action', async () => {
    const onPrefill = vi.fn();
    const panel = () => SubscriptionCandidateReview({ context, tracked: [], onPrefill });
    const initial = render(panel);
    expect(mocks.fetch).not.toHaveBeenCalled();
    click(initial, 'Find candidates');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: payload }));
    const loaded = render(panel);
    expect(mocks.fetch).toHaveBeenCalledWith('/api/subscriptions/candidates', { credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(nodes(loaded).some((node) => node.type === 'summary')).toBe(true);
    expect(textOf(loaded)).toContain('transactions/txn-0');
    expect(textOf(loaded)).toContain('Observed window: 2026-06-15 to 2026-08-15');
    expect(onPrefill).not.toHaveBeenCalled();
    click(loaded, 'Use in Add form');
    expect(onPrefill).toHaveBeenCalledWith(candidates[0]);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('pre-fills the existing editable Add form and writes only after its explicit Save', async () => {
    const root = renderWorkspace();
    const panel = nodes(root).find((node) => node.type === SubscriptionCandidateReview);
    expect(panel).toBeDefined();
    (panel!.props.onPrefill as (candidate: typeof candidates[number]) => void)(candidates[0]);
    const draft = renderWorkspace();
    const nameField = nodes(draft).find((node) => node.props.label === 'Name')!;
    expect((nameField.props.children as (id: string) => Node)('name').props.value).toBe('Example Media');
    expect(textOf(draft)).toContain('Save subscription');
    expect(mocks.insert).not.toHaveBeenCalled();
    const form = nodes(draft).find((node) => node.type === 'form')!;
    await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ family_id: 'family-a', created_by: 'user-a', name: 'Example Media', cost_cents: 1500, cadence: 'monthly', last_used: null, next_charge: null, note: expect.stringContaining('transactions/txn-0') }));
  });

  it('allows discarding a prefilled draft without a write', () => {
    const root = renderWorkspace();
    (nodes(root).find((node) => node.type === SubscriptionCandidateReview)!.props.onPrefill as (candidate: typeof candidates[number]) => void)(candidates[0]);
    const draft = renderWorkspace();
    const modal = nodes(draft).find((node) => node.props.title === 'Add subscription')!;
    (modal.props.onClose as () => void)();
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each(['failure', 'wrong-family'])('shows a %s as an error, never an empty successful review', async (mode) => {
    mocks.fetch.mockResolvedValue({ ok: mode !== 'failure', json: async () => mode === 'failure' ? { error: 'Recorded expenses could not be read.' } : { ...payload, familyId: 'another-family' } });
    const panel = () => SubscriptionCandidateReview({ context, tracked: [], onPrefill: vi.fn() });
    click(render(panel), 'Find candidates');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: null, error: expect.any(String) }));
    const failed = render(panel);
    expect(nodes(failed).some((node) => node.props.role === 'alert')).toBe(true);
    expect(textOf(failed)).not.toContain('Example Media');
    expect(textOf(failed)).not.toContain('No new candidates');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('suppresses a candidate that became tracked after the API review', () => {
    mocks.slots = [{ contextKey: subscriptionReviewContextKey(context), generation: 0, loading: false, result: payload, error: null }];
    const result = render(() => SubscriptionCandidateReview({ context, tracked: [{ name: 'Example Media' }], onPrefill: vi.fn() }));
    expect(textOf(result)).not.toContain('Use in Add form');
    expect(textOf(result)).toContain('No new candidates');
  });

  it.each([
    ['user', { userId: 'user-b' }], ['member', { memberId: 'member-b' }],
    ['role', { role: 'adult' }], ['active membership', { active: false }],
  ] as const)('clears evidence and invalidates old prefill actions on a same-family %s switch', async (_label, change) => {
    const onPrefill = vi.fn();
    click(mountPanel(context, onPrefill), 'Find candidates');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: payload }));
    const oldPanel = mountPanel(context, onPrefill);
    expect(textOf(oldPanel)).toContain('Example Media');
    const switched = mountPanel({ ...context, ...change }, onPrefill);
    expect(textOf(switched)).not.toContain('Example Media');
    expect(textOf(switched)).not.toContain('transactions/txn-0');
    click(oldPanel, 'Use in Add form');
    expect(onPrefill).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['family', { familyId: 'family-b', memberId: 'member-b' }],
    ['user', { userId: 'user-b' }], ['member', { memberId: 'member-b' }],
    ['role', { role: 'adult' }], ['inactive membership', { active: false }],
  ] as const)('discards the parent Add draft on a %s change, including switching back', (_label, change) => {
    const root = renderWorkspace();
    (nodes(root).find((node) => node.type === SubscriptionCandidateReview)!.props.onPrefill as (candidate: typeof candidates[number]) => void)(candidates[0]);
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(true);
    changeContext({ ...context, ...change });
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(false);
    changeContext(context);
    const returned = renderWorkspace();
    expect(nodes(returned).some((node) => node.type === 'form')).toBe(false);
    expect(textOf(returned)).not.toContain('transactions/txn-0');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('aborts an in-flight scan and ignores its result after leaving and returning to the same context', async () => {
    let finish!: (response: { ok: boolean; json: () => Promise<SubscriptionCandidateResponse> }) => void;
    const pending = new Promise<{ ok: boolean; json: () => Promise<SubscriptionCandidateResponse> }>((resolve) => { finish = resolve; });
    mocks.fetch.mockReturnValueOnce(pending);
    const onPrefill = vi.fn();
    click(mountPanel(context, onPrefill), 'Find candidates');
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    mountPanel({ ...context, familyId: 'family-b', memberId: 'member-b' }, onPrefill);
    expect(signal.aborted).toBe(true);
    mountPanel(context, onPrefill);
    const json = vi.fn(async () => payload);
    finish({ ok: true, json });
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const returned = mountPanel(context, onPrefill);
    expect(json).not.toHaveBeenCalled();
    expect(textOf(returned)).not.toContain('Example Media');
    expect(mocks.slots[0]).toMatchObject({ loading: false, result: null, error: null });
    expect(onPrefill).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([{ userId: 'user-b' }, { memberId: 'member-b' }, { role: 'adult' }, { active: false }])('rejects a response from a different same-family access context: %j', async (change) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...payload, context: { ...context, ...change } }) });
    click(mountPanel(context), 'Find candidates');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: null, error: expect.any(String) }));
    const result = mountPanel(context);
    expect(textOf(result)).not.toContain('Example Media');
    expect(nodes(result).some((node) => node.props.role === 'alert')).toBe(true);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
