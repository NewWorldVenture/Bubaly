// N2 — the network consent toggles wrote from a stale snapshot.
//
// `network_consent` is not in REALTIME_TABLES, so no channel moves the screen,
// and `persist()` upserted and never read back: `consent` kept the page-load
// row. Each toggle builds the next write from it, so after "Leave network"
// landed the switch still read on and the scopes stayed visible, and a tap on a
// scope wrote `enabled: true` with consented_at = now — the family was back in
// the network without a parent meaning it. Turning scope A off and then scope B
// off wrote A back on. The nightly aggregation honours whatever is stored.
//
// Driven through the real IntelligenceModule on hook slots, against the
// in-memory database: the screen changes only when the component itself reads
// or writes back, exactly as with the real hook for an unpublished table.
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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
// Leaving and a contributing scope's switch-off are written by the real
// server action (app/(app)/dashboard/intelligence/actions.ts) through the
// member's own client, here the same in-memory database; the session is stubbed.
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId, email: null },
    active: { familyId: h.app.familyId, role: (h.app as { role?: string }).role ?? 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createServer: async () => clientFor(h), createServiceClient: () => h.db };
});

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const JOIN = 'Join the network';
const TIMING = 'Timing patterns';
const BENCHMARKS = 'Gentle benchmarks';
let db: InMemorySupabase;

const screen = () => render(h.hooks, createElement(IntelligenceModule, {}));
const stored = () => db.table('network_consent').find((r) => r.family_id === FAMILY)!;
const switchOn = (tree: ReturnType<typeof screen>, name: string) => byName(tree, name).props['aria-checked'];

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1', role: 'parent' });
  db.seed('network_consent', [{
    id: 'consent-1', family_id: FAMILY, enabled: true,
    scopes: { timing: true, benchmarks: true, recommendations: false },
    consented_by: 'user-1', consented_at: '2026-10-01T00:00:00.000Z',
  }]);
});

describe('network consent is written from the row on screen', () => {
  it('leaving the network shows as left, so no later tap can rejoin it', async () => {
    let tree = screen();
    expect(switchOn(tree, JOIN)).toBe(true);

    await click(byName(tree, JOIN));
    expect(stored()).toMatchObject({ enabled: false, consented_by: null, consented_at: null });
    expect(h.toasts.success).toEqual(['Left the network. Your data is no longer used and your stored contribution is deleted. Summaries already published this month keep your share, mixed with at least 20 families and noise, until next month’s update.']);

    tree = screen();
    expect(switchOn(tree, JOIN)).toBe(false);
    // The scope switches are drawn only for a family in the network.
    expect(allByName(tree, TIMING)).toEqual([]);
    expect(allByName(tree, BENCHMARKS)).toEqual([]);
    expect(stored().enabled).toBe(false);
  });

  it('a second scope switched off leaves the first one off', async () => {
    let tree = screen();
    await click(byName(tree, TIMING));
    expect(stored().scopes).toEqual({ timing: false, benchmarks: true, recommendations: false });

    tree = screen();
    expect(switchOn(tree, TIMING)).toBe(false);
    await click(byName(tree, BENCHMARKS));
    expect(stored().scopes).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(stored().enabled).toBe(true);
  });

  it('a scope switch never joins the network on its own', async () => {
    const tree = screen();
    // The family left in another tab; this screen still holds the joined row.
    Object.assign(stored(), { enabled: false, consented_by: null, consented_at: null });
    await click(byName(tree, TIMING));
    expect(stored().enabled).toBe(false);
    expect(stored().consented_at).toBeNull();
  });

  it('holds every toggle until the row it wrote is on screen, and says so when nothing was written', async () => {
    let tree = screen();
    const write = click(byName(tree, TIMING));
    tree = screen();
    expect(byName(tree, JOIN).props.disabled).toBe(true);
    expect(byName(tree, BENCHMARKS).props.disabled).toBe(true);
    await write;
    tree = screen();
    expect(byName(tree, JOIN).props.disabled).toBe(false);

    // A write that matched no row (the row is gone, or RLS filtered it) is not
    // "Preferences saved".
    db.replace('network_consent', []);
    h.toasts = { success: [], error: [] };
    await click(byName(tree, BENCHMARKS));
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual(["That change wasn't saved — you may not have permission. Refresh and try again."]);
  });
});
