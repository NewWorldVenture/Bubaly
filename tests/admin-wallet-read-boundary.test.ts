import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/wallet/page.tsx');

// The property this has always protected, in its own words: a failed wallet
// read must never become "zero-valued oversight". On a money page that matters
// more than anywhere else — "0 flagged transactions" because the read failed
// looks exactly like "0 flagged transactions" because there are none, and one
// of those is an all-clear the operator has not actually been given.
//
// What changed is HOW that is honoured. It used to return an error page, which
// satisfied the property by showing nothing at all — and cost the operator the
// entire wallet overview whenever a single table was unavailable, which on
// production is routine while the migration ledger sits at 0001-0003.
//
// Now the page renders and names the failed reads on screen. The zeros are
// still never presented as fact, because the banner is above them saying which
// reads are missing. That is strictly more useful than a blank page and just as
// honest — but ONLY while the banner is actually rendered, which is what these
// assertions now pin down.
describe('admin wallet overview read boundary', () => {
  it('still inspects every required wallet read', () => {
    expect(source).toContain('activeWalletsResult');
    expect(source).toContain('creditAggResult');
    expect(source).toContain('flagsResult');
    expect(source).toContain('auditResult');
  });

  it('collects those failures rather than discarding them', () => {
    expect(source).toContain('readFailures');
    expect(source).toMatch(/\.filter\(\(\[, res\]\) => res\.error\)/);
  });

  it('renders the failures on screen, so a zero is never read as an all-clear', () => {
    expect(source).toContain('PartialReadBanner');
    expect(source).toContain('failures={readFailures}');
    // The banner must be reachable — not behind an early return that hides it.
    expect(source).not.toContain('return <ErrorState');
  });
});
