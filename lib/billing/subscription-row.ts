// lib/billing/subscription-row.ts — read "the family's subscription row" when a
// family may hold more than one.
//
// Migration 0285 declares uq_subscriptions_family only where no family already
// holds two rows (the handle_new_family trial seed plus admin Set Plan or a
// Stripe write), so a family can still have several. `.maybeSingle()` answers
// those families with an error (PGRST116), and every billing path that read
// with it alone — the Stripe webhook, cancel, change-plan, checkout — turned
// that into a permanent failure: the webhook 500'd on every retry and never
// recorded a cancellation, and the routes answered 503. The single-row read
// stays the common path; only a "more than one row" answer reads them all and
// picks one.
import { canChangeSubscriptionInPlace } from '@/lib/billing/plans';

type SubscriptionLike = { status: string; provider_ref: string | null };
type Read<T> = { data: T | null; error: unknown };

/** The builder shape the reader needs: a select already filtered to one family. */
export type FamilySubscriptionQuery<T> = {
  maybeSingle(): PromiseLike<Read<T>>;
  order(column: 'updated_at', options: { ascending: boolean }): { limit(count: number): PromiseLike<Read<T[]>> };
};

/** PostgREST's answer to `.maybeSingle()` over more than one row. */
export function isMultipleRowsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'PGRST116';
}

/**
 * The row to act on: the one recording `preferRef` when given, else a live one,
 * else the newest. `rows` is newest first.
 */
export function pickFamilySubscription<T extends SubscriptionLike>(rows: readonly T[], preferRef?: string | null): T | null {
  if (preferRef) {
    const match = rows.find((row) => row.provider_ref === preferRef);
    if (match) return match;
  }
  return rows.find((row) => canChangeSubscriptionInPlace(row)) ?? rows[0] ?? null;
}

/**
 * One family's subscription row. `query` builds a fresh
 * `.from('subscriptions').select(...).eq('family_id', …)` each time it is
 * called. Read errors other than "more than one row" are returned unchanged.
 */
export async function readFamilySubscription<T extends SubscriptionLike>(
  query: () => FamilySubscriptionQuery<T>,
  preferRef?: string | null,
): Promise<Read<T>> {
  const single = await query().maybeSingle();
  if (!isMultipleRowsError(single.error)) return single;
  const many = await query().order('updated_at', { ascending: false }).limit(20);
  if (many.error) return { data: null, error: many.error };
  return { data: pickFamilySubscription(many.data ?? [], preferRef), error: null };
}
