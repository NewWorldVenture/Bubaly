import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expand } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Actual component, FamilyClock and wall-time conversion. Only app/UI and the
// read transport are modelled; no auth, cache, Storage or dose writes run here.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
type Query = { table: string; familyId: string; deps: unknown[]; fetcher: (sb: unknown) => unknown };
const reads = vi.hoisted(() => new Map<string, Query>());
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => {
  reads.set(query.table, query);
  return { data: [], loading: false, error: null, stale: false, refreshAndConfirm: async () => ({ ok: true }) };
} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw Error('Unexpected live client'); } }));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
const { MedicationsModule } = await import('@/components/modules/medications-module');
// Inspect the actual render's read configuration, before any effects or write
// callbacks. This also avoids modelling the component's no-deps write-layout
// effect as a state change (the generic harness would render it indefinitely).
const screen = () => { h.hooks.pending = []; return expand(createElement(MedicationsModule), h.hooks); };

function doseRead() {
  const query = reads.get('medication_doses')!;
  const filters: { op: string; column: string; value: string }[] = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: string) => { filters.push({ op: 'eq', column, value }); return builder; },
    gte: (column: string, value: string) => { filters.push({ op: 'gte', column, value }); return builder; },
  };
  query.fetcher({ from: (table: string) => { expect(table).toBe('medication_doses'); return builder; } });
  return { query, filters, lower: filters.find(f => f.column === 'scheduled_for')!.value };
}

beforeEach(() => {
  resetHookSlots(h.hooks); reads.clear(); h.timeZone = 'UTC';
  Object.assign(h.app, { role: 'parent', familyId: 'synthetic-family', userId: 'synthetic-user' });
  h.app.family = { timezone: 'UTC' }; h.app.selfMember = { id: 'synthetic-member' }; h.app.members = [];
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-07T12:00:00Z'));
  vi.stubGlobal('window', { setInterval: vi.fn(), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', () => { throw Error('Unexpected outbound request'); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('medication history reads use the household calendar', () => {
  it.each([
    ['UTC', '2026-04-07T12:00:00Z', '2026-03-08T00:00:00.000Z'],
    ['America/New_York', '2026-04-07T12:00:00Z', '2026-03-08T05:00:00.000Z'],
    ['America/New_York', '2026-12-01T12:00:00Z', '2026-11-01T04:00:00.000Z'],
    ['Pacific/Auckland', '2026-04-07T12:00:00Z', '2026-03-08T11:00:00.000Z'],
  ])('starts at household midnight in %s at %s', (zone, now, expected) => {
    vi.setSystemTime(new Date(now)); h.timeZone = zone; h.app.family.timezone = zone; screen();
    const { lower, filters } = doseRead();
    expect(lower).toBe(expected);
    expect(filters).toContainEqual({ op: 'eq', column: 'family_id', value: 'synthetic-family' });
    // The inclusive read admits the exact boundary and rejects the preceding
    // instant; it does not move the family's day to the viewer's midnight.
    expect(Date.parse(expected) >= Date.parse(lower)).toBe(true);
    expect(Date.parse(expected) - 1 >= Date.parse(lower)).toBe(false);
  });

  it('changes both the bound and read dependencies when the zone changes on the same date', () => {
    screen(); const first = doseRead();
    h.timeZone = 'America/New_York'; h.app.family.timezone = h.timeZone; screen(); const next = doseRead();
    expect(first.lower).toBe('2026-03-08T00:00:00.000Z');
    expect(next.lower).toBe('2026-03-08T05:00:00.000Z');
    expect(next.query.deps).not.toEqual(first.query.deps);
  });

  it.each(['child', 'caregiver', 'guest'])('retains own-member dose restriction for %s', role => {
    Object.assign(h.app, { role }); screen();
    expect(doseRead().filters).toContainEqual({ op: 'eq', column: 'member_id', value: 'synthetic-member' });
  });
});
