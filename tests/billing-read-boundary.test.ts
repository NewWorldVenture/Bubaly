import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const routes = {
  checkout: readFileSync('app/api/billing/checkout/route.ts', 'utf8'),
  changePlan: readFileSync('app/api/billing/change-plan/route.ts', 'utf8'),
  cancel: readFileSync('app/api/billing/cancel/route.ts', 'utf8'),
  portal: readFileSync('app/api/billing/portal/route.ts', 'utf8'),
  webhook: readFileSync('app/api/webhooks/stripe/route.ts', 'utf8'),
};

describe('billing API read boundaries', () => {
  it('fails before Stripe mutation when billing state reads fail', () => {
    expect(routes.checkout).toContain('error: existingError');
    expectTranslates(routes.checkout, 'checkout.billingAccountStatusIsTemporarily', "Billing account status is temporarily unavailable.");
    expect(routes.changePlan).toContain('error: subError');
    expectTranslates(routes.changePlan, 'changePlan.subscriptionStatusIsTemporarilyUnavailable', "Subscription status is temporarily unavailable.");
    expect(routes.cancel).toContain('error: subError');
    expect(routes.portal).toContain('error: billingCustomerError');
  });

  it('checks billing-account and checkout-tracking writes', () => {
    expect(routes.checkout).toContain('customerWriteError');
    expect(routes.checkout).toContain('trackingError');
    expect(routes.changePlan).toContain('customerWriteError');
    expect(routes.changePlan).toContain('trackingError');
    expect(routes.cancel).toContain('syncError');
    expect(routes.changePlan).toContain('syncError');
  });

  it('does not report provider mutations as fully synced after local write failure', () => {
    expect(routes.changePlan).toContain('providerUpdated: true');
    expect(routes.cancel).toContain('providerUpdated: true');
    expectTranslates(routes.changePlan, 'changePlan.stripeChangedThePlanBut', "Stripe changed the plan, but local billing sync is pending. Please refresh before retrying.");
    expectTranslates(routes.cancel, 'cancel.stripeUpdatedTheSubscriptionBut', "Stripe updated the subscription, but local billing sync is pending. Please refresh before retrying.");
  });

  it('keeps billing portal mutation access manager-only and validates cancellation input', () => {
    expect(routes.portal).toContain('isAdmin(ctx.active.role)');
    expectTranslates(routes.portal, 'portal.onlyAParentCanOpen', "Only a parent can open the billing portal.");
    expect(routes.cancel).toContain("typeof resume !== 'boolean'");
  });

  it('carries plan metadata and lets the completion webhook repair missing checkout tracking', () => {
    expect(routes.checkout).toContain('metadata: { family_id: familyId, plan: plan ?? null }');
    expect(routes.changePlan).toContain('metadata: { family_id: familyId, plan }');
    expect(routes.webhook).toContain(".from('checkout_sessions')");
    expect(routes.webhook).toContain(".upsert({");
    expect(routes.webhook).toContain("onConflict: 'session_id'");
    expect(routes.webhook).toContain("session.metadata?.plan ?? null");
  });
});
