import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 3 — responsive layout / content parity [M-029]):
// the blog article's Table of Contents lived only in the sidebar (`hidden lg:block`),
// so on a phone/tablet a long article had NO in-page jump navigation. The fix adds a
// native <details> collapsible ToC (no JS/hydration) shown only < lg, with anchor
// links to the same h2 ids and 44px-compliant touch targets. Sidebar still owns lg+.
// This guard locks the mobile ToC in.

const page = fs.readFileSync('app/(marketing)/blog/[slug]/page.tsx', 'utf8');

describe('blog article exposes a Table of Contents on mobile (M-029)', () => {
  it('renders a native <details> ToC that is lg:hidden (mobile/tablet only)', () => {
    expect(page).toMatch(/<details className="group[^"]*lg:hidden">/);
    // Gated on multiple headings so a one-item ToC is never shown.
    expect(page).toContain('headings.length > 1');
  });

  it('the ToC links jump to the same in-body h2 anchor ids', () => {
    const idx = page.indexOf('In this article');
    expect(idx).toBeGreaterThan(-1);
    const block = page.slice(idx, idx + 700);
    expect(block).toContain('headings.map');
    expect(block).toContain('href={`#${id}`}');
  });

  it('the ToC jump links meet the 44px touch target on touch', () => {
    const idx = page.indexOf('In this article');
    const block = page.slice(idx, idx + 700);
    expect(block).toContain('coarse:min-h-11');
  });
});
