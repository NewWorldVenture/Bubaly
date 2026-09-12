import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Locks in the founder growth-alert wiring in the Stripe webhook: a NEW paid
// conversion and CHURN both fire super-admin notifications, and — critically —
// the `customer.subscription.deleted` event is routed through persistSubscription
// so a hard cancellation actually reaches the churn detector (prior paid+active
// → canceled). The detection logic itself is unit-tested in billing-conversion.
const route = readFileSync(
  resolve(process.cwd(), 'app/api/webhooks/stripe/route.ts'), 'utf8',
);

describe('Stripe growth-alert contract', () => {
  it('imports both pure detectors', () => {
    expect(route).toMatch(/isNewPaidConversion\s*,\s*isChurn|isChurn\s*,\s*isNewPaidConversion/);
  });

  it('records a super-admin notification for each growth transition', () => {
    expect(route).toContain("kind: 'subscription'");
    expect(route).toContain("kind: 'subscription_churn'");
    // Conversion is checked first, churn only in the else branch — never both.
    expect(route.indexOf('isNewPaidConversion(priorSub')).toBeLessThan(route.indexOf('isChurn(priorSub'));
    expect(route).toMatch(/else if \(isChurn\(priorSub/);
  });

  it('routes the deletion event through persistSubscription so hard-cancel churn fires', () => {
    expect(route).toContain("case 'customer.subscription.deleted'");
    // The three subscription events share one handler call.
    const deletedIdx = route.indexOf("case 'customer.subscription.deleted'");
    const persistIdx = route.indexOf('await persistSubscription', deletedIdx);
    expect(persistIdx).toBeGreaterThan(deletedIdx);
  });

  it('reads the prior subscription state before upserting (to diff transitions)', () => {
    expect(route).toContain('priorSub');
    expect(route.indexOf('priorSub')).toBeLessThan(route.indexOf('.upsert('));
  });
});
