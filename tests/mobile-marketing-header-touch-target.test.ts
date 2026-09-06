import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets [M-021]):
// the public marketing SiteHeader (shown on every bubaly.com page) had a top-bar
// control cluster with sub-44px interactive targets on touch: the ThemeToggle was
// forced to h-8 w-8 (32px, overriding its own h-10 base), the mobile menu button
// was p-2 + a 24px icon (40px), and the Log in / Get Started pills were h-8 (32px
// tall) on touch tablets. 44px is the Apple HIG / WCAG 2.5.5 minimum tap target.
// The fix grows each to >=44px on coarse-pointer (touch) devices while keeping the
// compact desktop-with-a-mouse density. This guard forbids a regression.

const header = fs.readFileSync('components/marketing/site-header.tsx', 'utf8');
const globals = fs.readFileSync('app/globals.css', 'utf8');

describe('marketing header meets the 44px touch-target minimum (M-021)', () => {
  it('relies on the coarse:min-h-11 / coarse:min-w-11 touch utilities', () => {
    expect(globals).toMatch(/\.coarse\\:min-h-11\s*\{\s*min-height:\s*2\.75rem/);
    expect(globals).toMatch(/\.coarse\\:min-w-11\s*\{\s*min-width:\s*2\.75rem/);
  });

  it('the ThemeToggle grows to a >=44px square on touch', () => {
    // The h-8 w-8 override must carry the coarse escape so it hits 44px on touch.
    const themeLine = header.split('\n').find((l) => l.includes('<ThemeToggle')) ?? '';
    expect(themeLine).toContain('h-8 w-8');
    expect(themeLine).toContain('coarse:min-h-11');
    expect(themeLine).toContain('coarse:min-w-11');
  });

  it('the mobile menu toggle button is a >=44px square on touch', () => {
    // Anchored on aria-controls rather than the button's label: the label is
    // translated (t('nav.toggleMenu')) and copy must be free to change without
    // silently disarming a touch-target guard.
    const anchor = header.indexOf('aria-controls="mobile-navigation"');
    expect(anchor, 'menu toggle must control the mobile nav').toBeGreaterThan(-1);
    const menuBtn = header.slice(header.lastIndexOf('<button', anchor), anchor);
    expect(menuBtn).toContain('coarse:min-h-11');
    expect(menuBtn).toContain('coarse:min-w-11');
  });

  it('every Log in / Get Started link is >=44px tall on touch', () => {
    // Anchored on destination, not label, and covering EVERY such link rather
    // than two hand-picked ones — so a newly added CTA cannot slip in under
    // 44px. The top-bar pills are h-8 and rely on the coarse escape; the links
    // inside the mobile drawer are min-h-11 unconditionally. Either satisfies
    // the 44px minimum.
    const links = header.match(/<Link[^>]*href="\/(?:login|welcome)"[^>]*>/g) ?? [];
    expect(links.length, 'expected the header to still ship auth CTAs').toBeGreaterThanOrEqual(4);
    for (const link of links) {
      expect(link, link).toMatch(/(?:coarse:)?min-h-11/);
    }
  });
});
