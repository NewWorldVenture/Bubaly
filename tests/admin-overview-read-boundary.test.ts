import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/page.tsx');

// The property: the admin overview must never be "rendered from empty
// fallbacks" — a zero must not silently stand in for a read that failed.
//
// It used to satisfy that by refusing to render at all, and that is the bug the
// operator actually hit: one unavailable table returned the whole dashboard as
// an error page. On production that is the expected case, not an edge one — the
// migration ledger stops at 0001-0003, so admin_notifications, support_tickets
// and documents may not exist there at all.
//
// The page now renders and names the failed reads above the tiles, so the
// fallbacks are visible AS fallbacks. Both halves are asserted: it must collect
// the failures, and it must show them.
describe('admin overview read boundary', () => {
  it('inspects every required read', () => {
    for (const result of [
      'familyCountResult', 'familiesResult', 'subscriptionsResult',
      'adminNotesResult', 'unreadNoteCountResult',
    ]) expect(source).toContain(result);
    expect(source).toContain("'error' in actorsResult");
  });

  it('collects the failures instead of discarding them', () => {
    expect(source).toContain('loadErrors');
    expect(source).toMatch(/\.filter\(\(\[, res\]\) => res\.error\)/);
  });

  it('shows them on screen, so an empty tile is never mistaken for real data', () => {
    // readUiSource resolves the catalogue to English, so this asserts the
    // words the operator actually reads — not the key, which could resolve
    // to an empty string and still pass.
    expect(source).toContain('Some data could not be loaded from Supabase. The dashboard below is incomplete.');
    expect(source).toContain('loadErrors.map');
    // No early return may hide the banner.
    expect(source).not.toContain('return (\n      <div className="module-page space-y-5">\n        <div>\n          <h1');
  });
});
