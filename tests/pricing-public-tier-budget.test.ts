import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

type Mode = 'healthy' | 'absent' | 'malformed' | 'error' | 'hold' | 'body' | 'token' | 'constructor';
const state = vi.hoisted(() => ({
  mode: 'healthy' as Mode,
  releases: [] as (() => void)[],
  signals: [] as (AbortSignal | null | undefined)[],
  overrideValue: undefined as unknown,
  makeClient: undefined as undefined | (() => ReturnType<typeof createClient>),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.makeClient!() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/seo', () => ({ resolveMarketingMetadata: () => ({}) }));
vi.mock('@/lib/marketing/stats', () => ({ getPublicStats: async () => ({ families: 40, handledCompleted: 80, handled30d: 30 }) }));
vi.mock('@/lib/marketing/reputation-server', () => ({ getPublishedCaseStudies: async () => [] }));
vi.mock('@/lib/marketing/handled-sample', () => ({ sampleBriefNumbers: () => ({ today: 1, clashes: 2, handled: 3, minutes: 4 }) }));
vi.mock('@/components/marketing/switching-band', () => ({ SwitchingBand: () => null }));
vi.mock('@/components/marketing/marketing-aeo-section', () => ({ MarketingAeoSection: () => null }));
vi.mock('@/app/(marketing)/pricing/pricing-content', () => ({ PricingContent: () => null }));

import PricingPage from '@/app/(marketing)/pricing/page';
import { getPricingFeatureTiers } from '@/lib/marketing/pricing-tiers';
import { getResolvedFeatureTiers } from '@/lib/server/feature-tiers';

async function hold() { await new Promise<void>(resolve => state.releases.push(resolve)); }
async function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  expect(url.origin).toBe('https://pricing-audit.invalid');
  expect(url.pathname).toBe('/rest/v1/app_settings');
  expect(url.searchParams.get('key')).toBe('eq.feature_tiers');
  expect(url.searchParams.get('select')).toBe('value');
  state.signals.push(init?.signal);
  if (state.mode === 'hold') await hold(); // Ignores abort, deliberately.
  if (state.mode === 'error') return Response.json({ message: 'Synthetic outage' }, { status: 503 });
  const response = Response.json(state.mode === 'absent' ? [] : [{
    value: state.mode === 'malformed' ? ['not-an-override-map'] : state.overrideValue,
  }]);
  if (state.mode === 'body') {
    const text = response.text.bind(response);
    response.text = async () => { await hold(); return text(); };
  }
  return response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected real fetch'); });
  state.mode = 'healthy'; state.releases = []; state.signals = [];
  state.overrideValue = { calendar: 'basic', recipes: 'off', 'unknown-feature': 'plus', 'ai-assistant': 'invalid' };
  state.makeClient = () => {
    if (state.mode === 'constructor') throw new Error('Synthetic client unavailable');
    return createClient('https://pricing-audit.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
      ...(state.mode === 'token' ? { accessToken: async () => { await hold(); return 'synthetic-token'; } } : {}),
    });
  };
});
afterEach(async () => {
  state.releases.splice(0).forEach(release => release());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function matrix(tree: Awaited<ReturnType<typeof PricingPage>>) {
  return tree.props.children[0].props.featureMatrix as { section: string; items: { label: string; tier: FeatureTier }[] }[];
}
function calendar(tree: Awaited<ReturnType<typeof PricingPage>>) {
  return matrix(tree).flatMap(section => section.items).find(item => item.label === 'Calendar')?.tier;
}

describe('the public pricing matrix does not borrow entitlement deadlines', () => {
  it('preserves healthy admin tiers, off exclusions and invalid-key defaults', async () => {
    const page = await PricingPage();
    expect(calendar(page)).toBe('basic');
    expect(matrix(page).flatMap(section => section.items).some(item => item.label === 'Recipes')).toBe(false);
    expect(treeProps(page).familiesCount).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['off', 'free', 'basic', 'plus'] as const)('preserves the public %s override and agrees with the unchanged shared resolver', async tier => {
    state.overrideValue = { calendar: tier, recipes: 'off', 'unknown-feature': 'plus' };
    expect(await getPricingFeatureTiers()).toEqual(await getResolvedFeatureTiers(state.makeClient!()));
    expect(calendar(await PricingPage())).toBe(tier === 'off' ? undefined : tier);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not-a-tier', null, 5, true, {}, ['plus']])('keeps the shared invalid-value fallback for %j', async invalid => {
    state.overrideValue = { calendar: invalid, recipes: 'off', 'unknown-feature': 'plus' };
    const publicResult = await getPricingFeatureTiers();
    expect(publicResult).toEqual(await getResolvedFeatureTiers(state.makeClient!()));
    expect(publicResult.calendar).toBe('free');
    expect(publicResult.recipes).toBe('off');
    expect(publicResult).not.toHaveProperty('unknown-feature');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['absent', 'malformed', 'constructor'] as const)('keeps the existing public catalog fallback for %s configuration', async mode => {
    state.mode = mode;
    const page = await PricingPage();
    expect(calendar(page)).toBe('free');
    expect(treeProps(page).familiesCount).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['hold', 'body', 'token'] as const)('includes %s waiting in the same four-second page read budget', async mode => {
    state.mode = mode;
    let settled = false;
    const pending = PricingPage().then(page => { settled = true; return page; });
    try {
      await vi.advanceTimersByTimeAsync(3_999); expect(settled).toBe(false);
      if (mode === 'token') expect(state.signals).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2); expect(settled).toBe(true);
      const page = await pending;
      expect(calendar(page)).toBe('free'); expect(treeProps(page).familiesCount).toBe(40);
      state.releases.splice(0).forEach(release => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(state.signals.every(signal => signal?.aborted)).toBe(true);
      expect(calendar(page)).toBe('free'); expect(vi.getTimerCount()).toBe(0);
    } finally { state.releases.splice(0).forEach(release => release()); await pending; }
  });

  it('bounds SDK retry backoff without changing retry settings or caching the fallback', async () => {
    state.mode = 'error';
    let settled = false;
    const pending = PricingPage().then(page => { settled = true; return page; });
    try {
      await vi.advanceTimersByTimeAsync(4_001);
      expect(settled).toBe(true); expect(calendar(await pending)).toBe('free');
      const attempts = state.signals.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.signals).toHaveLength(attempts); expect(vi.getTimerCount()).toBe(0);
      state.mode = 'healthy';
      expect(calendar(await PricingPage())).toBe('basic');
      expect(state.signals.length).toBeGreaterThan(attempts);
    } finally { await vi.advanceTimersByTimeAsync(8_000); await pending; }
  });
});

function treeProps(tree: Awaited<ReturnType<typeof PricingPage>>) {
  return tree.props.children[0].props as { familiesCount: number };
}
