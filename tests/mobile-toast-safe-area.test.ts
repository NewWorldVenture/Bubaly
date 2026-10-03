import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-033: toasts must clear the fixed mobile bottom tab bar (4rem, visible until
// lg) plus the home indicator. The old container used `bottom-20 sm:bottom-6`,
// so on 640–1024px widths (tablets / large phones landscape) toasts dropped to
// 24px and rendered BEHIND the tab bar, and on notched iPhones 80px didn't
// clear bar + safe-area (~98px). The offset must be safe-area-aware and only
// change at lg, when the bar disappears (app-shell nav is lg:hidden).
//
// From lg the stack sits bottom-right, lifted 10rem (`lg:bottom-40`) so it
// clears the two corner controls under it: Quick capture (lg:bottom-6) and
// the AI orb (lg:bottom-24, h-14, so its top sits 9.5rem up). At lg:bottom-6
// it covered both (A11Y-001 #2, on #778).
const toast = readFileSync('components/ui/toast.tsx', 'utf8');

describe('toast container clears the mobile bottom nav (M-033)', () => {
  it('uses a safe-area-aware offset that only changes at lg', () => {
    expect(toast).toContain('bottom-[calc(5rem+var(--safe-bottom))]');
    expect(toast).not.toContain('sm:bottom-6');
    expect(toast).not.toMatch(/\bbottom-20\b/);
  });

  it('is lifted above the corner controls from lg', () => {
    expect(toast).toContain('lg:bottom-40');
    expect(toast).not.toContain('lg:bottom-6');
  });
});
