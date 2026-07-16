import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planLevel } from '@/lib/constants/plans';

// A-09 revenue invariant. The Stripe subscription webhook maps a Stripe price id
// to a plan slug and persists it to `subscriptions.plan`; entitlement gating then
// reads that slug through planLevel(). If the webhook ever writes a slug that
// planLevel() does not recognise, a PAYING customer silently resolves to Free
// (level 0) — a launch-blocking billing defect. This test ties the two files
// together so any drift fails CI.
describe('A-09 webhook plan slugs stay entitled by planLevel()', () => {
  const webhookSrc = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8');

  // Extract the plan-slug string literals the price→plan ladder assigns, i.e.
  //   priceId === process.env.STRIPE_PRICE_* ? 'slug' :
  const slugs = Array.from(webhookSrc.matchAll(/\?\s*'([a-z_]+)'\s*:/g)).map((m) => m[1]);

  it('finds the price→plan mapping in the webhook', () => {
    expect(slugs.length).toBeGreaterThanOrEqual(4);
    // sanity: the four current paid slugs must be present
    for (const s of ['plus', 'plus_annual', 'basic', 'basic_annual']) {
      expect(slugs).toContain(s);
    }
  });

  it('every plan slug the webhook writes resolves to a PAID level (>= 1)', () => {
    for (const slug of slugs) {
      expect(planLevel(slug), `webhook slug "${slug}" must be a paid tier`).toBeGreaterThanOrEqual(1);
    }
  });

  it('plus tiers are level 2 and basic tiers are level 1', () => {
    expect(planLevel('plus')).toBe(2);
    expect(planLevel('plus_annual')).toBe(2);
    expect(planLevel('basic')).toBe(1);
    expect(planLevel('basic_annual')).toBe(1);
  });

  it('unknown / free slugs are Free (level 0) — no accidental entitlement', () => {
    expect(planLevel('free')).toBe(0);
    expect(planLevel('mystery_tier')).toBe(0);
    expect(planLevel(null)).toBe(0);
    expect(planLevel(undefined)).toBe(0);
  });

  it('the webhook rejects an unknown price rather than writing a Free slug', () => {
    // Guards the "throw on unknown price" branch so a mis-configured price id can
    // never silently downgrade a paying family.
    expect(webhookSrc).toContain('Unknown Stripe subscription price');
  });
});
