import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/reports/page.tsx', 'utf8');

// This asserted that a failed read returns an error page. The property behind
// that — a missing read must never pass silently as real data — is kept; the
// response is what changed.
//
// Bailing satisfied the property by showing nothing, and cost the whole page
// whenever one table was unavailable. On production that is routine rather than
// exceptional: the migration ledger stops at 0001-0003, so later tables can be
// absent outright. The page now renders and names the failed reads above the
// content, which is both more useful and equally honest — provided the banner
// is really there, which is what these assertions pin down.
describe('admin reports read boundary', () => {
  it('still inspects every read', () => {
    expect(page).toContain('activeSubCountResult');
    expect(page).toContain('activityResult');
    expect(page).toContain('docsResult');
    expect(page).toContain('familiesResult');
    expect(page).toContain('familyCountResult');
    expect(page).toContain('profilesResult');
    expect(page).toContain('subscriptionsResult');
    expect(page).toContain('userCountResult');
  });

  it('collects the failures rather than discarding them', () => {
    expect(page).toContain('readFailures');
    expect(page).toMatch(/\.filter\(\(\[, res\]\) => res\.error\)/);
  });

  it('names them on screen instead of blanking the page', () => {
    expect(page).toContain('PartialReadBanner');
    expect(page).toContain('failures={readFailures}');
    expect(page).toContain('This report is incomplete — some reads failed:');
    expect(page).not.toContain('return <ErrorState');
  });
});
