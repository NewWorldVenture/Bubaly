// Household search fans out eleven reads at once, so "a read failed" is the
// ordinary case, not the exotic one — and it is exactly the case where a search
// box lies most convincingly: it renders a calm "no results" for a household
// whose warranties simply could not be read.
//
// The contract pinned here: a source that errors is NAMED in `partial` and
// logged, the other sources still answer, and when every source fails the call
// fails closed with a retryable error instead of an empty success. Modelled on
// `tests/reasoning-context-read-boundary.test.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { searchHousehold } from '@/lib/services/search';
import type { ServiceScope } from '@/lib/services/types';

type Reply = { data: unknown; error: unknown };

/**
 * A chainable stub whose terminal `await` resolves to the scripted reply for
 * that table. Mirrors the exact call shape the service makes:
 * `from(t).select(cols).eq(...).or(...).order(...).limit(n)`.
 */
function fakeSupabase(script: Record<string, Reply | (() => never)>): SupabaseClient<Database> {
  return {
    from: (table: string) => {
      const entry = script[table];
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'or', 'order', 'not', 'ilike']) {
        chain[method] = () => chain;
      }
      chain.limit = () => {
        // A thrown transport failure must be caught by the service too, not
        // only a PostgREST `{ error }`.
        if (typeof entry === 'function') entry();
        return Promise.resolve(entry ?? { data: [], error: null });
      };
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
}

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return {
    db,
    familyId: 'family-1',
    userId: 'user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'UTC',
    now: new Date('2026-07-04T12:00:00Z'),
  };
}

const ALL_SOURCES = [
  'documents', 'inventory_items', 'trips', 'vacations', 'family_decisions',
  'calendar_events', 'notes', 'family_facts', 'bills', 'home_warranties', 'renewals',
];

afterEach(() => vi.restoreAllMocks());

describe('searchHousehold read boundary', () => {
  it('names the source that failed, logs it, and still returns what the others found', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeSupabase({
      notes: { data: null, error: { message: 'permission denied for table notes' } },
      home_warranties: {
        data: [{ id: 'war-1', name: 'Furnace warranty', provider: 'Carrier', coverage: null, warranty_type: 'appliance', notes: null, expires_on: '2027-03-01', updated_at: '2026-06-18T00:00:00Z' }],
        error: null,
      },
    });

    const result = await searchHousehold(scopeWith(db), 'furnace warranty');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The failure is reported, not swallowed into "no notes matched".
    expect(result.data.partial.map((p) => p.table)).toEqual(['notes']);
    expect(result.data.partial[0].error).toBeTruthy();
    expect(result.data.searched).not.toContain('notes');
    expect(result.data.searched).toHaveLength(ALL_SOURCES.length - 1);
    // The nine healthy sources still answer.
    expect(result.data.hits.map((h) => h.id)).toContain('war-1');

    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[service:search] notes read failed');
  });

  it('reports a thrown transport failure the same way as a PostgREST error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeSupabase({
      bills: () => { throw new Error('fetch failed'); },
    });

    const result = await searchHousehold(scopeWith(db), 'electric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.partial.map((p) => p.table)).toEqual(['bills']);
  });

  it('fails closed when EVERY source errors — an outage is not an empty household', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeSupabase(Object.fromEntries(
      ALL_SOURCES.map((table) => [table, { data: null, error: { message: `relation ${table} does not exist` } }]),
    ));

    const result = await searchHousehold(scopeWith(db), 'furnace warranty');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Retryable, so the page can offer "try that search again" rather than
    // presenting the household as empty.
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('db');
    expect(err).toHaveBeenCalledTimes(ALL_SOURCES.length);
  });

  it('logs nothing and reports nothing partial when every source answers', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await searchHousehold(scopeWith(fakeSupabase({})), 'furnace warranty');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.partial).toEqual([]);
    expect(result.data.searched).toHaveLength(ALL_SOURCES.length);
    expect(err).not.toHaveBeenCalled();
  });
});
