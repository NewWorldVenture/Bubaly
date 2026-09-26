import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/activity/page.tsx', 'utf8');
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

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
describe('activity feed read boundary', () => {
  it('still inspects every read', () => {
    expect(page).toContain('announcementsResult');
    expect(page).toContain('choresResult');
    expect(page).toContain('eventsResult');
    expect(page).toContain('groceryResult');
    expect(page).toContain('membersResult');
    expect(page).toContain('notesResult');
    expect(page).toContain('photosResult');
  });

  it('collects the failures rather than discarding them', () => {
    expect(page).toContain('readFailures');
    expect(page).toMatch(/\.filter\(\(\[, res\]\) => res\.error\)/);
  });

  it('names them on screen instead of blanking the page', () => {
    expect(page).toContain('PartialReadBanner');
    expect(page).toContain('failures={readFailures}');
    // The banner's sentence used to be a literal in this file and is now a
    // catalogue key (I18N-006), so both halves are pinned: the page asks for the
    // key, and the key still says what the literal said. Held end to end by
    // tests/a-failed-read-names-itself-in-the-familys-language.test.ts.
    expect(page).toContain("title={t('activity.someActivityCouldNotBe')}");
    expect(messages['activity.someActivityCouldNotBe']).toBe('Some activity could not be loaded:');
    expect(page).not.toContain('return <ErrorState');
  });
});
