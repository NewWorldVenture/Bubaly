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
