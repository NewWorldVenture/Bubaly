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
  scope: { familyId: 'family-a', family: { name: 'Review family' }, userId: 'user-a', role: 'parent', members: [] }, checkout: '',
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
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(mock.locale), key, params),
    useLocale: () => localeOrDefault(mock.locale),
  };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: mock.toast, error: mock.toast }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
// Integration adds independent family-value cards alongside the subscription.
// Their server actions and hook state are outside this read/purchase boundary.
// Explicit factories also work on the pricing base before those cards exist.
vi.mock('@/components/billing/family-delivered-value', () => ({ FamilyDeliveredValue: () => null }));
vi.mock('@/components/billing/family-value-comparison', () => ({ FamilyValueComparison: () => null }));
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
  mock.scope = { familyId: 'family-a', family: { name: 'Review family' }, userId: 'user-a', role: 'parent', members: [] };
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

describe('explicit selected-plan review', () => {
  const plans = ['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'] as const;
  function review(tree: ReactNode) { return nodes(tree).find((node) => typeof node.props.onConfirm === 'function'); }
  async function readyReview(query = 'view=manage&reviewPlan=plus_annual') {
    mock.checkout = query;
    moduleTree(); await settle();
    return moduleTree();
  }
  it.each(plans)('stages %s without any mutation until explicit confirmation', async (plan) => {
    const tree = await readyReview(`view=manage&reviewPlan=${plan}&amount=1&priceId=price_untrusted`);
    const selection = review(tree)!;
    expect(selection.props.initialPlan).toBe(plan);
    expect(selection.props.familyName).toBe('Review family');
    expect(selection.props.currentSlug).toBeNull();
    expect(selection.props.hasLiveSubscription).toBe(false);
    expect(mock.fetch).not.toHaveBeenCalled();
    await (selection.props.onConfirm as (plan: string) => Promise<void>)(plan);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.fetch).toHaveBeenCalledWith('/api/billing/change-plan', expect.objectContaining({
      body: JSON.stringify({ plan, expectedUserId: 'user-a', expectedFamilyId: 'family-a' }),
    }));
  });
  it.each([
    'reviewPlan=&checkout=plus', 'reviewPlan=unknown&checkout=plus', 'reviewPlan=plus_annual&checkout=plus',
    'reviewPlan=plus_annual&reviewPlan=plus_annual', 'reviewPlan=basic_annual&reviewPlan=plus_annual',
    'reviewPlan=basic_annual&plan=basic&billing=yearly', 'plan=plus&checkout=plus', 'billing=yearly&checkout=basic',
  ])('never starts legacy checkout or exposes a confirm control for invalid/mixed query %s', async (query) => {
    const tree = await readyReview(query);
    expect(review(tree)).toBeUndefined();
    expect(nodes(tree).some(node => typeof node.props.onChoose === 'function')).toBe(false);
    expect(html(tree)).toContain(escaped(getMessages('en-US')['billingReview.invalid']));
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('recovers a failed required read without consuming the review or beginning checkout', async () => {
    mock.checkout = 'reviewPlan=basic_annual';
    mock.read.mockRejectedValueOnce(new Error('private billing error'));
    expect(review(moduleTree())).toBeUndefined(); await settle();
    const failed = moduleTree();
    expect(review(failed)).toBeUndefined();
    (unavailable(failed).props.onRetry as () => void)(); await settle();
    expect(review(moduleTree())?.props.initialPlan).toBe('basic_annual');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it.each(['familyId', 'userId', 'role', 'query', 'ABA', 'dispose'] as const)('revokes retained review confirmation after %s changes', async (kind) => {
    const old = review(await readyReview())!;
    if (kind === 'dispose') unmount();
    else {
      if (kind === 'familyId' || kind === 'ABA') mock.scope.familyId = 'family-b';
      if (kind === 'userId') mock.scope.userId = 'user-b';
      if (kind === 'role') mock.scope.role = 'child';
      if (kind === 'query') mock.checkout = 'reviewPlan=basic_monthly';
      moduleTree(false);
      if (kind === 'ABA') {
        flushEffects(); await settle(); mock.scope.familyId = 'family-a'; moduleTree(false);
      }
    }
    await (old.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('ignores a late checkout response after the family changes and prevents duplicate confirmation', async () => {
    const selected = review(await readyReview())!;
    let resolve!: (response: unknown) => void;
    mock.fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    vi.stubGlobal('window', { location: { href: '/original' } });
    const confirm = selected.props.onConfirm as (plan: string) => Promise<void>;
    const pending = confirm('plus_annual');
    await confirm('plus_annual');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(review(moduleTree())?.props.pending).toBe(true);
    mock.scope.familyId = 'family-b'; moduleTree(false);
    resolve({ ok: true, json: async () => ({ url: 'https://checkout.example.test/stale' }) });
    await pending;
    expect(window.location.href).toBe('/original');
    expect(mock.toast).not.toHaveBeenCalled();
  });
  it('keeps review confirmation unavailable to a child and preserves a current-plan no-op', async () => {
    mock.scope.role = 'child';
    expect(review(await readyReview())).toBeUndefined();
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.scope.role = 'parent';
    mock.read.mockResolvedValue({ data: row('family-a', 'plus_annual'), error: null });
    mock.scope.familyId = 'family-b'; moduleTree(); await settle();
    mock.scope.familyId = 'family-a'; moduleTree(); await settle();
    const selected = review(moduleTree())!;
    await (selected.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('rejects a retained confirm callback while a realtime reload is unavailable', async () => {
    mock.published = true;
    const selected = review(await readyReview())!;
    mock.read.mockRejectedValueOnce(new Error('unavailable'));
    mock.realtime!();
    await (selected.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).not.toHaveBeenCalled();
    await settle();
    expect(review(moduleTree())).toBeUndefined();
  });
  it('preserves the selection after a failed confirmation so an explicit retry can succeed', async () => {
    const selected = review(await readyReview())!;
    mock.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'billing temporarily unavailable' }) });
    await (selected.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    const retry = review(moduleTree())!;
    expect(retry.props.initialPlan).toBe('plus_annual'); expect(retry.props.pending).toBe(false);
    await (retry.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
  it('suppresses the unrelated generic service-fee notice for this endpoint and stages a new query without payment', async () => {
    await readyReview();
    const tree = render(() => BillingModule({ serviceFeeNotice: 'UNRELATED_CHECKOUT_SERVICE_FEE' }));
    expect(html(tree)).not.toContain('UNRELATED_CHECKOUT_SERVICE_FEE');
    mock.checkout = 'view=manage&reviewPlan=basic_monthly';
    const changed = review(moduleTree())!;
    expect(changed.props.initialPlan).toBe('basic_monthly');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it.each(['canceled', 'incomplete_expired', 'missing-provider', 'cancel-scheduled'] as const)('allows explicit same-plan %s recovery without automatic mutation', async (kind) => {
    const subscription = row('family-a', 'plus_annual');
    if (kind === 'missing-provider') subscription.provider_ref = null;
    else if (kind === 'cancel-scheduled') subscription.cancel_at_period_end = true;
    else subscription.status = kind;
    mock.read.mockResolvedValue({ data: subscription, error: null });
    const selection = review(await readyReview())!;
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(selection.props.hasLiveSubscription).toBe(kind === 'cancel-scheduled');
    await (selection.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['partial', 'success', 'already-updated'] as const)('waits for authoritative readback after %s provider confirmation across query changes', async kind => {
    mock.read.mockResolvedValue({ data: row('family-a', 'basic'), error: null });
    const selection = review(await readyReview())!;
    mock.fetch.mockResolvedValueOnce({ ok: kind !== 'partial', json: async () => ({
      changed: kind === 'success', providerUpdated: kind !== 'success', providerRef: 'subscription-fixture',
      error: kind === 'partial' ? getMessages('en-US')['changePlan.stripeChangedThePlanBut'] : undefined,
    }) });
    await (selection.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    const waiting = review(moduleTree())!;
    expect(waiting.props.syncPending).toBe(true);
    await (waiting.props.onConfirm as (plan: string) => Promise<void>)('plus_monthly');
    mock.checkout = 'reviewPlan=basic_monthly';
    const changedQuery = review(moduleTree())!;
    expect(changedQuery.props.syncPending).toBe(true);
    expect(changedQuery.props.initialPlan).toBe('plus_annual');
    await (changedQuery.props.onConfirm as (plan: string) => Promise<void>)('plus_monthly');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    mock.read.mockRejectedValueOnce(new Error('status still unavailable'));
    await (changedQuery.props.onRefresh as () => Promise<void>)();
    const unavailableTree = moduleTree(); expect(review(unavailableTree)).toBeUndefined();
    await (unavailable(unavailableTree).props.onRetry as () => Promise<void>)(); await settle();
    let again = review(moduleTree())!;
    expect(again.props.syncPending).toBe(true);
    const cancelPending = row('family-a', 'plus_annual'); cancelPending.cancel_at_period_end = true;
    mock.read.mockResolvedValueOnce({ data: cancelPending, error: null });
    await (again.props.onRefresh as () => Promise<void>)();
    again = review(moduleTree())!; expect(again.props.syncPending).toBe(true);
    const wrongProvider = row('family-a', 'plus_annual'); wrongProvider.provider_ref = 'another-provider';
    mock.read.mockResolvedValueOnce({ data: wrongProvider, error: null });
    await (again.props.onRefresh as () => Promise<void>)();
    again = review(moduleTree())!; expect(again.props.syncPending).toBe(true);
    mock.read.mockResolvedValueOnce({ data: row('family-a', 'plus_annual'), error: null });
    await (again.props.onRefresh as () => Promise<void>)();
    moduleTree(); await settle();
    const resolved = review(moduleTree())!;
    expect(resolved.props.syncPending).toBe(false);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['query', 'role', 'realtime', 'legacy-query'] as const)('serializes the account and records provider completion when %s changes before the paid response', async kind => {
    mock.published = true;
    mock.read.mockResolvedValue({ data: row('family-a', 'basic'), error: null });
    const selected = review(await readyReview())!;
    let resolve!: (response: unknown) => void;
    mock.fetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const request = (selected.props.onConfirm as (plan: string) => Promise<void>)('plus_annual');
    if (kind === 'query') mock.checkout = 'reviewPlan=plus_monthly';
    if (kind === 'legacy-query') mock.checkout = 'checkout=plus';
    if (kind === 'role') mock.scope.role = 'child';
    if (kind === 'realtime') {
      mock.read.mockRejectedValueOnce(new Error('temporarily unavailable'));
      mock.realtime!(); await settle();
    }
    let tree = moduleTree();
    const newReview = review(tree);
    if (newReview) await (newReview.props.onConfirm as (plan: string) => Promise<void>)('plus_monthly');
    const legacy = nodes(tree).find(node => typeof node.props.onChoose === 'function');
    if (legacy) (legacy.props.onChoose as (plan: string) => void)('plus_monthly');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    resolve({ ok: false, json: async () => ({ providerUpdated: true, providerRef: 'subscription-fixture', error: getMessages('en-US')['changePlan.stripeChangedThePlanBut'] }) });
    await request;
    if (kind === 'role') mock.scope.role = 'parent';
    tree = moduleTree();
    const waiting = review(tree)!;
    expect(waiting).toBeDefined();
    expect(waiting.props.syncPending).toBe(true);
    expect(waiting.props.initialPlan).toBe('plus_annual');
    expect(nodes(tree).some(node => typeof node.props.onChoose === 'function')).toBe(false);
    await (waiting.props.onConfirm as (plan: string) => Promise<void>)('plus_monthly');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
});
