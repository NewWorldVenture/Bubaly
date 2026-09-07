import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The marketing header is `sticky top-0`, so it never actually scrolled away.
// It pinned itself to the viewport's top edge — and with `viewport-fit=cover`
// plus `appleWebApp.statusBarStyle: 'black-translucent'` (app/layout.tsx), that
// edge sits UNDERNEATH the iOS status bar. In an installed PWA the header
// therefore rendered its logo and its controls behind the clock, the carrier
// and the battery, clipped by the notch: a header that reads as having slid up
// and disappeared into the top of the screen.
//
// `.app-topbar` in app/globals.css has always applied this inset to the
// authenticated chrome; the marketing header was the surface that never got it.
//
// Additive by construction — env(safe-area-inset-*) is 0 on every device
// without a cutout, and on desktop.

const header = readFileSync('components/marketing/site-header.tsx', 'utf8');

describe('the marketing header clears the status bar instead of hiding under it', () => {
  const shell = header.split('\n').find((line) => line.includes('sticky top-0 z-50')) ?? '';

  it('is still pinned', () => {
    expect(shell).toContain('sticky top-0');
  });

  it('pads the top inset, so "the top" means below the status bar', () => {
    expect(shell).toContain('pt-[var(--safe-top)]');
  });

  it('pads the side insets, for landscape where the cutout takes an edge', () => {
    expect(shell).toContain('pl-[var(--safe-left)]');
    expect(shell).toContain('pr-[var(--safe-right)]');
  });

  it('the mobile menu subtracts the same inset from its viewport height', () => {
    // Without this the open menu overflows the screen by exactly the status
    // bar's height, because it measures 100dvh from the same shifted origin.
    expect(header).toContain('max-h-[calc(100dvh-3.5rem-var(--safe-top))]');
  });
});
