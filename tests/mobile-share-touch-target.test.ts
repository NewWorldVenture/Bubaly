import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets [M-019]):
// the blog article Share bar packs 8 icon-only share targets (7 networks + email)
// plus a Copy-link button. On desktop they are a compact 32px (h-8 w-8) row, but
// 32px is below the 44px minimum tap target (WCAG 2.5.5 / Apple HIG 44pt), so on a
// phone the tightly-packed icons are easy to mis-tap. The fix grows every share
// target to a >=44px square on coarse-pointer (touch) devices via
// `coarse:min-h-11 coarse:min-w-11`, while keeping the dense desktop look. This
// guard locks that in and forbids a regression back to a bare 32px touch target.

const share = fs.readFileSync('app/(marketing)/blog/[slug]/share-buttons.tsx', 'utf8');
const globals = fs.readFileSync('app/globals.css', 'utf8');

describe('blog share bar meets the 44px touch-target minimum (M-019)', () => {
  it('defines the coarse:min-w-11 utility (square-target companion to coarse:min-h-11)', () => {
    expect(globals).toMatch(/@media \(pointer: coarse\)/);
    expect(globals).toMatch(/\.coarse\\:min-w-11\s*\{\s*min-width:\s*2\.75rem/);
    expect(globals).toMatch(/\.coarse\\:min-h-11\s*\{\s*min-height:\s*2\.75rem/);
  });

  it('every 32px icon share target grows to >=44px on touch', () => {
    // Each `h-8 w-8` icon button (networks + email) must carry the coarse escape.
    const iconButtons = share.match(/h-8 w-8/g) ?? [];
    expect(iconButtons.length).toBeGreaterThan(0);
    for (const m of share.matchAll(/className=(?:"|\{cn\()[^]*?h-8 w-8[^]*?(?:"|\))/g)) {
      expect(m[0]).toContain('coarse:min-h-11');
      expect(m[0]).toContain('coarse:min-w-11');
    }
    // That lazy match can open at an earlier className and borrow the Copy-link
    // button's escape, so each icon's own class string is read as well: the
    // quoted literal that holds `h-8 w-8`, one per icon target.
    const iconClasses = [...share.matchAll(/(['"])([^'"\n]*\bh-8 w-8\b[^'"\n]*)\1/g)].map((m) => m[2]);
    expect(iconClasses).toHaveLength(iconButtons.length);
    for (const classes of iconClasses) {
      expect(classes).toMatch(/(?:^| )coarse:min-h-11(?: |$)/);
      expect(classes).toMatch(/(?:^| )coarse:min-w-11(?: |$)/);
    }
  });

  it('the Copy-link button is >=44px tall on touch', () => {
    // The text button uses py-1.5/text-xs (~28px); coarse:min-h-11 lifts it to 44px.
    const copyBlock = share.slice(share.indexOf('onClick={copyLink}'));
    expect(copyBlock).toContain('coarse:min-h-11');
    // Up to its own closing tag only: the icon targets after it carry the same
    // class and would answer for it.
    const end = copyBlock.indexOf('</button>');
    expect(end).toBeGreaterThan(-1);
    expect(copyBlock.slice(0, end)).toMatch(/'[^'\n]*(?:^| )coarse:min-h-11(?: |')/);
  });
});
