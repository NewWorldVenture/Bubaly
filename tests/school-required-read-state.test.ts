import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const s = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  loading: {} as Record<string, boolean>, errors: {} as Record<string, string | null>,
  stale: {} as Record<string, boolean>, refreshes: [] as string[],
  queries: [] as { table: string; familyId: string; deps: unknown[] }[],
  forbidden: vi.fn(() => { throw Error('No live read/action/transport in outer School UI fixture'); }),
}));
// Only the outer render boundary is exercised. Suppress the inbox desk effect;
// existing dedicated desk fixtures cover its lifecycle. No real query hook,
// Auth/cache/coordinator, SDK factory, desk action or fetch may be invoked.
vi.mock('react', async original => ({
  ...(await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks),
  useEffect: () => undefined,
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (options: { table: string; familyId: string; deps: unknown[] }) => {
  s.queries.push({ table: options.table, familyId: options.familyId, deps: options.deps });
  return { data: s.rows[options.table] ?? [], loading: s.loading[options.table] ?? false,
    error: s.errors[options.table] ?? null, stale: s.stale[options.table] ?? false,
    refresh: () => { s.refreshes.push(options.table); s.errors[options.table] = null; s.loading[options.table] = false; return Promise.resolve(); } };
} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: s.forbidden }));
vi.mock('@/lib/supabase/server', () => ({ createServer: s.forbidden, createServiceClient: s.forbidden }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: s.forbidden }));
vi.mock('@/app/(app)/dashboard/school/actions', () => ({ proposeFrontDeskAction: s.forbidden }));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// ErrorState and SkeletonList are real: retry visibility is a rendered control,
// not a test-only prop spy or a copied conditional.
const { SchoolModule } = await import('@/components/modules/school-module');
const tables = ['school_events', 'school_classes', 'grades'] as const;
const screen = () => render(h.hooks, createElement(SchoolModule));
const skeletons = (tree: ReturnType<typeof screen>) => nodes(tree).filter(n => String(n.props.className).includes('animate-pulse'));
beforeEach(() => {
  resetHookSlots(h.hooks); s.rows = {}; s.loading = {}; s.errors = {}; s.stale = {}; s.refreshes = []; s.queries = []; s.forbidden.mockClear();
  Object.assign(h.app, { familyId: 'school-family', userId: 'school-parent', role: 'guest' });
  h.app.members = [{ id: 'student', display_name: 'Synthetic student', role: 'child', is_active: true }];
  h.timeZone = 'UTC'; h.toasts = { success: [], error: [] };
  vi.stubGlobal('fetch', s.forbidden);
});
afterEach(() => { expect(s.forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('School required read errors and cache-compatible recovery', () => {
  it.each(tables)('%s refusal remains visible while another required query is pending', async table => {
    s.errors[table] = 'Synthetic school read refused'; s.loading[tables.find(t => t !== table)!] = true;
    const tree = screen();
    expect(text(tree)).toContain('Synthetic school read refused'); expect(skeletons(tree)).toHaveLength(0);
    await click(byName(tree, 'Try again', 'button'));
    expect(s.refreshes).toEqual([...tables]);
    expect(text(screen())).toContain('Assignments Due');
  });
  it.each(tables)('%s error offers a retry of all required reads and recovers', async table => {
    s.errors[table] = 'Synthetic school read refused'; const tree = screen();
    expect(text(tree)).toContain('Synthetic school read refused');
    await click(byName(tree, 'Try again', 'button'));
    expect(s.refreshes).toEqual([...tables]); expect(text(screen())).not.toContain('Synthetic school read refused');
    expect(text(screen())).toContain('Assignments Due');
  });
  it.each(tables)('%s healthy initial pending read retains the loading state', table => {
    s.loading[table] = true; const tree = screen();
    expect(skeletons(tree).length).toBeGreaterThan(0); expect(text(tree)).not.toContain('Assignments Due');
    expect(s.refreshes).toEqual([]);
  });
  it('keeps authorized populated cached school rows on stale first paint', async () => {
    tables.forEach(table => { s.stale[table] = true; });
    s.rows.school_classes = [{ id: 'class', member_id: 'student', subject: 'Synthetic cached algebra', day_of_week: null, time_slot: '09:00' }];
    const tree = screen(); expect(text(tree)).toContain('Synthetic cached algebra'); expect(skeletons(tree)).toHaveLength(0);
    await click(byName(tree, 'Classes', 'button')); expect(text(screen())).toContain('Synthetic cached algebra');
    expect(s.refreshes).toEqual([]);
  });
  it('keeps a legitimate empty cached view without an invented refusal', () => {
    tables.forEach(table => { s.stale[table] = true; });
    const tree = screen(); expect(text(tree)).toContain('Assignments Due'); expect(skeletons(tree)).toHaveLength(0);
    expect(text(tree)).not.toContain('Synthetic school read refused'); expect(s.refreshes).toEqual([]);
  });
  it.each(['parent', 'child', 'guest'])('preserves %s desk visibility without executing desk reads', role => {
    Object.assign(h.app, { role }); const tree = screen();
    expect(text(tree)).toContain('Assignments Due');
    expect(text(tree).includes('School & Sports desk')).toBe(role !== 'guest');
    expect(s.refreshes).toEqual([]);
  });
  it('registers only the three existing own-family query scopes', () => {
    screen(); expect(s.queries).toEqual(tables.map(table => ({ table, familyId: 'school-family', deps: ['school-family'] })));
  });
});
