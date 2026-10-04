import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';
import { handleAuthorizationUpdated } from '@/lib/stripe/webhook';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { readAll } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Card-hold reconcile. A `processing` card hold is released when an event
// reaches the money webhook, and some never do: our approve call failed and
// Stripe could not be asked how it decided; the function died between the
// reserve and the approve call; a replayed request re-held an authorization
// that had closed; or the endpoint was never subscribed to `.updated` and
// `.created` (the operator setup step omitted them until #962). Each of those
// keeps a child's money held for good.
//
// Once a day this asks Stripe about every authorization that still holds money
// an hour after its hold was placed (its own events have had their chance by
// then), oldest first, and runs it through the webhook's own handler, which is
// idempotent: a live authorization changes nothing, one that is over is closed,
// and a request Stripe declined is released.
//
// IT NEVER POSTS A CAPTURE. An authorization that lists a capture the ledger
// does not have yet is left alone (`awaitingCapture`): its own
// issuing_transaction.created posts it. Without 0485/0487 on the database the
// capture debit is a read-then-insert, and this route runs from two schedulers
// at the same minute (vercel.json and the GitHub dispatcher), so posting one
// here could debit it twice. Everything this route does write is a release of
// a `processing` hold, which a second run repeats as a no-op.
//
// Read-only at Stripe; every question is bounded (STRIPE_OPTIONS) and the run
// stops starting new ones at BUDGET_MS. What it did not reach is `unserved`,
// and what it cannot settle without a person (an authorization Stripe does not
// know, a family with no connected account) answers non-200, because such a
// hold stays held until someone looks.
const STALE_AFTER_MS = 60 * 60 * 1000;
const BUDGET_MS = 45_000;
const CONCURRENCY = 5;
const STRIPE_OPTIONS = { timeout: 8_000, maxNetworkRetries: 1 } as const;

/** The authorization a hold belongs to: its key is the id, or the id then `#`. */
function authorizationOf(stripeRef: string): string | null {
  const id = stripeRef.split('#')[0];
  return id.startsWith('iauth_') ? id : null;
}

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('cardHolds.unauthorized') }, { status: 401 });
  }
  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    // No Stripe key on this deployment: there are no card holds to reconcile.
    return NextResponse.json({ ok: true, skipped: 'stripe_not_configured' });
  }
  const startedAt = Date.now();
  try {
    const supabase = createServiceClient();
    const cutoff = new Date(startedAt - STALE_AFTER_MS).toISOString();
    // Every stale hold: a capped read would serve the same prefix every day.
    // Past the max, readAll answers an error and the run fails visibly.
    const { rows: holds, error } = await readAll((from, to) => supabase
      .from('wallet_transactions')
      .select('id, family_id, stripe_ref, created_at')
      .eq('type', 'card_spend')
      .eq('status', 'processing')
      .lt('created_at', cutoff)
      .not('stripe_ref', 'is', null)
      .order('created_at')
      .order('id')
      .range(from, to), { max: 20_000 });
    if (error && isMissingRelationError(error)) {
      return NextResponse.json({ ok: true, skipped: 'wallet_not_deployed' });
    }
    if (error) throw error;

    // One question per authorization, oldest hold first, whatever holds it has
    // (the first request's, an increase, a remainder).
    const familyOf = new Map<string, string>();
    for (const row of holds) {
      const id = authorizationOf(String(row.stripe_ref));
      if (id && !familyOf.has(id)) familyOf.set(id, String(row.family_id));
    }
    const queue = [...familyOf.keys()];

    const families = [...new Set(familyOf.values())];
    const { data: accounts, error: accountError } = await readInChunks(families, (chunk) => supabase
      .from('stripe_connected_accounts')
      .select('family_id, stripe_account_id')
      .in('family_id', chunk));
    if (accountError) throw accountError;
    const accountOf = new Map(accounts.map((a) => [String(a.family_id), String(a.stripe_account_id)]));

    const tally = { reconciled: 0, awaitingCapture: 0, unknown: 0, noAccount: 0, failed: 0 };
    async function reconcile(id: string): Promise<void> {
      // Cards are only issued on a family's connected account; a hold with
      // none cannot be asked about, and asking the platform would only say
      // "not found".
      const account = accountOf.get(familyOf.get(id) as string);
      if (!account) {
        tally.noAccount++;
        console.error('[money] card-hold reconcile: no connected account for this hold\'s family; it stays held', { authorizationId: id });
        return;
      }
      let current: Stripe.Issuing.Authorization;
      try {
        current = await stripe.issuing.authorizations.retrieve(id, {}, { stripeAccount: account, ...STRIPE_OPTIONS });
      } catch (e) {
        if ((e as { code?: string })?.code === 'resource_missing') {
          tally.unknown++;
          console.error('[money] card-hold reconcile: Stripe does not know this authorization; its hold stays', { authorizationId: id }, e);
          return;
        }
        tally.failed++;
        console.error('[money] card-hold reconcile: could not ask Stripe; the hold stays', { authorizationId: id }, e);
        return;
      }
      try {
        const captures = (current.transactions ?? [])
          .filter((txn) => txn.type === 'capture' && Math.trunc(txn.amount ?? 0) < 0)
          .map((txn) => txn.id);
        if (captures.length > 0) {
          // A presence check over one authorization's captures: a handful of
          // rows, bounded explicitly because this is a money ledger.
          const { data: posted, error: postedError } = await supabase
            .from('wallet_transactions')
            .select('stripe_ref')
            .in('stripe_ref', captures)
            .eq('type', 'card_spend')
            .eq('status', 'completed')
            .limit(1000);
          if (postedError) throw postedError;
          const have = new Set((posted ?? []).map((row) => row.stripe_ref));
          if (captures.some((ref) => !have.has(ref))) {
            tally.awaitingCapture++;
            return;
          }
        }
        await handleAuthorizationUpdated(supabase, current);
        tally.reconciled++;
      } catch (e) {
        tally.failed++;
        console.error('[money] card-hold reconcile: could not settle the authorization', { authorizationId: id }, e);
      }
    }

    // A pool of CONCURRENCY workers taking the next authorization, oldest
    // first, until the queue is done or the budget is spent.
    let next = 0;
    let unserved = 0;
    async function worker(): Promise<void> {
      while (next < queue.length) {
        if (Date.now() - startedAt > BUDGET_MS) {
          unserved = queue.length - next;
          return;
        }
        await reconcile(queue[next++]);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const ok = tally.failed === 0 && tally.unknown === 0 && tally.noAccount === 0 && unserved === 0;
    return NextResponse.json(
      { ok, holds: holds.length, authorizations: queue.length, ...tally, unserved },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Card-hold reconcile cron error:', err);
    return NextResponse.json({ error: t('cardHolds.reconcileFailed') }, { status: 500 });
  }
}
