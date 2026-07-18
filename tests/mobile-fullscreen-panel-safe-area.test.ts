import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 — safe areas & viewport) [M-018]: the inbox +
// front-desk detail views become a mobile full-screen takeover (`fixed inset-0 z-50`,
// above the bottom nav). They padded only `pt-[var(--safe-top)]`, so their
// bottom-anchored content (the inbox reply composer) sat under the home indicator,
// and landscape side notches clipped the edges. This completes the safe-area padding
// on all four sides (with `lg:` resets — the panels become a static sidebar at lg).
// Additive: portrait / non-notched devices report 0 for these insets.

const panels = {
  inbox: 'components/modules/inbox-module.tsx',
  frontDesk: 'components/modules/front-desk-module.tsx',
};

describe('mobile full-screen detail panels clear the safe area on all sides', () => {
  for (const [name, file] of Object.entries(panels)) {
    it(`${name} (${file}) pads all four safe-area insets with lg resets`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const shell = src.split('\n').find((l) => l.includes('fixed inset-0 z-50 bg-background')) ?? '';
      expect(shell).toContain('pt-[var(--safe-top)]');
      expect(shell).toContain('pb-[var(--safe-bottom)]');
      expect(shell).toContain('pl-[var(--safe-left)]');
      expect(shell).toContain('pr-[var(--safe-right)]');
      // reset on desktop where the panel becomes a static sidebar (no safe area)
      expect(shell).toContain('lg:pt-0');
      expect(shell).toContain('lg:pb-0');
    });
  }
});
