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
      // Anchor on the STRUCTURE of the takeover, not on its background class. The
      // anchor used to read `fixed inset-0 z-50 bg-background`, and `bg-background`
      // names a colour this theme never defined — so the panel had no background at
      // all, and fixing that silently unhooked this test: `.find` returned
      // undefined, `shell` became '', and all six assertions failed on a file that
      // had not changed in the way they check. A guard should not depend on a
      // neighbouring class it says nothing about.
      const shells = src.split('\n').filter((l) => l.includes('fixed inset-0 z-50'));
      expect(shells, `${file} should hold exactly one full-screen takeover shell`).toHaveLength(1);
      const shell = shells[0];
      expect(shell).toMatch(/\bbg-(bg|surface|elevated)\b/);
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
