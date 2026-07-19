import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 3 — responsive layout / content parity [M-039]):
// the shared legal-page layout (privacy / terms / acceptable-use / cookies) rendered
// its "On this page" table of contents only in the sidebar (`hidden lg:block`), so on
// a phone/tablet a long legal document had NO jump navigation (despite a comment
// claiming the ToC "collapses above the content on mobile" — it didn't). The fix adds
// a native <details> collapsible ToC shown only < lg, with anchor links to the same
// section ids and 44px-compliant touch targets. Sidebar still owns lg+.

const legal = fs.readFileSync('components/marketing/legal.tsx', 'utf8');

describe('legal pages expose a Table of Contents on mobile (M-039)', () => {
  it('renders a native <details> ToC that is lg:hidden (mobile/tablet only)', () => {
    expect(legal).toMatch(/<details className="group[^"]*lg:hidden">/);
    expect(legal).toContain('sections.length > 1');
  });

  it('the ToC links jump to the same section anchor ids', () => {
    const idx = legal.indexOf('On this page');
    expect(idx).toBeGreaterThan(-1);
    const block = legal.slice(idx, idx + 700);
    expect(block).toContain('sections.map');
    expect(block).toContain('href={`#${s.id}`}');
  });

  it('the ToC summary + jump links meet the 44px touch target on touch', () => {
    const idx = legal.indexOf('On this page');
    const block = legal.slice(idx, idx + 700);
    expect(block).toContain('coarse:min-h-11');
  });

  it('the desktop sidebar ToC stays lg-only (no duplicate on mobile)', () => {
    expect(legal).toMatch(/<aside className="hidden lg:block">/);
  });
});
