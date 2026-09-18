import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { readAllAsQuery } from '@/lib/supabase/read-all';

// The admin console's aggregates are computed by reading rows into the page and
// reducing them. PostgREST answers an unbounded select with at most
// `db-max-rows` — 1,000 on a default project — and says nothing, so each of
// those aggregates silently became "the first thousand":
//
//   admin/reports   the Documents tile rendered `docs.length`, so past a
//                   thousand documents it read exactly "1,000" forever, beside
//                   family and subscription tiles that were EXACT counts;
//                   storage, growth buckets and the revenue trend were all
//                   reduced over a prefix
//   admin/backup    a page titled "Data & Storage" reported the size of the
//                   first thousand documents as the total
//
// A count is not rows: `{ count: 'exact', head: true }` is uncapped and was
// already used for the family/user/subscription tiles, which is why those were
// right and the ones beside them were wrong.
const CAP = 1000;
const OVER = CAP + 337;

type DB = SupabaseClient<Database>;

function seededDocs(n: number) {
  const db = createInMemorySupabase({ maxRows: CAP });
  db.seed('documents', Array.from({ length: n }, (_, i) => ({
    id: `doc-${String(i).padStart(6, '0')}`,
    size_bytes: 1_000,
  })));
  return db;
}

describe('an admin aggregate is computed over every row, not the first page', () => {
  it('reproduces the defect: an unbounded select stops at the cap, silently', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await db.from('documents').select('size_bytes');

    // Short, and silent about it — exactly what the page consumed.
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
    const truncatedTotal = (data ?? []).reduce((sum, d) => sum + ((d as { size_bytes: number | null }).size_bytes ?? 0), 0);
    expect(truncatedTotal).toBe(CAP * 1_000);
  });

  it('a paged read sums every document', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await readAllAsQuery<{ size_bytes: number | null }>(
      (from, to) => db.from('documents').select('size_bytes').order('id').range(from, to),
      { max: 25_000 },
    );

    expect(error).toBeNull();
    expect(data).toHaveLength(OVER);
    expect((data ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0)).toBe(OVER * 1_000);
  });

  it('a count is not rows: `head: true` was never capped', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { count, error } = await db.from('documents').select('id', { count: 'exact', head: true });
    expect(error).toBeNull();
    expect(count).toBe(OVER);
  });

  it('passing the ceiling is reported, not rounded down to it', async () => {
    // The whole point of `max`: reaching it returns the rows as a PREFIX plus an
    // error, which the admin pages join into their incomplete-report banner.
    // Without this, a bigger ceiling would just be a bigger silent truncation.
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await readAllAsQuery<{ size_bytes: number | null }>(
      (from, to) => db.from('documents').select('size_bytes').order('id').range(from, to),
      { max: 1_100 },
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/PREFIX|prefix/);
    expect(data).toBeNull();
  });
});
