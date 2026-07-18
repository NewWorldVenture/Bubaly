import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 3 — responsive layout / content parity [M-027]):
// the blog article page renders "Related Articles" only inside the right sidebar,
// which is `hidden lg:block` — so on a phone/tablet (< lg) readers got NO
// related-article navigation at all (a content-parity + internal-linking gap for
// the majority mobile audience). The fix adds a `lg:hidden` inline Related section
// that mirrors the sidebar list for < lg, while the sticky sidebar owns lg+. This
// guard locks the mobile parity in and the desktop sidebar's lg-scoping.

const page = fs.readFileSync('app/(marketing)/blog/[slug]/page.tsx', 'utf8');

describe('blog article shows Related Articles on mobile too (M-027)', () => {
  it('renders an inline Related section that is visible below lg (mobile/tablet)', () => {
    const idx = page.indexOf('aria-label="Related articles"');
    expect(idx).toBeGreaterThan(-1);
    // The inline related section is shown on small screens and hidden at lg+.
    const block = page.slice(idx - 120, idx + 40);
    expect(block).toContain('lg:hidden');
  });

  it('the inline mobile Related section maps over the fetched related posts', () => {
    const idx = page.indexOf('aria-label="Related articles"');
    const block = page.slice(idx, idx + 900);
    expect(block).toContain('related.map');
    expect(block).toContain('/blog/${r.slug}');
  });

  it('the desktop sidebar copy stays lg-only (no duplicate on mobile)', () => {
    // The <aside> that carries the sticky sidebar (ToC + related + subscribe) is
    // hidden below lg, so the inline section is the sole mobile render.
    expect(page).toMatch(/<aside className="hidden lg:block">/);
  });
});
