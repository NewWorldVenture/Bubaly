import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routes = {
  checkout: readFileSync('app/api/billing/checkout/route.ts', 'utf8'),
  changePlan: readFileSync('app/api/billing/change-plan/route.ts', 'utf8'),
  cancel: readFileSync('app/api/billing/cancel/route.ts', 'utf8'),
  portal: readFileSync('app/api/billing/portal/route.ts', 'utf8'),
};

describe('billing API read boundaries', () => {
  it('fails before Stripe mutation when billing state reads fail', () => {
    expect(routes.checkout).toContain('error: existingError');
    expect(routes.checkout).toContain('Billing account status is temporarily unavailable.');
    expect(routes.changePlan).toContain('error: subError');
    expect(routes.changePlan).toContain('Subscription status is temporarily unavailable.');
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
});
