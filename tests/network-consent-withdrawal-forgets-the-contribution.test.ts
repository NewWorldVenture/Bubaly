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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // N8 (round 2): `timing` and `recommendations` have no metric, so switching
  // one off forgets nothing — and the delete cost the family its weekly-digest
  // compare line (which reads this row) until the next nightly run rebuilt it.
  it('switching off a scope that contributes nothing keeps the stored contribution', async () => {
    Object.assign(db.table('network_consent')[0], { scopes: { timing: true, benchmarks: true, recommendations: true } });
    let tree = screen();
    await click(byName(tree, TIMING));
    tree = screen();
    await click(byName(tree, 'Crowd-rated suggestions'));
    expect(db.table('network_consent')[0].scopes).toEqual({ timing: false, benchmarks: true, recommendations: false });
    expect(h.toasts.success).toEqual(['Preferences saved', 'Preferences saved']);
    expect(contributionsOf(FAMILY)).toHaveLength(1);
    // … while the scope that does contribute still takes it with it.
    await click(byName(screen(), BENCHMARKS));
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

// N7 (round 2): the nightly aggregation drops a consent whose author is an
// active member who may not give it (consentsByNonManagers) — a consent a teen
// switched on before 0353, or one a parent gave before being made a caregiver.
// The module still told the family "You're contributing", and a manager's
// later scope switch wrote only `scopes`, so nothing short of leaving and
// rejoining ever made the consent count.
describe('a consent its author may not give is said, and a manager\'s switch takes it over', () => {
  const CONTRIBUTING = 'You’re contributing anonymized patterns and can see network insights.';
  const NEEDS_A_MANAGER = 'Sharing was switched on by a family member who can’t give consent for the household, so nothing is shared yet. A parent or adult confirms it by changing any option below, or by leaving and joining again.';
  const roster = h.app.members;
  beforeEach(() => {
    h.app.members = [
      { id: 'member-1', user_id: 'user-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
      { id: 'member-2', user_id: 'teen-user', display_name: 'Sam', role: 'teen', is_active: true, color: null, birthday: null },
    ];
  });
  afterEach(() => { h.app.members = roster; });

  it('tells the family a manager must confirm a consent a teen gave, instead of "you\'re contributing"', () => {
    Object.assign(db.table('network_consent')[0], { consented_by: 'teen-user' });
    const shown = text(screen());
    expect(shown).toContain(NEEDS_A_MANAGER);
    expect(shown).not.toContain(CONTRIBUTING);
  });

  it('control: a consent a parent gave reads as contributing', () => {
    expect(text(screen())).toContain(CONTRIBUTING);
    expect(text(screen())).not.toContain(NEEDS_A_MANAGER);
  });

  it('a manager\'s scope switch records the manager as the consent\'s author, and the notice goes', async () => {
    Object.assign(db.table('network_consent')[0], { consented_by: 'teen-user' });
    await click(byName(screen(), TIMING));
    const stored = db.table('network_consent')[0];
    expect(stored).toMatchObject({ enabled: true, consented_by: 'user-1', scopes: { timing: true, benchmarks: true } });
    expect(stored.consented_at).not.toBe('2026-10-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(stored.consented_at as string))).toBe(false);
    expect(text(screen())).toContain(CONTRIBUTING);
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
