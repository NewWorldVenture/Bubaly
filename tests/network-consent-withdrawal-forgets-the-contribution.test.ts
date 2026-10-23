// Leaving the Intelligence Network, and what the network shows a family.
//
// N8 — "Left the network — nothing is shared", and the panel's "leaving stops
// all sharing immediately", were a consent write and nothing else. The
// family's stored contribution row stayed in network_contributions until a
// nightly run got all the way to its prune, and every aggregate built from it
// stayed published with it — for as long as the cron kept failing. The design
// doc's §2.7 promises the row is deleted at once; now it is, on leaving and on
// switching a scope off.
//
// N9 — the insight badge printed "{n} families" with n = the TRUE number of
// families behind the band, beside the noised "About {count} similar
// families" detail: the noise cancelled, inside the app.
//
// Driven through the real IntelligenceModule on hook slots, against the
// in-memory database, as tests/network-consent-is-written-from-the-row-on-screen.test.ts.
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import type { NetworkInsight } from '@/lib/network/insights';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const NEIGHBOUR = '0f0f0f0f-0000-4000-8000-000000000002';
const JOIN = 'Join the network';
const TIMING = 'Timing patterns';
const BENCHMARKS = 'Gentle benchmarks';
let db: InMemorySupabase;

const screen = (props: Parameters<typeof IntelligenceModule>[0] = {}) => render(h.hooks, createElement(IntelligenceModule, props));
const contributionsOf = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1', role: 'parent' });
  db.seed('network_consent', [{
    id: 'consent-1', family_id: FAMILY, enabled: true,
    scopes: { timing: false, benchmarks: true, recommendations: false },
    consented_by: 'user-1', consented_at: '2026-10-01T00:00:00.000Z',
  }]);
  db.seed('network_contributions', [
    { family_id: FAMILY, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } },
    { family_id: NEIGHBOUR, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } },
  ]);
});

describe('leaving the network forgets what the family contributed, at once', () => {
  it('leaving deletes the family\'s stored contribution — and only the family\'s', async () => {
    await click(byName(screen(), JOIN));
    expect(db.table('network_consent')[0]).toMatchObject({ enabled: false });
    expect(contributionsOf(FAMILY)).toEqual([]);
    expect(contributionsOf(NEIGHBOUR)).toHaveLength(1);
    expect(h.toasts.success).toEqual(['Left the network — nothing is shared']);
  });

  it('switching a scope off deletes it too; the next nightly run rebuilds what is still consented', async () => {
    await click(byName(screen(), BENCHMARKS));
    expect(db.table('network_consent')[0].scopes).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(contributionsOf(FAMILY)).toEqual([]);
  });

  it('switching a scope ON shares nothing new now and forgets nothing', async () => {
    await click(byName(screen(), TIMING));
    expect(db.table('network_consent')[0].scopes).toMatchObject({ timing: true, benchmarks: true });
    expect(contributionsOf(FAMILY)).toHaveLength(1);
  });

  it('a refused delete is said, not covered by "nothing is shared"', async () => {
    h.fault = (table, calls) => (table === 'network_contributions' && calls.includes('delete') ? { message: 'permission denied for table network_contributions', code: '42501' } : null);
    await click(byName(screen(), JOIN));
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
    expect(h.toasts.error[0]).not.toContain('permission denied for table'); // no raw database message
    expect(contributionsOf(FAMILY)).toHaveLength(1);
  });
});

describe('an insight shows the noised count and nothing truer', () => {
  const insight = (over: Partial<NetworkInsight> = {}): NetworkInsight => ({
    id: 'dinner_habit:often (4–5)', scope: 'benchmarks', title: 'Families like yours: dinner planning',
    detail: 'About 49 similar families report “often (4–5)”.', count: 49, confidence: 'medium', ...over,
  });

  it('renders the detail and the confidence, and no family count of its own', () => {
    const tree = screen({ candidates: [insight()] });
    const item = nodes(tree).find((n) => n.type === 'li' && text(n).includes('Families like yours'));
    expect(item).toBeDefined();
    // title, the confidence badge, the detail — and the detail's noised 49 is the only number
    expect(text(item)).toBe('Families like yours: dinner planningmediumAbout 49 similar families report “often (4–5)”.');
  });

  it('never prints a true band size, even when a caller still hands one over', () => {
    // What the page passed before: the candidate with its true size on it.
    const legacy = { ...insight(), cohortSize: 47 } as NetworkInsight;
    const tree = screen({ candidates: [legacy] });
    expect(text(tree)).not.toContain('47');
    expect(text(tree)).toContain('49');
  });

  it('hides an insight whose scope the family has switched off, without a reload', async () => {
    let tree = screen({ candidates: [insight()] });
    expect(text(tree)).toContain('About 49 similar families');
    await click(byName(tree, BENCHMARKS));
    tree = screen({ candidates: [insight()] });
    expect(text(tree)).not.toContain('About 49 similar families');
  });
});
