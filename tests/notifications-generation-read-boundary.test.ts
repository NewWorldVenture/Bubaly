import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';

// generateFamilyNotifications fans out ~13 parallel source reads. A swallowed read
// error would silently skip that whole notification category forever; it now logs
// each failed source read while still degrading (partial delivery > all-or-nothing).
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, neq: () => c, gte: () => c, lte: () => c, in: () => c,
    is: () => c, not: () => c, or: () => c, ilike: () => c, order: () => c, limit: () => c,
    maybeSingle: () => Promise.resolve(result),
    then: (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF),
  };
  return c;
}

// Every table read resolves empty/OK except the ones named in `errorTables`,
// which resolve with a PostgREST error. Inserts resolve OK.
function fakeSupabase(errorTables: Set<string>): SupabaseClient<Database> {
  return {
    from: (table: string) => ({
      ...chain(errorTables.has(table) ? { data: null, error: { message: `read failed: ${table}` } } : { data: [], error: null }),
      insert: () => Promise.resolve({ data: null, error: null }),
    }),
  } as unknown as SupabaseClient<Database>;
}

describe('generateFamilyNotifications source read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failed source read (by table name) and still returns without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set(['reminders', 'medications']));

    const created = await generateFamilyNotifications(supabase, 'fam-1');

    expect(created).toBe(0); // no candidates from empty sources — but it did not throw
    const logged = err.mock.calls.map((c) => `${c[0]} ${JSON.stringify(c[1])}`);
    expect(logged.some((l) => l.includes('generation source read failed') && l.includes('reminders'))).toBe(true);
    expect(logged.some((l) => l.includes('generation source read failed') && l.includes('medications'))).toBe(true);
  });

  it('does not log when all source reads succeed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase(new Set());

    await generateFamilyNotifications(supabase, 'fam-1');

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('generation source read failed'))).toBe(false);
  });
});
