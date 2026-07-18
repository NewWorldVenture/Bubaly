import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 — safe areas & viewport) [M-016]: the full-
// height Messages chat panel was sized `h-[calc(100dvh-var(--topbar-height)-1rem)]`,
// which subtracts the sticky top bar but NOT the fixed mobile bottom tab bar
// (`app-shell` reserves `pb-24` there; the nav's real footprint is `4rem +
// safe-bottom`). So on a phone the composer sat *behind* the bottom nav.
//
// The fix was verified in real Chromium (Playwright) against a faithful fixture of
// the app-shell chrome across iPhone/Pixel/SE portrait + landscape: the bug
// reproduced on every profile and `-4rem-var(--safe-bottom)` cleared the nav on
// every profile (a flat guess like `-5rem` did NOT — it left the composer behind
// the nav on phones with a taller home indicator, which is why the calc must
// subtract the real safe-area inset, not a constant). This guard locks that formula
// and the `lg:` desktop restore (desktop has no bottom nav).

const FILE = 'components/modules/messages-module.tsx';

describe('Messages chat panel clears the mobile bottom nav', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const line = src.split('\n').find((l) => l.includes('100dvh') && l.includes('--topbar-height')) ?? '';

  it('mobile height subtracts the bottom-nav footprint (4rem + safe-bottom)', () => {
    expect(line).toContain('h-[calc(100dvh-var(--topbar-height)-1rem-4rem-var(--safe-bottom))]');
  });

  it('restores the full height on desktop (no bottom nav at lg)', () => {
    expect(line).toContain('lg:h-[calc(100dvh-var(--topbar-height)-1rem)]');
  });
});
