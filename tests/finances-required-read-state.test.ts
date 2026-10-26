import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Real FinancesModule and financial aggregation helpers. Query outcomes are
// synthetic; no SDK reads, actions, providers, money movement or native Auth.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
type ReadState = { data: Record<string, unknown>[]; loading: boolean; stale: boolean; error: string | null };
const live = vi.hoisted(() => ({ reads: {} as Record<string, ReadState>, refreshes: [] as string[] }));
const slots = ['accounts', 'recent', 'month', 'budgets', 'bills', 'goals'] as const;
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: ({ table, deps }: { table: string; deps: unknown[] }) => {
    const slot = table === 'transactions' ? deps.length > 1 ? 'month' : 'recent'
      : ({ financial_accounts: 'accounts', budgets: 'budgets', bills: 'bills', savings_goals: 'goals' } as Record<string, string>)[table];
    if (!slot || !live.reads[slot]) throw new Error('Unexpected finance read');
    return { ...live.reads[slot], refresh: async () => {
      live.refreshes.push(slot);
      live.reads[slot] = { ...live.reads[slot], loading: false, stale: false, error: null };
    } };
  },
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('Unexpected SDK call'); } }));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({ createTransactionAction: () => { throw new Error('Unexpected financial write'); } }));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/ui/states', () => ({
  SkeletonList: () => createElement('div', { role: 'status' }, 'Awaiting verified finance reads'),
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => createElement('div', { role: 'alert' },
    message, createElement('button', { onClick: onRetry }, 'Retry finance reads')),
}));
const { FinancesModule } = await import('@/components/modules/finances-module');
const show = () => render(h.hooks, createElement(FinancesModule));
const hasRole = (role: string) => nodes(show()).some(node => node.props.role === role);

beforeEach(() => {
  resetHookSlots(h.hooks);
  live.refreshes = [];
  for (const slot of slots) live.reads[slot] = { data: [], loading: false, stale: false, error: null };
  live.reads.accounts.data = [{ id: 'account-1', family_id: h.app.familyId, name: 'Synthetic checking', type: 'checking', balance: 1234, currency: 'USD' }];
});

describe('required finance read verification', () => {
  for (const slot of slots) {
    it(`hides cached totals while ${slot} has not been revalidated`, () => {
      live.reads[slot].stale = true;
      expect(hasRole('status')).toBe(true);
      expect(text(show())).not.toContain('$1,234');
      expect(hasRole('alert')).toBe(false);
    });
    it(`exposes ${slot} failure even while a different read is pending`, () => {
      live.reads[slot].error = 'Synthetic unavailable';
      live.reads[slot].stale = true;
      live.reads[slots[(slots.indexOf(slot) + 1) % slots.length]].loading = true;
      expect(hasRole('alert')).toBe(true);
      expect(hasRole('status')).toBe(false);
      expect(text(show())).not.toContain('$1,234');
    });
    it(`waits for ${slot} initial loading before showing totals`, () => {
      live.reads[slot].loading = true;
      expect(hasRole('status')).toBe(true);
      expect(text(show())).not.toContain('$1,234');
    });
  }
  it('shows the independently verified healthy account balance', () => {
    expect(text(show())).toContain('$1,234');
    expect(hasRole('status')).toBe(false);
    expect(hasRole('alert')).toBe(false);
  });
  it('allows genuine verified empty reads to show a zero balance', () => {
    live.reads.accounts.data = [];
    expect(text(show())).toContain('$0');
    expect(hasRole('status')).toBe(false);
    expect(hasRole('alert')).toBe(false);
  });
  it('reveals the balance only after the final stale read becomes current', () => {
    live.reads.accounts.stale = true;
    live.reads.goals.stale = true;
    expect(text(show())).not.toContain('$1,234');
    live.reads.accounts.stale = false;
    expect(text(show())).not.toContain('$1,234');
    live.reads.goals.stale = false;
    expect(text(show())).toContain('$1,234');
  });
  it('retry refreshes all required reads and recovers the healthy balance', async () => {
    live.reads.accounts.error = 'Synthetic unavailable';
    live.reads.accounts.stale = true;
    expect(hasRole('alert')).toBe(true);
    await click(byName(show(), 'Retry finance reads', 'button'));
    expect(live.refreshes.sort()).toEqual([...slots].sort());
    expect(text(show())).toContain('$1,234');
    expect(hasRole('alert')).toBe(false);
  });
});
