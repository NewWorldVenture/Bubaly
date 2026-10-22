// The dates a service visit moves — an asset's `last_serviced_on`, a
// contractor's `last_used_on` — move FORWARD only.
//
// A visit is often logged after the fact: last spring's receipt typed in
// today, a 2024 record found in a drawer. Writing its date unconditionally
// moved the asset's "last serviced" back to it, so every recommended task the
// schedule then built from that date was already overdue, and the maintenance
// page and the AI forecast showed the old date. The write now carries the rule
// itself (`.or('…is.null,…lt.<date>')`), so a later date — from a later visit,
// or typed on the asset by hand — is never overwritten.
//
// With that filter, "no rows updated" is ordinary: the asset was serviced
// later than this visit. The log that exists for a write that quietly did
// nothing (Audit C1-S9-60) is kept for the cases that are still that — the
// asset is gone, or its date is still older — by reading the row back.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

/** A `YYYY-MM-DD` date: the only shape a date column hands back, and the only one safe inside an `or()` filter. */
export function isDayKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The PostgREST filter that lets a date column move to `day` only from nothing or from an earlier day. */
export function onlyForward(column: 'last_serviced_on' | 'last_used_on', day: string): string {
  return `${column}.is.null,${column}.lt.${day}`;
}

/**
 * Whether a forward-only write that matched no row did so because the row is
 * already on `day` or later — the ordinary case — rather than because it is
 * missing or unreadable. False is "log it".
 */
export async function alreadyOnOrAfter(
  db: DB,
  table: 'home_assets' | 'home_contractors',
  column: 'last_serviced_on' | 'last_used_on',
  familyId: string,
  id: string,
  day: string,
): Promise<boolean> {
  const { data, error } = await db.from(table).select('*').eq('id', id).eq('family_id', familyId).maybeSingle();
  if (error || !data) return false;
  const current = (data as Record<string, unknown>)[column];
  return typeof current === 'string' && current >= day;
}
