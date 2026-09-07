import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 3 — responsive layout / content parity [M-039]):
// the shared legal-page layout (privacy / terms / acceptable-use / cookies) rendered
// its "On this page" table of contents only in the sidebar (`hidden lg:block`), so on
// a phone/tablet a long legal document had NO jump navigation (despite a comment
// claiming the ToC "collapses above the content on mobile" — it didn't). The fix adds
// a native <details> collapsible ToC shown only < lg, with anchor links to the same
// section ids and 44px-compliant touch targets. Sidebar still owns lg+.

//
// The heading itself is now `t('legal.onThisPage')` rather than the literal
// "On this page" — the page is translated into twelve locales. So these tests
// anchor on the mobile <details> BLOCK instead of on the English words, which is
// what they were really about; the label is checked separately, through the
// catalogue, so it cannot silently disappear either.
const legal = fs.readFileSync('components/marketing/legal.tsx', 'utf8');
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

/** The mobile ToC, from its <details> to the end of that element. */
function mobileToc(): string {
  const idx = legal.search(/<details className="group[^"]*lg:hidden">/);
  expect(idx, 'the mobile <details> ToC should exist').toBeGreaterThan(-1);
  return legal.slice(idx, idx + 900);
}

describe('legal pages expose a Table of Contents on mobile (M-039)', () => {
  it('renders a native <details> ToC that is lg:hidden (mobile/tablet only)', () => {
    expect(legal).toMatch(/<details className="group[^"]*lg:hidden">/);
    expect(legal).toContain('sections.length > 1');
  });

  it('the ToC links jump to the same section anchor ids', () => {
    const block = mobileToc();
    expect(block).toContain('sections.map');
    expect(block).toContain('href={`#${s.id}`}');
  });

  it('the ToC summary + jump links meet the 44px touch target on touch', () => {
    const block = mobileToc();
    // Twice: once on the <summary> that opens it, once on each jump link.
    expect(block.match(/coarse:min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the ToC is still headed, in words a reader gets in their own language', () => {
    expect(mobileToc()).toContain("t('legal.onThisPage')");
    expect(messages['legal.onThisPage']).toBe('On this page');
  });

  it('the desktop sidebar ToC stays lg-only (no duplicate on mobile)', () => {
    expect(legal).toMatch(/<aside className="hidden lg:block">/);
  });
});
