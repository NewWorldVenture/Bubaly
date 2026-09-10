import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets [M-038]):
// the pricing page's billing-period toggle (Monthly / Yearly) — a key conversion
// control — used px-5 py-2 (~36px tall), below the 44px minimum tap target on
// touch. Both segments now carry coarse:min-h-11 (>=44px on touch) while staying
// compact on desktop-with-a-mouse. The plan-card CTAs and demo button were already
// h-12 (48px), so they were left as-is. This guard forbids a regression.

const pricing = fs.readFileSync('app/(marketing)/pricing/pricing-content.tsx', 'utf8');

const valueBlock = fs.readFileSync('components/marketing/pricing-value-block.tsx', 'utf8');

describe('pricing billing-period toggle meets the 44px touch target (M-038)', () => {
  it('both Monthly/Yearly segments grow to >=44px on touch', () => {
    for (const period of ['monthly', 'yearly']) {
      const idx = pricing.indexOf(`setPeriod('${period}')`);
      expect(idx).toBeGreaterThan(-1);
      const block = pricing.slice(idx, idx + 260);
      expect(block).toContain('coarse:min-h-11');
    }
  });

  // The value block sits below the plan cards. Its per-tier matrix
  // is the one piece that would be tempting to draw as a wide table — which on
  // a phone means either a sideways scroller or a page that scrolls
  // horizontally (tests/e2e/overflow.spec.ts, tests/e2e/mobile.spec.ts). It
  // stacks instead: one card per tier below `md`, columns only from `md` up.
  it('the value matrix stacks on phones rather than scrolling sideways', () => {
    expect(valueBlock).toContain('md:grid-cols-3');
    expect(valueBlock).not.toContain('<table');
    expect(valueBlock).not.toContain('overflow-x-auto');
    expect(valueBlock).not.toMatch(/min-w-\[\d/);
  });

  it('the per-day line is text under the price, not another tap target', () => {
    const perDay = pricing.indexOf('{perDay && <p');
    expect(perDay).toBeGreaterThan(-1);
    // A <p>, so it adds no control to a card whose CTA is already h-12 (48px).
    expect(pricing.slice(perDay, perDay + 160)).not.toContain('<button');
    expect(pricing.slice(perDay, perDay + 160)).not.toContain('<Link');
  });
});
