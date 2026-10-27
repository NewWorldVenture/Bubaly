import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const q = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>, loading: {} as Record<string, boolean>,
  errors: {} as Record<string, string | null>, stale: {} as Record<string, boolean>, refreshes: [] as string[],
  queries: [] as { table: string; familyId: string; deps: unknown[] }[],
  forbidden: vi.fn(() => { throw Error('No SDK/Auth/Storage/write/network operation in required-read UI fixture'); }),
}));
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks));
// Query outcomes are supplied before importing the real module. This never
// imports the live hook/cache/Auth coordinator or calls a query fetcher.
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (options: { table: string; familyId: string; deps: unknown[] }) => {
  q.queries.push({ table: options.table, familyId: options.familyId, deps: options.deps });
  return { data: q.rows[options.table] ?? [], loading: q.loading[options.table] ?? false,
    error: q.errors[options.table] ?? null, stale: q.stale[options.table] ?? false,
    refresh: () => { q.refreshes.push(options.table); q.loading[options.table] = false; q.errors[options.table] = null; return Promise.resolve(); } };
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: q.forbidden }));
vi.mock('@/lib/supabase/client', () => ({ createClient: q.forbidden }));
vi.mock('@/lib/supabase/server', () => ({ createServer: q.forbidden, createServiceClient: q.forbidden }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: q.forbidden }));
vi.mock('@/lib/storage/documents', () => ({ uploadFamilyDocument: q.forbidden, getDocumentSignedUrl: q.forbidden, removeFamilyDocument: q.forbidden }));
vi.mock('@/lib/storage/form-uploads', () => ({ FormUploads: class { constructor() { q.forbidden(); } } }));
vi.mock('@/components/medical/print-sheet', () => ({ ProviderInfoSheet: q.forbidden, CheckInSheet: q.forbidden }));
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
// ErrorState/SkeletonList stay real. No images or open forms are seeded, so no
// CardImage effect, upload session, clinical write or print sheet may run.
const { MedicalRecordsModule } = await import('@/components/modules/medical-records-module');
const tables = ['health_providers', 'insurance_policies', 'medical_profiles', 'medications'] as const;
const skeletons = (tree: ReturnType<typeof render>) => nodes(tree).filter(n => String(n.props.className).includes('animate-pulse'));
const own = { id: 'synthetic-self', display_name: 'Synthetic self', role: 'parent', is_active: true, user_id: 'synthetic-user', color: null, birthday: null };
const sibling = { ...own, id: 'synthetic-sibling', display_name: 'Synthetic sibling', role: 'child', user_id: 'synthetic-sibling-user' };
beforeEach(() => {
  resetHookSlots(h.hooks); q.rows = {}; q.loading = {}; q.errors = {}; q.stale = {}; q.refreshes = []; q.queries = []; q.forbidden.mockClear();
  Object.assign(h.app, { familyId: 'synthetic-family', userId: own.user_id, role: 'parent' });
  h.app.members = [own, sibling]; h.app.selfMember = own; h.toasts = { success: [], error: [] };
  vi.stubGlobal('fetch', q.forbidden);
});
afterEach(() => { expect(q.forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe.each(['medical', 'dental'] as const)('%s required read recovery', kind => {
  const screen = () => render(h.hooks, createElement(MedicalRecordsModule, { kind }));
  const healthy = (tree: ReturnType<typeof screen>) => expect(text(tree)).toContain('Insurance Cards');
  it.each(tables)('%s failure is visible despite a different required query still pending', async table => {
    q.errors[table] = 'Synthetic required read refused'; q.loading[tables.find(t => t !== table)!] = true;
    const tree = screen(); expect(text(tree)).toContain('Synthetic required read refused'); expect(skeletons(tree)).toHaveLength(0);
    await click(byName(tree, 'Try again', 'button'));
    expect(q.refreshes).toEqual([...tables]); healthy(screen());
  });
  it.each(tables)('%s settled error offers retry of all four reads and recovers', async table => {
    q.errors[table] = 'Synthetic required read refused'; const tree = screen();
    expect(text(tree)).toContain('Synthetic required read refused');
    await click(byName(tree, 'Try again', 'button'));
    expect(q.refreshes).toEqual([...tables]); expect(text(screen())).not.toContain('Synthetic required read refused'); healthy(screen());
  });
  it.each(tables)('%s initial pending read with no error preserves loading', table => {
    q.loading[table] = true; const tree = screen();
    expect(skeletons(tree).length).toBeGreaterThan(0); expect(text(tree)).not.toContain('Insurance Cards'); expect(q.refreshes).toEqual([]);
  });
  it('preserves populated authorized cached first paint without signing or uploading', () => {
    tables.forEach(t => { q.stale[t] = true; });
    q.rows.health_providers = [{ id: 'provider', family_id: 'synthetic-family', member_id: own.id, kind, name: 'Synthetic cached provider', is_primary: false }];
    q.rows.insurance_policies = [{ id: 'policy', family_id: 'synthetic-family', member_id: own.id, kind, insurer: 'Synthetic cached insurer', front_image_path: null, back_image_path: null }];
    const tree = screen(); healthy(tree); expect(text(tree)).toContain('Synthetic cached provider'); expect(text(tree)).toContain('Synthetic cached insurer');
    expect(skeletons(tree)).toHaveLength(0); expect(q.refreshes).toEqual([]);
  });
  it('preserves a legitimate empty cached view without invented errors', () => {
    tables.forEach(t => { q.stale[t] = true; }); const tree = screen(); healthy(tree);
    expect(text(tree)).toContain('No insurance on file'); expect(skeletons(tree)).toHaveLength(0); expect(q.refreshes).toEqual([]);
  });
  it.each(['parent', 'child', 'caregiver', 'guest'])('preserves %s provider/policy projections and edit visibility', role => {
    Object.assign(h.app, { role }); h.app.selfMember = { ...own, role }; h.app.members = [h.app.selfMember, sibling];
    q.rows.health_providers = [own, sibling].map(m => ({ id: m.id + '-provider', family_id: 'synthetic-family', member_id: m.id, kind, name: m.id + '-provider', is_primary: false }));
    q.rows.insurance_policies = [own, sibling].map(m => ({ id: m.id + '-policy', family_id: 'synthetic-family', member_id: m.id, kind, insurer: m.id + '-insurer', front_image_path: null, back_image_path: null }));
    const tree = screen(); healthy(tree); expect(text(tree)).toContain(own.id + '-provider'); expect(text(tree)).toContain(own.id + '-insurer');
    expect(text(tree).includes(sibling.id + '-provider')).toBe(role === 'parent' || role === 'caregiver');
    expect(text(tree).includes(sibling.id + '-insurer')).toBe(role === 'parent');
    expect(text(tree).includes('View only')).toBe(role !== 'parent'); expect(q.refreshes).toEqual([]);
  });
  it('retains all four own-family query registrations and existing kind dependencies', () => {
    screen(); expect(q.queries).toEqual(tables.map(table => ({ table, familyId: 'synthetic-family', deps: ['health_providers', 'insurance_policies'].includes(table) ? ['synthetic-family', kind] : ['synthetic-family'] })));
  });
});
