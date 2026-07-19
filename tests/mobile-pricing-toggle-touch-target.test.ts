import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets [M-038]):
// the pricing page's billing-period toggle (Monthly / Yearly) — a key conversion
// control — used px-5 py-2 (~36px tall), below the 44px minimum tap target on
// touch. Both segments now carry coarse:min-h-11 (>=44px on touch) while staying
// compact on desktop-with-a-mouse. The plan-card CTAs and demo button were already
// h-12 (48px), so they were left as-is. This guard forbids a regression.

const pricing = fs.readFileSync('app/(marketing)/pricing/pricing-content.tsx', 'utf8');

describe('pricing billing-period toggle meets the 44px touch target (M-038)', () => {
  it('both Monthly/Yearly segments grow to >=44px on touch', () => {
    for (const period of ['monthly', 'yearly']) {
      const idx = pricing.indexOf(`setPeriod('${period}')`);
      expect(idx).toBeGreaterThan(-1);
      const block = pricing.slice(idx, idx + 260);
      expect(block).toContain('coarse:min-h-11');
    }
  });
});
