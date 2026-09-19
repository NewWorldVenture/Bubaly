import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A server action that throws must reach the person who pressed the button.
 *
 * These actions are declared `Promise<void>` and signal failure by THROWING a
 * translated Error — `requireSocialPermission` raises SocialAccessError, the
 * paperwork actions throw their own `tr(...)` messages. Their callers awaited
 * them bare inside `startTransition`:
 *
 *     startTransition(async () => {
 *       await setPaperworkStatusAction({ itemId, status });
 *       setBusyKey(null);          // ← never runs when the await throws
 *     });
 *
 * So a refusal produced a button that span forever and said nothing. The reason
 * existed, was already translated, and went nowhere.
 *
 * Each call site now catches, shows the thrown message (falling back to a
 * translated generic), and clears its busy state in a `finally` so the control
 * is released whichever way the action went.
 */

const SITES: { file: string; action: string; busy?: string }[] = [
  { file: 'components/modules/paperwork-module.tsx', action: 'materializePaperworkActionAction', busy: 'setBusyKey(null)' },
  { file: 'components/modules/paperwork-module.tsx', action: 'setPaperworkStatusAction', busy: 'setBusyKey(null)' },
  { file: 'components/modules/paperwork-module.tsx', action: 'addPaperworkAction' },
  { file: 'components/modules/contact-timeline-module.tsx', action: 'deleteInteractionAction', busy: 'setBusyId(null)' },
  { file: 'components/modules/contact-timeline-module.tsx', action: 'logInteractionAction' },
  { file: 'components/social/account-row.tsx', action: 'disconnectAccountAction' },
];

/** The awaited call plus whatever follows it, up to the end of the arrow body. */
function callSite(source: string, action: string): string {
  const at = source.indexOf(`await ${action}(`);
  expect(at, `${action} is no longer called — did the module change?`).toBeGreaterThan(-1);
  const from = source.lastIndexOf('startTransition', at) >= 0
    ? Math.max(source.lastIndexOf('startTransition', at), source.lastIndexOf('start(', at))
    : at - 200;
  return source.slice(from, at + 400);
}

describe('a thrown action is reported, not swallowed', () => {
  for (const { file, action, busy } of SITES) {
    const source = readFileSync(file, 'utf8');

    it(`${action} is awaited inside a catch`, () => {
      const site = callSite(source, action);
      expect(site, `${action}: no catch around the await`).toMatch(/try \{[\s\S]*catch \(err\)/);
    });

    it(`${action} shows the thrown message`, () => {
      const site = callSite(source, action);
      // The actions throw already-translated text, so the message itself is the
      // best thing to show; the generic is only the fallback.
      expect(site).toMatch(/err instanceof Error && err\.message \? err\.message :/);
    });

    if (busy) {
      it(`${action} clears its busy state in a finally`, () => {
        const site = callSite(source, action);
        expect(site, `${action}: ${busy} is not in a finally`).toMatch(
          new RegExp(`finally \\{[\\s\\S]{0,80}${busy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        );
      });
    }
  }

  it('falls back to a message that exists in every locale', () => {
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['globalError.somethingWentWrong'], locale).toBeTruthy();
    }
  });
});
