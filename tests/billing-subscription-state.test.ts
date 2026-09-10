import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingModule } from '@/components/modules/billing-module';
import { useBillingSubscription } from '@/lib/hooks/use-billing-subscription';
import { getMessages } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { Tables } from '@/lib/database.types';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type Result = { data: Tables<'subscriptions'> | null; error: { message: string } | null };
const mock = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: new Set<() => void>(),
  read: vi.fn<() => Promise<Result>>(), createClient: vi.fn(), eq: vi.fn(),
  channel: vi.fn(), removeChannel: vi.fn(), realtime: undefined as (() => void) | undefined,
  published: false, fetch: vi.fn(), toast: vi.fn(), locale: 'en-US' as LocaleCode,
  scope: { familyId: 'family-a', userId: 'user-a', role: 'parent', members: [] }, checkout: '',
}));

// Execute the real hook and component callbacks. This scheduler lets a test
// inspect the render between a scope change and its passive-effect cleanup.
vi.mock('react', async (original) => {
  const same = (left?: readonly unknown[], right?: readonly unknown[]) => left && right
    && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  function memo(factory: () => unknown, deps?: readonly unknown[]) {
    const index = mock.cursor++;
    const prior = mock.slots[index] as { value: unknown; deps?: readonly unknown[] } | undefined;
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = factory();
    mock.slots[index] = { value, deps };
    return value;
  }
  return {
    ...await original<typeof import('react')>(),
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useState: (initial: unknown) => {
      const index = mock.cursor++;
      if (!(index in mock.slots)) mock.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [mock.slots[index], (value: unknown) => {
        mock.slots[index] = typeof value === 'function' ? value(mock.slots[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = mock.cursor++;
      if (!(index in mock.slots)) mock.slots[index] = { current: initial };
      return mock.slots[index];
    },
    useTransition: () => [false, (callback: () => unknown) => callback()],
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = mock.cursor++;
      const prior = mock.slots[index] as Effect | undefined;
      if (prior && same(prior.deps, deps)) return;
      mock.effects.push(() => {
        if (prior?.cleanup) { prior.cleanup(); mock.cleanups.delete(prior.cleanup); }
        const cleanup = effect();
        mock.slots[index] = { deps, cleanup };
        if (typeof cleanup === 'function') mock.cleanups.add(cleanup);
      });
    },
  };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: mock.createClient }));
vi.mock('@/lib/realtime/published-tables', () => ({ isRealtimePublished: () => mock.published }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => mock.scope }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mock.checkout) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string) => getMessages(mock.locale)[key] ?? key };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: mock.toast, error: mock.toast }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({
  createSavingsGoalAction: vi.fn(), createTransactionAction: vi.fn(), deleteBudgetAction: vi.fn(),
  deleteSavingsGoalAction: vi.fn(), deleteTransactionAction: vi.fn(), setBudgetAction: vi.fn(),
}));

function row(familyId = 'family-a', plan = 'plus'): Tables<'subscriptions'> {
  return { id: 'subscription-fixture', family_id: familyId, plan, status: 'active',
    billing_customer_id: 'customer-fixture', provider_ref: 'subscription-fixture', seats: 1,
    current_period_end: '2026-10-01T00:00:00Z', cancel_at_period_end: false,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  };
}
function deferred() {
  let resolve!: (value: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function render<T>(factory: () => T, effects = true): T {
  mock.cursor = 0;
  const value = factory();
  if (effects) flushEffects();
  return value;
}
function flushEffects() { mock.effects.splice(0).forEach((effect) => effect()); }
function hook(effects = true) { return render(() => useBillingSubscription(mock.scope.familyId, mock.scope.userId), effects); }
function moduleTree(effects = true) { return render(() => BillingModule(), effects); }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function unmount() {
  mock.cleanups.forEach((cleanup) => cleanup());
  mock.cleanups.clear();
  mock.effects = [];
}
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function html(node: ReactNode) { return renderToStaticMarkup(node); }
function escaped(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;'); }
function unavailable(node: ReactNode) {
  const found = nodes(node).find((item) => item.props.message === getMessages(mock.locale)['changePlan.subscriptionStatusIsTemporarilyUnavailable']);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.slots = []; mock.cursor = 0; mock.effects = []; mock.cleanups.clear();
  mock.scope = { familyId: 'family-a', userId: 'user-a', role: 'parent', members: [] };
  mock.checkout = ''; mock.locale = 'en-US'; mock.published = false; mock.realtime = undefined;
  mock.read.mockReset().mockResolvedValue({ data: null, error: null });
  mock.eq.mockImplementation(() => ({ maybeSingle: mock.read }));
  mock.channel.mockImplementation(() => ({
    on: (_event: string, _filter: unknown, callback: () => void) => {
      mock.realtime = callback;
      return { subscribe: () => 'channel-fixture' };
    },
  }));
  mock.createClient.mockReset().mockImplementation(() => ({
    from: (table: string) => { expect(table).toBe('subscriptions'); return { select: () => ({ eq: mock.eq }) }; },
    channel: mock.channel, removeChannel: mock.removeChannel,
  }));
  mock.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('current-owner subscription read lifecycle', () => {
  it.each(['returned', 'rejected', 'client-creation'] as const)('makes %s failures unavailable and permits a successful retry', async (kind) => {
    if (kind === 'returned') mock.read.mockResolvedValueOnce({ data: row(), error: { message: 'private diagnostic' } });
    if (kind === 'rejected') mock.read.mockRejectedValueOnce(new Error('private diagnostic'));
    if (kind === 'client-creation') mock.createClient.mockImplementationOnce(() => { throw new Error('private diagnostic'); });
    expect(hook().status).toBe('loading');
    await settle();
    const failed = hook();
    expect(failed.status).toBe('unavailable');
    expect(failed.subscription).toBeNull();
    expect(failed.isCurrentReady()).toBe(false);
    await failed.reload();
    const recovered = hook();
    expect(recovered.status).toBe('ready');
    expect(recovered.subscription).toBeNull();
    expect(recovered.isCurrentReady()).toBe(true);
    expect(mock.eq).toHaveBeenLastCalledWith('family_id', 'family-a');
  });

  it.each(['familyId', 'userId'] as const)('masks a previous success immediately when %s changes, before passive effects', async (field) => {
    mock.read.mockResolvedValueOnce({ data: row(), error: null });
    hook(); await settle();
    expect(hook().subscription?.plan).toBe('plus');
    mock.scope[field] = `${field}-b`;
    const beforeEffects = hook(false);
    expect(beforeEffects.status).toBe('loading');
    expect(beforeEffects.subscription).toBeNull();
    expect(beforeEffects.isCurrentReady()).toBe(false);
    expect(mock.read).toHaveBeenCalledTimes(1);
    flushEffects(); await settle();
    expect(hook().status).toBe('ready');
    expect(mock.read).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale family success and rejection after the new family settles', async () => {
    const old = deferred(); const older = deferred();
    mock.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(older.promise);
    const first = hook();
    const reload = first.reload();
    mock.scope.familyId = 'family-b';
    mock.read.mockResolvedValueOnce({ data: row('family-b', 'basic'), error: null });
    hook(); await settle();
    old.resolve({ data: row(), error: null });
    older.reject(new Error('late private diagnostic'));
    await reload; await settle();
    expect(hook().subscription?.family_id).toBe('family-b');
    expect(hook().subscription?.plan).toBe('basic');
  });

  it('ignores reversed responses and invalidates purchase readiness as soon as reload begins', async () => {
    mock.read.mockResolvedValueOnce({ data: row(), error: null });
    hook(); await settle();
    const ready = hook();
    const older = deferred(); const newer = deferred();
    mock.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = ready.reload();
    expect(ready.isCurrentReady()).toBe(false);
    const second = ready.reload();
    newer.resolve({ data: row('family-a', 'basic'), error: null }); await second;
    older.resolve({ data: row(), error: null }); await first;
    expect(hook().subscription?.plan).toBe('basic');
  });

  it('does not reuse the first A response after A -> B -> A', async () => {
    const first = deferred();
    mock.read.mockReturnValueOnce(first.promise);
    hook();
    mock.scope.familyId = 'family-b'; hook(); await settle();
    mock.scope.familyId = 'family-a';
    mock.read.mockResolvedValueOnce({ data: row('family-a', 'basic'), error: null });
    expect(hook(false).status).toBe('loading');
    flushEffects(); await settle();
    first.resolve({ data: row(), error: null }); await settle();
    expect(hook().subscription?.plan).toBe('basic');
  });

  it.each(['familyId', 'userId', 'ABA'] as const)('revokes retained readiness and reload callbacks during %s render before passive cleanup', async (change) => {
    mock.read.mockResolvedValue({ data: row(), error: null });
    hook(); await settle();
    const retained = hook();
    expect(retained.isCurrentReady()).toBe(true);
    if (change === 'userId') mock.scope.userId = 'user-b';
    else mock.scope.familyId = 'family-b';
    hook(false);
    expect(retained.isCurrentReady()).toBe(false);
    await retained.reload();
    expect(mock.read).toHaveBeenCalledTimes(1);
    if (change === 'ABA') {
      flushEffects(); await settle();
      mock.scope.familyId = 'family-a'; hook(false);
      expect(retained.isCurrentReady()).toBe(false);
      await retained.reload();
      expect(mock.read).toHaveBeenCalledTimes(2);
    }
  });

  it('rejects a returned row belonging to another family', async () => {
    mock.read.mockResolvedValueOnce({ data: row('family-b'), error: null });
    hook(); await settle();
    expect(hook().status).toBe('unavailable');
    expect(hook().subscription).toBeNull();
  });

  it.each(['familyId', 'userId'] as const)('does not query with missing %s', async (field) => {
    mock.scope[field] = '';
    hook(); await settle();
    expect(hook().status).toBe('unavailable');
    expect(mock.createClient).not.toHaveBeenCalled();
  });

  it('ignores completion and reload callbacks after disposal, even without a realtime channel', async () => {
    const pending = deferred(); mock.read.mockReturnValueOnce(pending.promise);
    const current = hook();
    unmount();
    const saved = [...mock.slots];
    pending.resolve({ data: row(), error: null }); await settle();
    await current.reload();
    expect(mock.slots).toEqual(saved);
    expect(current.isCurrentReady()).toBe(false);
    expect(mock.read).toHaveBeenCalledTimes(1);
    expect(mock.channel).not.toHaveBeenCalled();
  });

  it('preserves published realtime refresh and removes its channel on scope change and disposal', async () => {
    mock.published = true;
    hook(); await settle();
    mock.realtime!(); await settle();
    expect(mock.read).toHaveBeenCalledTimes(2);
    mock.scope.userId = 'user-b'; hook(); await settle();
    expect(mock.removeChannel).toHaveBeenCalledTimes(1);
    unmount();
    expect(mock.removeChannel).toHaveBeenCalledTimes(2);
  });
});

describe('Billing subscription rendering and purchase callbacks', () => {
  it.each<LocaleCode>(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'])('renders localized unavailable + retry in %s without Free, trial, payment controls, or raw diagnostics', async (locale) => {
    mock.locale = locale; mock.checkout = 'checkout=plus';
    mock.read.mockResolvedValueOnce({ data: row(), error: { message: 'PRIVATE_DATABASE_DIAGNOSTIC' } });
    const loading = html(moduleTree());
    expect(loading).not.toContain('Bubaly Free');
    await settle();
    const failed = moduleTree();
    const markup = html(failed);
    const messages = getMessages(locale);
    expect(markup).toContain(escaped(messages['changePlan.subscriptionStatusIsTemporarilyUnavailable']));
    expect(markup).toContain(escaped(messages['states.tryAgain']));
    expect(markup).not.toContain('Bubaly Free');
    expect(markup).not.toContain('PRIVATE_DATABASE_DIAGNOSTIC');
    expect(markup).not.toContain(escaped(messages['billing.paymentAmpInvoices']));
    expect(nodes(failed).some((node) => typeof node.props.onChoose === 'function')).toBe(false);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.toast).not.toHaveBeenCalled();
    (unavailable(failed).props.onRetry as () => void)();
    expect(html(moduleTree())).not.toContain('Bubaly Free');
    await settle();
    const recovered = moduleTree(); await settle();
    expect(html(recovered)).toContain('Bubaly Free');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.fetch).toHaveBeenCalledWith('/api/billing/change-plan', expect.objectContaining({ body: JSON.stringify({ plan: 'plus_monthly' }) }));
  });

  it('keeps rejected reads out of demo checkout until an actual empty success', async () => {
    mock.checkout = 'checkout=basic'; mock.read.mockRejectedValueOnce(new Error('private network error'));
    moduleTree(); await settle();
    const failed = moduleTree();
    expect(mock.fetch).not.toHaveBeenCalled();
    (unavailable(failed).props.onRetry as () => void)(); await settle();
    moduleTree(); await settle(); moduleTree();
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.fetch).toHaveBeenCalledWith('/api/billing/change-plan', expect.objectContaining({ body: JSON.stringify({ plan: 'basic_monthly' }) }));
  });

  it.each(['familyId', 'userId'] as const)('hides previous-owner paid controls before %s effects and prevents checkout from stale empty results', async (field) => {
    mock.read.mockResolvedValueOnce({ data: row(), error: null });
    moduleTree(); await settle();
    expect(html(moduleTree())).toContain('Family+');
    mock.scope[field] = `${field}-b`; mock.checkout = 'checkout=plus';
    const pending = deferred(); mock.read.mockReturnValueOnce(pending.promise);
    const switched = moduleTree(false);
    expect(html(switched)).not.toContain('Family+');
    expect(nodes(switched).some((node) => typeof node.props.onChoose === 'function')).toBe(false);
    flushEffects(); await settle();
    expect(mock.fetch).not.toHaveBeenCalled();
    pending.resolve({ data: null, error: { message: 'temporarily unavailable' } }); await settle();
    unavailable(moduleTree());
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('preserves explicit paid plan changes and payment portal after a successful read', async () => {
    mock.read.mockResolvedValue({ data: row(), error: null });
    moduleTree(); await settle();
    const tree = moduleTree();
    const picker = nodes(tree).find((node) => typeof node.props.onChoose === 'function')!;
    (picker.props.onChoose as (plan: string) => void)('basic_annual'); await settle();
    expect(mock.fetch).toHaveBeenCalledWith('/api/billing/change-plan', expect.objectContaining({ body: JSON.stringify({ plan: 'basic_annual' }) }));
    const fresh = moduleTree();
    const portal = nodes(fresh).find((node) => node.props.children === getMessages('en-US')['billing.paymentAmpInvoices'])!;
    (portal.props.onClick as () => void)(); await settle();
    expect(mock.fetch).toHaveBeenLastCalledWith('/api/billing/portal', { method: 'POST' });
  });

  it.each(['familyId', 'userId'] as const)('retained plan, cancel, and portal handlers cannot purchase during a %s switch', async (field) => {
    mock.read.mockResolvedValue({ data: row(), error: null });
    moduleTree(); await settle();
    const oldNodes = nodes(moduleTree());
    const choose = oldNodes.find((node) => typeof node.props.onChoose === 'function')!;
    const portal = oldNodes.find((node) => node.props.children === getMessages('en-US')['billing.paymentAmpInvoices'])!;
    const cancel = oldNodes.find((node) => node.props.children === getMessages('en-US')['billing.cancelAmpDowngradeToFree'])!;
    mock.scope[field] = `${field}-b`;
    moduleTree(false);
    (choose.props.onChoose as (plan: string) => void)('basic_annual');
    (portal.props.onClick as () => void)();
    (cancel.props.onClick as () => void)();
    await settle();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('does not start demo checkout for a confirmed paid family and preserves explicit cancel', async () => {
    mock.checkout = 'checkout=plus'; mock.read.mockResolvedValue({ data: row(), error: null });
    moduleTree(); await settle();
    const ready = moduleTree();
    expect(mock.fetch).not.toHaveBeenCalled();
    const cancel = nodes(ready).find((node) => node.props.children === getMessages('en-US')['billing.cancelAmpDowngradeToFree'])!;
    (cancel.props.onClick as () => void)(); await settle();
    expect(mock.fetch).toHaveBeenCalledWith('/api/billing/cancel', expect.objectContaining({ body: JSON.stringify({ resume: false }) }));
  });

  it('keeps all purchase controls unavailable to a non-admin, even after an empty success', async () => {
    mock.scope.role = 'child'; mock.checkout = 'checkout=plus';
    moduleTree(); await settle();
    const tree = moduleTree();
    expect(html(tree)).toContain('Bubaly Free');
    expect(nodes(tree).some((node) => typeof node.props.onChoose === 'function')).toBe(false);
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});
