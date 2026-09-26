import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A server page that could not read must not answer as if it had.
 *
 * `settleAll` turns a rejected read into `{ data: null, error }` so one
 * unreachable table cannot cost the whole page. That is the right default — but
 * a page that destructures only `data` then renders `data ?? []` converts a
 * failed read into a confident, wrong answer.
 *
 * Two of these are not merely degraded, they are misleading:
 *
 *   /dashboard/conflicts   `detectConflicts([])` is an empty list, which the
 *                          page renders as the ALL-CLEAR. A conflict detector
 *                          that could not read the calendar must not say there
 *                          are no clashes.
 *
 *   /dashboard/family-access  an unreadable `child_logins` makes every child
 *                          look as though they have no login, on the page whose
 *                          whole purpose is deciding who to give one to — so a
 *                          parent creates a second login for a username that is
 *                          already taken.
 *
 * Both now stop and say so. The guardian pages keep their documented
 * degradation ("one unreachable table costs its own list, not the page") and
 * gain the log that was missing, which is the repo's own rule from
 * meals-module: degrade, but never silently.
 */

describe('a page that could not read says so', () => {
  it('the conflict detector refuses to give an all-clear it cannot support', () => {
    const source = readFileSync('app/(app)/dashboard/conflicts/page.tsx', 'utf8');
    expect(source).toMatch(/error: eventsError/);
    expect(source).toMatch(/if \(readError\)/);
    expect(source).toContain("conflicts.couldNotCheckForClashes");
    // The check must come BEFORE the detector runs, or it is decoration.
    expect(source.indexOf('if (readError)')).toBeLessThan(source.indexOf('const conflicts = detectConflicts('));
  });

  it('the kid-login page refuses to show an empty roster it cannot support', () => {
    const source = readFileSync('app/(app)/dashboard/family-access/page.tsx', 'utf8');
    expect(source).toMatch(/error: loginsError/);
    expect(source).toContain('familyAccess.couldNotLoadKidLogins');
    expect(source.indexOf('if (readError)')).toBeLessThan(source.indexOf('const usernameByMember'));
  });

  it('the guardian pages keep degrading, but no longer in silence', () => {
    const contacts = readFileSync('app/(app)/guardian/contacts/page.tsx', 'utf8');
    expect(contacts).toContain("console.error('[guardian/contacts] contact read failed'");
    // Still degrades — no early return was added to a page that documented why.
    expect(contacts).not.toMatch(/if \(contactsError\) return/);

    const settings = readFileSync('app/(app)/guardian/settings/page.tsx', 'utf8');
    expect(settings).toContain("console.error('[guardian/settings] profile read failed'");
  });

  it('both new messages exist in every locale', () => {
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['conflicts.couldNotCheckForClashes'], locale).toBeTruthy();
      expect(messages['familyAccess.couldNotLoadKidLogins'], locale).toBeTruthy();
    }
  });
});
