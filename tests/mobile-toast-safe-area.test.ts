import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-033: toasts must clear the fixed mobile bottom tab bar (4rem, visible until
// lg) plus the home indicator. The old container used `bottom-20 sm:bottom-6`,
// so on 640–1024px widths (tablets / large phones landscape) toasts dropped to
// 24px and rendered BEHIND the tab bar, and on notched iPhones 80px didn't
// clear bar + safe-area (~98px). The offset must be safe-area-aware and only
// shrink at lg, when the bar disappears (app-shell nav is lg:hidden).
const toast = readFileSync('components/ui/toast.tsx', 'utf8');

describe('toast container clears the mobile bottom nav (M-033)', () => {
  it('uses a safe-area-aware offset that only drops at lg', () => {
    expect(toast).toContain('bottom-[calc(5rem+var(--safe-bottom))]');
    expect(toast).toContain('lg:bottom-6');
    expect(toast).not.toContain('sm:bottom-6');
    expect(toast).not.toMatch(/\bbottom-20\b/);
  });
});
