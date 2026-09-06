import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionPriceHistoryReview } from '@/components/modules/subscription-price-history-review';
import { SubscriptionsModule, SubscriptionsWorkspace } from '@/components/modules/subscriptions-module';
import { type SubscriptionReviewContext } from '@/lib/finance/subscription-candidates';
import {
  reviewSubscriptionPriceHistory, subscriptionHistoryTargetKey,
  type PriceHistorySubscription, type SubscriptionPriceHistoryResponse,
} from '@/lib/finance/subscription-price-history';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const mocks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, createClient: vi.fn(), update: vi.fn(), eq: vi.fn(), fetch: vi.fn(),
  key: null as string | null, effects: [] as (() => void)[], cleanups: new Set<() => void>(),
  context: { familyId: 'family-a', userId: 'user-a', selfMember: { id: 'member-a', role: 'parent', is_active: true } },
  rows: [] as Record<string, unknown>[],
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
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: mocks.rows, loading: false, error: null, refresh: vi.fn() }) }));
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
function panel(ctx = context, onPrefill = vi.fn(), target = subscription) {
  return keyed(JSON.stringify([ctx, subscriptionHistoryTargetKey(target)]), () => SubscriptionPriceHistoryReview({ context: ctx, subscription: target, onPrefill }));
}
function changeContext(ctx: SubscriptionReviewContext) {
  mocks.context = { familyId: ctx.familyId, userId: ctx.userId, selfMember: { id: ctx.memberId ?? '', role: ctx.role ?? 'guest', is_active: ctx.active } };
}
function click(root: ReactNode, label: string) {
  const target = nodes(root).find((node) => typeof node.props.onClick === 'function' && textOf(node.props.children as ReactNode) === label);
  if (!target) throw new Error(`Missing button: ${label}`);
  return (target.props.onClick as () => unknown)();
}
function input(root: ReactNode, label: string): Node {
  return (nodes(root).find((node) => node.props.label === label)!.props.children as (id: string) => Node)(label);
}
const subscription: PriceHistorySubscription = { id: '10000000-0000-4000-8000-000000000001', name: 'Example Media', costCents: 1500, cadence: 'monthly', note: 'Keep this note' };
const context: SubscriptionReviewContext = { familyId: 'family-a', userId: 'user-a', memberId: 'member-a', role: 'parent', active: true };
const rows = ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({
  id: `txn-${i}`, name: 'Example Media', amount: i === 2 ? 18 : 15, currency: 'USD', date, type: 'expense', category: null, accountId: 'account-a', memberId: 'member-a',
}));
const payload: SubscriptionPriceHistoryResponse = {
  familyId: 'family-a', context,
  history: reviewSubscriptionPriceHistory(rows, subscription, { from: '2024-07-01', to: '2026-09-06' }, 3),
};
const charge = payload.history.groups[0].evidence[2];

beforeEach(() => {
  unmount();
  changeContext(context);
  mocks.rows = [{ id: subscription.id, family_id: 'family-a', name: subscription.name, cost_cents: 1500, cadence: 'monthly', category: 'Streaming', status: 'trial', next_charge: '2026-09-15', last_used: null, note: subscription.note }];
  mocks.eq.mockReset().mockResolvedValue({ error: null });
  mocks.update.mockReset().mockReturnValue({ eq: mocks.eq });
  mocks.createClient.mockReset().mockReturnValue({ from: (table: string) => {
    if (table !== 'subscriptions_tracked') throw new Error('Unexpected write target');
    return { update: mocks.update };
  } });
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => payload });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('reachable recorded charge history and explicit edit', () => {
  it('loads only on explicit request and shows dated source links and qualified amount differences', async () => {
    const onPrefill = vi.fn();
    const first = panel(context, onPrefill);
    expect(mocks.fetch).not.toHaveBeenCalled();
    click(first, 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: payload }));
    const loaded = panel(context, onPrefill);
    expect(mocks.fetch).toHaveBeenCalledWith(`/api/subscriptions/price-history?subscriptionId=${subscription.id}`, { credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(textOf(loaded)).toContain('2026-08-15');
    expect(textOf(loaded)).toContain('USD 3.00 higher');
    expect(textOf(loaded)).toContain('not a confirmed provider plan-price change');
    const link = nodes(loaded).find((node) => node.type === 'a' && textOf(node) === 'Source: transactions/txn-2')!;
    expect(nodes(loaded).some((node) => `#${node.props.id}` === link.props.href)).toBe(true);
    expect(onPrefill).not.toHaveBeenCalled();
    click(loaded, 'Use USD 18.00 in Edit form');
    expect(onPrefill).toHaveBeenCalledWith(charge);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('puts a selected amount in the existing editable form, preserves other fields, and only writes on Save', async () => {
    const root = renderWorkspace();
    const review = nodes(root).find((node) => node.type === SubscriptionPriceHistoryReview)!;
    expect(review).toBeDefined();
    (review.props.onPrefill as (value: typeof charge) => void)(charge);
    const draft = renderWorkspace();
    expect(input(draft, 'Cost ($)').props.value).toBe('18');
    expect(input(draft, 'Status').props.value).toBe('trial');
    expect(input(draft, 'Next charge').props.value).toBe('2026-09-15');
    expect(input(draft, 'Last used').props.value).toBe('');
    expect(input(draft, 'Note').props.value).toBe('Keep this note');
    expect(mocks.update).not.toHaveBeenCalled();
    (input(draft, 'Cost ($)').props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '17.50' } });
    const edited = renderWorkspace();
    const form = nodes(edited).find((node) => node.type === 'form')!;
    await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({ name: 'Example Media', cost_cents: 1750, cadence: 'monthly', category: 'Streaming', status: 'trial', next_charge: '2026-09-15', last_used: null, note: 'Keep this note' });
    expect(mocks.eq).toHaveBeenCalledWith('id', subscription.id);
  });

  it('allows closing a selected-amount draft with no write', () => {
    const root = renderWorkspace();
    (nodes(root).find((node) => node.type === SubscriptionPriceHistoryReview)!.props.onPrefill as (value: typeof charge) => void)(charge);
    const draft = renderWorkspace();
    const modal = nodes(draft).find((node) => node.props.title === 'Edit subscription')!;
    (modal.props.onClose as () => void)();
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    ['family', { familyId: 'family-b', memberId: 'member-b' }],
    ['user', { userId: 'user-b' }], ['member', { memberId: 'member-b' }],
    ['role', { role: 'adult' }], ['active membership', { active: false }],
  ] as const)('clears evidence, stale selection callbacks and Edit drafts across a %s switch and return', async (_label, change) => {
    const onPrefill = vi.fn();
    click(panel(context, onPrefill), 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ result: payload, loading: false }));
    const old = panel(context, onPrefill);
    expect(textOf(panel({ ...context, ...change }, onPrefill))).not.toContain('transactions/txn-2');
    click(old, 'Use USD 18.00 in Edit form');
    expect(onPrefill).not.toHaveBeenCalled();
    expect(textOf(panel(context, onPrefill))).not.toContain('transactions/txn-2');
    const workspace = renderWorkspace();
    (nodes(workspace).find((node) => node.type === SubscriptionPriceHistoryReview)!.props.onPrefill as (value: typeof charge) => void)(charge);
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(true);
    changeContext({ ...context, ...change });
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(false);
    changeContext(context);
    expect(nodes(renderWorkspace()).some((node) => node.type === 'form')).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('aborts an in-flight request and discards its response after context ABA', async () => {
    let finish!: (response: { ok: boolean; json: () => Promise<SubscriptionPriceHistoryResponse> }) => void;
    const pending = new Promise<{ ok: boolean; json: () => Promise<SubscriptionPriceHistoryResponse> }>((resolve) => { finish = resolve; });
    mocks.fetch.mockReturnValueOnce(pending);
    click(panel(), 'Review recorded charges');
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    panel({ ...context, memberId: 'member-b' });
    expect(signal.aborted).toBe(true);
    panel();
    const json = vi.fn(async () => payload);
    finish({ ok: true, json });
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(json).not.toHaveBeenCalled();
    expect(textOf(panel())).not.toContain('transactions/txn-2');
  });

  it('also discards a response body that resolves after the context changes', async () => {
    let finish!: (value: SubscriptionPriceHistoryResponse) => void;
    const pending = new Promise<SubscriptionPriceHistoryResponse>((resolve) => { finish = resolve; });
    const json = vi.fn(() => pending);
    mocks.fetch.mockResolvedValueOnce({ ok: true, json });
    click(panel(), 'Review recorded charges');
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    panel({ ...context, familyId: 'family-b' });
    panel();
    finish(payload);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textOf(panel())).not.toContain('transactions/txn-2');
  });

  it('invalidates evidence and old actions when the tracked amount changes', async () => {
    const onPrefill = vi.fn();
    click(panel(context, onPrefill), 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ result: payload }));
    const old = panel(context, onPrefill);
    expect(textOf(panel(context, onPrefill, { ...subscription, costCents: 1700 }))).not.toContain('transactions/txn-2');
    click(old, 'Use USD 18.00 in Edit form');
    expect(onPrefill).not.toHaveBeenCalled();
  });

  it.each([{ familyId: 'family-b' }, { userId: 'user-b' }, { memberId: 'member-b' }, { role: 'adult' }, { active: false }])('rejects mismatched response identity %j', async (change) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...payload, context: { ...context, ...change } }) });
    click(panel(), 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: null, error: expect.any(String) }));
    expect(textOf(panel())).not.toContain('transactions/txn-2');
    expect(nodes(panel()).some((node) => node.props.role === 'alert')).toBe(true);
  });

  it.each(['family', 'subscription', 'amount', 'coverage', 'source-failure'])('rejects %s response problems without an empty success or prefill', async (mode) => {
    const bad = structuredClone(payload);
    if (mode === 'family') bad.familyId = 'another-family';
    if (mode === 'subscription') bad.history.subscription.id = 'another-subscription';
    if (mode === 'amount') bad.history.groups[0].evidence[2].amountCents = -1;
    if (mode === 'coverage') bad.history.coverage.totalRecords = NaN;
    mocks.fetch.mockResolvedValue({ ok: mode !== 'source-failure', json: async () => mode === 'source-failure' ? { error: 'Recorded charges could not be read.' } : bad });
    click(panel(), 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ loading: false, result: null, error: expect.any(String) }));
    expect(textOf(panel())).not.toContain('Use USD');
    expect(textOf(panel())).not.toContain('No matching eligible');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('shows separate ambiguous groups without an amount-prefill button', async () => {
    const other = rows.map((row, i) => ({ ...row, id: `other-${i}`, accountId: 'account-b' }));
    const ambiguous = { ...payload, history: reviewSubscriptionPriceHistory([...rows, ...other], subscription, payload.history.window, 6) };
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ambiguous });
    click(panel(), 'Review recorded charges');
    await vi.waitFor(() => expect(mocks.slots[0]).toMatchObject({ result: ambiguous }));
    expect(textOf(panel())).toContain('not attributed or combined');
    expect(textOf(panel())).toContain('account-a');
    expect(textOf(panel())).toContain('account-b');
    expect(textOf(panel())).not.toContain('Use USD');
  });
});
