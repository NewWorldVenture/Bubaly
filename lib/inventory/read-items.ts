import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { readAllAsQuery } from '@/lib/supabase/read-all';

type Item = Tables<'inventory_items'>;

function timestampParts(value: string): { second: number; fraction: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const second = Date.parse(match[1] + match[3]);
  return Number.isFinite(second) ? { second, fraction: match[2] ?? '' } : null;
}

function newestFirst(a: Item, b: Item): number {
  const left = timestampParts(a.updated_at), right = timestampParts(b.updated_at);
  if (left && right) {
    if (left.second !== right.second) return left.second < right.second ? 1 : -1;
    // Date.parse alone discards PostgreSQL's submillisecond precision.
    const digits = Math.max(left.fraction.length, right.fraction.length);
    const lf = left.fraction.padEnd(digits, '0'), rf = right.fraction.padEnd(digits, '0');
    if (lf !== rf) return lf < rf ? 1 : -1;
  } else if (a.updated_at !== b.updated_at) {
    // Retain the existing ordering for non-ISO synthetic/offline values.
    return a.updated_at < b.updated_at ? 1 : -1;
  }
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** Stable-ID traversal avoids shifting offsets; it is not a database snapshot. */
export async function readInventoryItems(supabase: SupabaseClient<Database>, familyId: string) {
  let cursor: string | null = null;
  const result = await readAllAsQuery<Item>(async (from, to) => {
    let query = supabase.from('inventory_items').select('*').eq('family_id', familyId)
      .order('id', { ascending: true }).range(0, to - from);
    if (cursor !== null) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) return { data, error };
    if (!Array.isArray(data)) return { data: null, error: { message: 'The inventory data page was unavailable' } };
    if (data.length) {
      const next = data[data.length - 1]?.id;
      if (typeof next !== 'string' || !next || (cursor !== null && next <= cursor)) {
        return { data: null, error: { message: 'The inventory cursor did not advance' } };
      }
      cursor = next;
    }
    return { data, error: null };
  });
  return { ...result, data: result.data === null ? null : [...result.data].sort(newestFirst) };
}
