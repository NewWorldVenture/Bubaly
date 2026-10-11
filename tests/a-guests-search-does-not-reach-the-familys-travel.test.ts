// search.household files under 'tasks', so the executor waved it through for
// every role — and it answered what the assistant's own reads of the same
// records refuse. A guest asking the assistant to "search for Tokyo" learned
// where the family would be and when, from `trips` and `vacations`, and every
// non-manager got document titles and expiry dates that `documents.*` and the
// manager-only documents slice keep from them.
//
// This drives the tool exactly as POST /api/ai offers it — `toToolSpecs` over
// the member's scope, then the spec's own `execute`, which is `executeTool` —
// against an in-memory household, so the gate, the tool and the service all
// run for real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { toToolSpecs } from '@/lib/ai/tools/legacy-adapter';
import { searchHousehold } from '@/lib/services/search';

const FAMILY = 'fam-1';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const scopeFor = (role: ServiceScope['role']): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-reader', memberId: 'mem-reader', role, actorKind: 'ai', tz: 'UTC',
  now: new Date('2026-10-05T16:00:00Z'),
});

type Hit = { kind: string; table: string; title: string };
type SearchData = { hits: Hit[]; withheld: string[]; unavailable: string[] };

/** The `search_household` spec the assistant route hands the model, called as the model would. */
async function assistantSearch(role: ServiceScope['role'], query: string): Promise<SearchData> {
  const spec = toToolSpecs(scopeFor(role), { names: ['search.household'] }).find((s) => s.name === 'search_household');
  if (!spec) throw new Error('search_household is not offered to the assistant');
  const result = await spec.execute({ query }) as { ok: boolean; data?: SearchData; error?: string };
  expect(result.ok, result.error).toBe(true);
  return result.data!;
}

const tables = (data: SearchData) => [...new Set(data.hits.map((h) => h.table))].sort();

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] } }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('vacations', [{ id: 'v1', family_id: FAMILY, title: 'Tokyo', destination: 'Tokyo', description: 'House empty all week', notes: null, start_date: '2026-11-01', created_at: '2026-01-01', updated_at: '2026-01-01' }]);
  db.seed('trips', [{ id: 't1', family_id: FAMILY, name: 'Tokyo spring', destination: 'Tokyo', notes: 'Spare key under the mat', start_date: '2027-03-10', created_at: '2026-01-01', updated_at: '2026-01-01' }]);
  db.seed('documents', [{ id: 'd1', family_id: FAMILY, title: 'Tokyo hotel booking', category: 'travel', is_secure: false, expires_at: '2026-11-08', created_at: '2026-01-01', updated_at: '2026-01-01' }]);
  db.seed('calendar_events', [{ id: 'e1', family_id: FAMILY, title: 'Tokyo ramen night', description: null, location: 'Kitchen', starts_at: '2026-10-09T18:00:00Z', created_at: '2026-01-01', updated_at: '2026-01-01' }]);
});

describe("the assistant's household search keeps to the assistant's own read rules", () => {
  it('a guest gets no trip, vacation or document — and is told they were not searched', async () => {
    const data = await assistantSearch('guest', 'Tokyo');
    expect(tables(data)).toEqual(['calendar_events']);
    expect(data.hits.map((h) => h.kind)).not.toContain('trip');
    expect(data.hits.map((h) => h.kind)).not.toContain('vacation');
    expect(data.hits.map((h) => h.kind)).not.toContain('document');
    expect(data.withheld).toEqual(expect.arrayContaining(['trip', 'vacation', 'document']));
    // Withheld, not unreadable: the honest sentence differs.
    expect(data.unavailable).toEqual([]);
    // The rows were not read at all, not read and dropped.
    expect(db.log.filter((c) => ['trips', 'vacations', 'documents'].includes(c.table))).toEqual([]);
  });

  it.each(['teen', 'child', 'caregiver'] as const)('a %s keeps the family trips but gets no document titles', async (role) => {
    const data = await assistantSearch(role, 'Tokyo');
    expect(tables(data)).toEqual(['calendar_events', 'trips', 'vacations']);
    expect(data.withheld).toContain('document');
    expect(data.withheld).not.toContain('trip');
    expect(data.withheld).not.toContain('vacation');
  });

  it.each(['parent', 'adult'] as const)('a %s still searches every source', async (role) => {
    const data = await assistantSearch(role, 'Tokyo');
    expect(tables(data)).toEqual(['calendar_events', 'documents', 'trips', 'vacations']);
    expect(data.withheld).toEqual([]);
  });

  it("the household search page keeps the service's own rules", async () => {
    // Only the assistant's answer narrows; the search page and ⌘K bar call the
    // service without options and are unchanged by this fix.
    const res = await searchHousehold(scopeFor('guest'), 'Tokyo');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...new Set(res.data.hits.map((h) => h.table))].sort()).toEqual(['calendar_events', 'documents', 'trips', 'vacations']);
  });
});
