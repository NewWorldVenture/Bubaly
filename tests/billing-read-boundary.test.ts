import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const routes = {
  checkout: readFileSync('app/api/billing/checkout/route.ts', 'utf8'),
  changePlan: readFileSync('app/api/billing/change-plan/route.ts', 'utf8'),
  cancel: readFileSync('app/api/billing/cancel/route.ts', 'utf8'),
  portal: readFileSync('app/api/billing/portal/route.ts', 'utf8'),
  webhook: readFileSync('app/api/webhooks/stripe/route.ts', 'utf8'),
  // Both routes start a subscription Checkout through this one helper.
  subscriptionCheckout: readFileSync('lib/billing/subscription-checkout.ts', 'utf8'),
};

/**
 * Null when `source` binds the result of `writeCall` and reads that binding in a
 * conditional that returns a 503 before `providerMutation` runs; otherwise the
 * reason it does not. The binding's name is read out of the source rather than
 * pinned, so a rename cannot fail this while deleting the guard still does.
 */
function writeIsChecked(source: string, writeCall: string, providerMutation: string): string | null {
  const lines = source.split('\n');
  const writeAt = lines.findIndex((l) => l.includes(writeCall));
  if (writeAt < 0) return `no call to ${writeCall}`;
  const bound = /(?:const|let)\s*\{?\s*(?:error:\s*)?([A-Za-z0-9_]+)\s*\}?\s*(?::[^=]*)?=\s*await/.exec(lines[writeAt]);
  if (!bound) return `the result of ${writeCall} is not bound to anything`;
  const name = bound[1];
  const mutationAt = lines.findIndex((l) => l.includes(providerMutation));
  if (mutationAt < 0) return `no ${providerMutation} to guard`;
  if (mutationAt < writeAt) return `${providerMutation} happens before the write`;
  const between = lines.slice(writeAt + 1, mutationAt).join('\n');
  if (!new RegExp(`if\\s*\\([^)]*\\b${name}\\b`).test(between)) return `${name} is never tested before ${providerMutation}`;
  if (!/return NextResponse\.json\([\s\S]*?503/.test(between)) return `nothing returns 503 between the write and ${providerMutation}`;
  return null;
}

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
    // The billing-customer write is checked by BEHAVIOUR, not by the name of the
    // variable that holds its result. This assertion used to read
    // `toContain('customerWriteError')`, which failed the moment the two routes
    // were refactored onto one writer and the binding was renamed — while the
    // guard it cared about was still there, and stricter. A name is not the
    // property; returning before Stripe is mutated is.
    // Both routes create the session through createSubscriptionCheckout.
    expect(writeIsChecked(routes.checkout, 'rememberStripeCustomer(', 'createSubscriptionCheckout(')).toBeNull();
    expect(writeIsChecked(routes.changePlan, 'rememberStripeCustomer(', 'createSubscriptionCheckout(')).toBeNull();
    expect(routes.subscriptionCheckout).toContain('stripe.checkout.sessions.create(');
    // These two are still matched by name. They guard deliberately best-effort
    // writes that do not return, so `writeIsChecked` does not describe them;
    // they are named here rather than silently dropped.
    expect(routes.checkout).toContain('trackingError');
    expect(routes.changePlan).toContain('trackingError');
    expect(routes.cancel).toContain('syncError');
    expect(routes.changePlan).toContain('syncError');
  });

  it('can tell a checked write from an unchecked one', () => {
    // Without this, the assertion above is an absence, and an analyser that
    // never finds anything satisfies it.
    const guarded = [
      "    const written = await rememberStripeCustomer(service, familyId, customerId);",
      '    if (!written.ok) {',
      "      return NextResponse.json({ error: t('x') }, { status: 503 });",
      '    }',
      '    const session = await stripe.checkout.sessions.create({});',
    ].join('\n');
    expect(writeIsChecked(guarded, 'rememberStripeCustomer(', 'checkout.sessions.create')).toBeNull();

    const unguarded = [
      "    const written = await rememberStripeCustomer(service, familyId, customerId);",
      '    const session = await stripe.checkout.sessions.create({});',
    ].join('\n');
    expect(writeIsChecked(unguarded, 'rememberStripeCustomer(', 'checkout.sessions.create')).toMatch(/never tested/);

    const unbound = [
      '    await rememberStripeCustomer(service, familyId, customerId);',
      '    const session = await stripe.checkout.sessions.create({});',
    ].join('\n');
    expect(writeIsChecked(unbound, 'rememberStripeCustomer(', 'checkout.sessions.create')).toMatch(/not bound/);

    const noRefusal = [
      "    const written = await rememberStripeCustomer(service, familyId, customerId);",
      '    if (!written.ok) console.error(written.error);',
      '    const session = await stripe.checkout.sessions.create({});',
    ].join('\n');
    expect(writeIsChecked(noRefusal, 'rememberStripeCustomer(', 'checkout.sessions.create')).toMatch(/nothing returns 503/);
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
    // One session builder for both routes, so the metadata cannot drift apart.
    expect(routes.subscriptionCheckout).toContain('metadata: { family_id: input.familyId, plan: input.plan }');
    expect(routes.checkout).toContain('createSubscriptionCheckout(');
    expect(routes.changePlan).toContain('createSubscriptionCheckout(');
    expect(routes.webhook).toContain(".from('checkout_sessions')");
    expect(routes.webhook).toContain(".upsert({");
    expect(routes.webhook).toContain("onConflict: 'session_id'");
    expect(routes.webhook).toContain("session.metadata?.plan ?? null");
  });
});
