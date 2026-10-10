import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
export const bill = (over: Partial<Tables<'bills'>> = {}): Tables<'bills'> => ({
  id: 'synthetic-bill',
  family_id: 'synthetic-family',
  name: 'Rent',
  amount: 100,
  due_date: '2026-01-31',
  status: 'upcoming',
  is_recurring: true,
  recurrence: 'monthly',
  category: null,
  autopay: false,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});
export function store(initial = bill(), old = false, failure: unknown = null) {
  let row = { ...initial };
  const requests: { url: URL; patch: Record<string, unknown> }[] = [];
  const reads: URL[] = [];
  const client = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        // A read (the pre-0488 column probe) answers as PostgREST does: an
        // older schema refuses a selected `due_day` with Postgres's 42703.
        if ((init?.method ?? 'GET') === 'GET') {
          reads.push(url);
          const select = url.searchParams.get('select') ?? '';
          const error =
            failure ||
            (old && select.split(',').some((c) => c.trim() === 'due_day')
              ? { code: '42703', message: 'column bills.due_day does not exist' }
              : null);
          if (error)
            return new Response(JSON.stringify(error), { status: 400, headers: { 'Content-Type': 'application/json' } });
          const projected = Object.fromEntries(select.split(',').map((c) => [c.trim(), (row as Record<string, unknown>)[c.trim()] ?? null]));
          return new Response(JSON.stringify([projected]), { headers: { 'Content-Type': 'application/json' } });
        }
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url, patch });
        const error =
          failure ||
          (old && ('due_day' in patch || url.searchParams.has('due_day'))
            ? {
                code: 'PGRST204',
                message: "Could not find the 'due_day' column of 'bills' in the schema cache",
              }
            : null);
        if (error)
          return new Response(JSON.stringify(error), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        const matches = [...url.searchParams]
          .filter(([key]) => key !== 'select')
          .every(([key, value]) =>
            value === 'is.null'
              ? (row as Record<string, unknown>)[key] === null
              : value === `eq.${String((row as Record<string, unknown>)[key])}`,
          );
        if (matches) row = { ...row, ...patch, updated_at: '2026-02-01T00:00:00Z' };
        return new Response(JSON.stringify(matches ? [{ id: row.id }] : []), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
  return { client, requests, reads, current: () => row };
}
