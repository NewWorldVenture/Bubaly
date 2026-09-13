import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const stripeRoute = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8');
const stripeHelper = readFileSync('lib/stripe/webhook.ts', 'utf8');
const resendRoute = readFileSync('app/api/webhooks/resend/route.ts', 'utf8');
const referrals = readFileSync('lib/referrals/server.ts', 'utf8');

describe('webhook persistence boundaries', () => {
  it('fails Stripe delivery when subscription, checkout, or event finalization fails', () => {
    expect(stripeRoute).toContain('Subscription persistence failed');
    expect(stripeRoute).toContain('priorSubscriptionError');
    expect(stripeRoute).toContain('Billing state lookup failed');
    expect(stripeRoute).toContain('Checkout persistence failed');
    expectTranslates(stripeRoute, 'stripe.webhookStorageUnavailable', "Webhook storage unavailable");
    expect(stripeHelper).toContain(".select('stripe_event_id').maybeSingle()");
    expect(stripeHelper).toContain('Stripe webhook event finalization failed');
    expect(stripeHelper).toContain('Stripe webhook error state was not recorded');
  });

  // `onConflict: 'family_id'` was never satisfiable — there is no unique index
  // on subscriptions.family_id, and Postgres infers an ON CONFLICT target from
  // one — so every delivery raised 42P10 at planning time and became the
  // generic message above with nothing logged to say why. Two properties keep
  // that from recurring: the reason reaches the logs, and the write does not
  // depend on an index that may be absent (0285 only creates it when no family
  // already holds two rows, and refuses to delete billing rows to force it).
  it('persists a subscription without depending on a conflict target, and says why when it cannot', () => {
    expect(stripeRoute).toContain("from('subscriptions').update(fields).eq('family_id', familyId).select('id')");
    expect(stripeRoute).toContain('[stripe webhook] Subscription update failed');
    expect(stripeRoute).toContain('[stripe webhook] Subscription insert failed');

    // The insert is the fallback, not the first move: reversing them would
    // write a second row for every family that already has one.
    const update = stripeRoute.indexOf("from('subscriptions').update(");
    const insert = stripeRoute.indexOf("from('subscriptions').insert(");
    expect(update).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(update);

    expect(stripeRoute).not.toMatch(/from\('subscriptions'\)\s*\.upsert/);
  });

  it('fails Resend delivery when counters, suppressions, or event finalization fail', () => {
    expect(resendRoute).toContain('counterError');
    expect(resendRoute).toContain('suppressionError');
    expect(resendRoute).toContain(".select('svix_id').maybeSingle()");
    expect(resendRoute).toContain('processedError');
  });

  it('fails referral conversion instead of reporting a paid state on a lost write', () => {
    expect(referrals).toContain('Referral lookup failed');
    expect(referrals).toContain('Referral conversion persistence failed');
    expect(referrals).toContain(".eq('status', 'signed_up').select('id').maybeSingle()");
  });
});
