import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 — safe areas & viewport) [M-017]: the concierge
// chat panel was sized inline `height: calc(100dvh - 140px)`, which — like the
// messages panel (M-016) — subtracts the top chrome but NOT the fixed mobile bottom
// tab bar (real footprint `4rem + safe-bottom`), so on a phone its composer sat
// behind the nav. Verified in real Chromium (Playwright) against a faithful fixture
// of the app-shell chrome + the concierge `.module-main > .module-page` wrappers
// across iPhone/Pixel/SE portrait + landscape: the bug reproduced on every profile
// and `-4rem-var(--safe-bottom)` cleared the nav on every profile. This guard locks
// the Tailwind formula (inline style replaced) + the `lg:` desktop restore.

const FILE = 'components/modules/concierge-module.tsx';

describe('Concierge chat panel clears the mobile bottom nav', () => {
  const src = fs.readFileSync(FILE, 'utf8');

  it('mobile height subtracts the bottom-nav footprint (4rem + safe-bottom)', () => {
    expect(src).toContain('h-[calc(100dvh-140px-4rem-var(--safe-bottom))]');
  });

  it('restores the full height on desktop (no bottom nav at lg)', () => {
    expect(src).toContain('lg:h-[calc(100dvh-140px)]');
  });

  it('no longer uses the inline calc height that ignored the nav', () => {
    expect(src).not.toContain("style={{ height: 'calc(100dvh - 140px)' }}");
  });
});
