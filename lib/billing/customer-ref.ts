// lib/billing/customer-ref.ts — the ONE way a Stripe customer id gets written
// to `billing_customers`.
//
// Why this exists: three places wrote this same row with the same three
// columns, and only one of them named the conflict target. `billing_customers`
// keys on `id uuid primary key default gen_random_uuid()` with a SEPARATE
// `unique (family_id)`, so a PostgREST upsert that does not pass `onConflict`
// gets `on conflict (id)` — a target that can never fire, because the payload
// never supplies an id. The insert is then attempted in full and collides with
// `billing_customers_family_id_key` instead:
//
//   23505 duplicate key value violates unique constraint
//         "billing_customers_family_id_key"
//
// Measured against the local PostgREST, not inferred: the first write of a
// family succeeds, and every write after it fails. `onConflict: 'family_id'`
// names the constraint that actually exists, and the same write then updates.
//
// The callers reach this only after `stripe.customers.create` has already
// returned, so a failure here is not a dead letter — it is a real Stripe
// customer the database never recorded. Making the write repeatable is what
// keeps a retry from minting another one.
import type { createServiceClient } from '@/lib/supabase/server';

type ServiceClient = ReturnType<typeof createServiceClient>;

export type CustomerRefWrite =
  | { ok: true; customerRef: string }
  | { ok: false; error: unknown };

/**
 * Record `customerRef` as the family's Stripe customer.
 *
 * The `.select()` is the evidence the write landed, not a read of the
 * committed row: PostgREST returns this statement's own RETURNING row. Under a
 * genuine race that distinction is observable, and it was measured rather than
 * assumed — two concurrent callers for one family both succeed and leave one
 * row, but each answers with the id it wrote, and the row holds whichever
 * committed last. So the returned id is "what this call wrote", and callers
 * must not read it as "what the family's row says".
 *
 * Two known limitations, deliberately not papered over:
 *
 *  - Each racing request has already created its own Stripe customer, so the
 *    one that loses the write is left unreferenced. Avoiding that needs the id
 *    reserved before Stripe is called, which is a larger change than a write.
 *  - Between that race and checkout completing, `/api/billing/portal` can open
 *    against the customer the row names rather than the one the person is
 *    paying through. It closes itself: `checkout.session.completed` comes back
 *    through this same function with the session's own customer, so the
 *    customer that actually completed becomes the stored one.
 */
export async function rememberStripeCustomer(
  service: ServiceClient,
  familyId: string,
  customerRef: string,
): Promise<CustomerRefWrite> {
  const { data, error } = await service
    .from('billing_customers')
    .upsert({ family_id: familyId, provider: 'stripe', customer_ref: customerRef }, { onConflict: 'family_id' })
    .select('customer_ref')
    .maybeSingle();
  if (error) return { ok: false, error };
  // A row that came back without a ref would mean the write did not take; the
  // value we sent is not evidence that it landed.
  const stored = data?.customer_ref;
  if (!stored) return { ok: false, error: new Error('billing_customers accepted the write but reported no customer_ref') };
  return { ok: true, customerRef: stored };
}
