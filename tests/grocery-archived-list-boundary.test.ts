import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { ensureDefaultList } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';

// Archiving a shopping list is a family saying they are done with it. Writing
// into one anyway is the worst shape a bug can take here, because it SUCCEEDS:
// the caller is told the milk was added, and the milk is on a list nobody will
// open again.
//
// `grocery_lists` carries two columns that answer "is this archived" —
// `is_archived` from 0002 and `archived_at` from 0014 — and nothing in the
// application ever writes the first. The shopping module stamps the second. So
// an `is_archived`-only reader calls an archived list open, which is the exact
// trap lib/services/groceries documents at length and which two more readers
// had fallen into.

const FAMILY = 'fam-1';

function scopeFor(db: SupabaseClient<Database>): ServiceScope {
  return {
    db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent',
  } as unknown as ServiceScope;
}

function withLists(rows: Record<string, unknown>[]) {
  const db = createInMemorySupabase();
  db.seed('grocery_lists', rows);
  db.seed('grocery_items', []);
  return db;
}

const live = (id: string, over: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, name: id, is_archived: false, archived_at: null,
  created_at: '2026-01-01T00:00:00Z', ...over,
});

// The NAMED-list path is deliberately not filtered here: naming a list is the
// caller saying which one it means, and tests/grocery-write-path.test.ts pins
// that choice. This file is about the path where nothing named one.

describe('the default list is the one the family can still see', () => {
  it('skips an archived list and opens a new one rather than reusing it', async () => {
    const db = withLists([live('put-away', { archived_at: '2026-02-01T00:00:00Z' })]);
    const result = await ensureDefaultList(scopeFor(db as unknown as SupabaseClient<Database>));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).not.toBe('put-away');
      expect(result.data.created).toBe(true);
    }
  });

  it('takes the live one when there is both', async () => {
    const db = withLists([
      live('put-away', { archived_at: '2026-02-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' }),
      live('current', { created_at: '2026-03-01T00:00:00Z' }),
    ]);
    const result = await ensureDefaultList(scopeFor(db as unknown as SupabaseClient<Database>));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe('current');
  });
});
