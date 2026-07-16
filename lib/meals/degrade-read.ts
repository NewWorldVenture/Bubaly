// lib/meals/degrade-read.ts — the "degrade but never fail silently" read helper
// for aggregate hub pages (Food & Nutrition, and siblings).
//
// An overview hub fans out many independent reads and shows a card per source.
// One failing/not-yet-migrated table (e.g. dining_out on an un-migrated env)
// must degrade that ONE card to empty — not crash the whole hub. But it must
// NOT fail SILENTLY: a Supabase read resolves with `{ data, error }` (it does
// not reject), so a bare `data ?? null` swallows RLS denials, missing tables,
// and transient outages, rendering a healthy-looking-but-empty page that is
// impossible to diagnose in prod. This helper logs BOTH the resolved `error`
// field and thrown exceptions under a namespaced label, then degrades.

export type Postgrestish<T> = PromiseLike<{
  data: T[] | null;
  error?: { message: string } | null;
  count?: number | null;
}>;

export type DegradeResult<T> = { data: T[] | null; count: number | null };

/** Build a namespaced degrade-read fn: `const safe = makeDegradeRead('food')`.
 *  `safe('meal_plans', supabase.from('meal_plans').select(...))` awaits the
 *  query, logs on failure (error field OR throw), and returns null data so the
 *  card degrades to empty instead of the page crashing. */
export function makeDegradeRead(namespace: string) {
  return async function degradeRead<T>(label: string, q: Postgrestish<T>): Promise<DegradeResult<T>> {
    try {
      const r = await q;
      if (r.error) {
        console.error(`[${namespace}] ${label} read failed`, { message: r.error.message });
        return { data: null, count: null };
      }
      return { data: r.data ?? null, count: r.count ?? null };
    } catch (err) {
      console.error(`[${namespace}] ${label} read threw`, err);
      return { data: null, count: null };
    }
  };
}
