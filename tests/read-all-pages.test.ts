import { describe, expect, it } from 'vitest';
import { readAllPages } from '@/lib/supabase/read-all-pages';

describe('complete household reads', () => {
  it('continues when a server returns fewer rows than the requested range', async () => {
    const rows = [1, 2, 3, 4, 5];
    const offsets: number[] = [];
    const result = await readAllPages(async (from) => {
      offsets.push(from);
      return { data: rows.slice(from, from + 2), error: null };
    });
    expect(result).toEqual({ data: rows, error: null });
    expect(offsets).toEqual([0, 2, 4, 5]);
  });

  it('discards partial evidence when a later page fails or has no data result', async () => {
    const failed = await readAllPages(async (from) => from === 0
      ? { data: ['first'], error: null } : { data: null, error: new Error('offline') });
    expect(failed.data).toBeNull();
    expect(failed.error).toBeInstanceOf(Error);
    const missing = await readAllPages(async () => ({ data: null, error: null }));
    expect(missing.error).toBeInstanceOf(Error);
  });
});
