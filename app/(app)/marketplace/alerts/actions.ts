'use server';

// Server actions for Marketplace saved searches / alerts. Family-scoped via RLS;
// a write against another family's row is a silent no-op.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { KIND_ORDER, CATEGORY_LABELS, type ListingKind, type ListingCategory } from '@/lib/marketplace/listings';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

const ALERTS = '/marketplace/alerts';
const KINDS = new Set<string>(KIND_ORDER);
const CATS = new Set<string>(Object.keys(CATEGORY_LABELS));

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[marketplace-alerts] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

export type CreateAlertInput = {
  label?: string;
  query?: string;
  kind?: string;
  category?: string;
  maxPrice?: string; // dollars, from the form
};

/** Create a saved search for the current member. Requires at least one criterion. */
export async function createSavedSearchAction(input: CreateAlertInput): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const query = (input.query ?? '').trim() || null;
  const kind = input.kind && KINDS.has(input.kind) ? (input.kind as ListingKind) : null;
  const category = input.category && CATS.has(input.category) ? (input.category as ListingCategory) : null;
  const dollars = Number(input.maxPrice);
  const maxPriceCents = input.maxPrice && Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;

  if (!query && !kind && !category && maxPriceCents === null) {
    return { ok: false, error: 'Add a keyword or a filter so we know what to watch for.' };
  }

  const { error } = await supabase.from('marketplace_saved_searches').insert({
    family_id: ctx.active.familyId,
    member_id: ctx.active.member.id,
    label: (input.label ?? '').trim() || null,
    query, kind, category, max_price_cents: maxPriceCents,
    created_by: ctx.user.id,
  });
  if (error) return actionFailure('create the saved search', error);
  revalidatePath(ALERTS);
  return { ok: true };
}

/** Delete a saved search. */
export async function deleteSavedSearchAction(id: string): Promise<Result> {
  if (!id) return { ok: false, error: 'Invalid alert' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('marketplace_saved_searches')
    .delete()
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('delete the saved search', error);
  revalidatePath(ALERTS);
  return { ok: true };
}

/** Clear the "new" badge by advancing the last-seen cursor to now. */
export async function markSearchSeenAction(id: string): Promise<Result> {
  if (!id) return { ok: false, error: 'Invalid alert' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('marketplace_saved_searches')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('mark the saved search as seen', error);
  revalidatePath(ALERTS);
  return { ok: true };
}
