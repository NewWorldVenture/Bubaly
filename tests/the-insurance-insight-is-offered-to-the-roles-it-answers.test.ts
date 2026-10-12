import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isManager } from '@/lib/constants/roles';
import { mayAskInsight, MANAGER_ONLY_INSIGHTS } from '@/lib/ai/insights';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N2 — the Insurance Hub rendered its AI Assist button for every reader, but
// /api/ai/insights keeps the insurance kind to the managers (it summarises
// every policy's premium and coverage, family-wide). A child or teen on the
// page was offered a button whose every tap was a 403.
//
// The real page (module-harness) and the real route, asked as each role: the
// button is offered exactly when the route would answer.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const route = vi.hoisted(() => ({ role: 'parent', memberId: 'member-1', complete: vi.fn() }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
// The button itself, as a host element the test can find by its kind.
vi.mock('@/components/ai/ai-insight', async () => {
  const { createElement: el } = await import('react');
  return { AiInsight: ({ kind }: { kind: string }) => el('button', { type: 'button', 'aria-label': `AI Assist: ${kind}`, 'data-insight': kind }) };
});

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: h.app.familyId, role: route.role, member: { id: route.memberId }, family: { timezone: 'UTC', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: route.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { InsuranceModule } = await import('@/components/modules/insurance-module');
const { POST } = await import('@/app/api/ai/insights/route');

const FAMILY = h.app.familyId;
const ROLES = ['parent', 'adult', 'caregiver', 'teen', 'child', 'guest'] as const;

beforeEach(() => {
  resetHookSlots(h.hooks);
  const db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
  db.seed('family_insurance_policies', [
    { id: 'p1', family_id: FAMILY, policy_type: 'home', insurer: 'Acme Mutual', premium_amount: 120, premium_frequency: 'monthly', renewal_date: '2026-11-01', member_id: null, is_active: true },
  ]);
  route.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function as(role: string) {
  route.role = role;
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = { id: 'member-1', display_name: 'Ada', role, is_active: true, color: null, birthday: null };
}
const offered = () => nodes(render(h.hooks, createElement(InsuranceModule))).some((n) => n.props['data-insight'] === 'insurance');
const asked = () => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'insurance' }),
}));

describe('the Insurance Hub offers its AI Assist only to the roles the route answers', () => {
  it('a child and a teen are not offered it; a parent and an adult are', () => {
    as('child'); expect(offered()).toBe(false);
    resetHookSlots(h.hooks); as('teen'); expect(offered()).toBe(false);
    resetHookSlots(h.hooks); as('parent'); expect(offered()).toBe(true);
    resetHookSlots(h.hooks); as('adult'); expect(offered()).toBe(true);
  });

  it.each(ROLES)('%s: the button is on the page exactly when the route would answer', async (role) => {
    as(role);
    const shown = offered();
    const response = await asked();
    expect(shown, `offered to ${role}, route answered ${response.status}`).toBe(response.status === 200);
    expect(shown).toBe(isManager(role));
  });

  it('the page and the route share one rule for every manager-only kind', () => {
    for (const kind of MANAGER_ONLY_INSIGHTS) {
      for (const role of ROLES) expect(mayAskInsight(kind, role), `${kind} as ${role}`).toBe(isManager(role));
    }
    for (const role of ROLES) expect(mayAskInsight('chores', role)).toBe(true);
  });
});
