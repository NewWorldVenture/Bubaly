import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * No client awaits a throwing server action and drops the reason on the floor.
 *
 * The auto and home sections are eleven near-identical clients built on actions
 * that fail by THROWING a translated Error (`saveRow(..., 'Could not save that
 * policy.')`, `softDelete`, `requireUserContext`). Every one of them awaited
 * bare inside a transition:
 *
 *     start(async () => { await deletePolicyAction(p.id); })
 *     <form action={(fd) => start(async () => { await savePolicyAction(fd); setOpen(false); })}>
 *
 * so a refusal threw past everything after it. The modal stayed open, the
 * spinner never cleared, and nothing was said — while the reason sat in the
 * thrown Error, already in the reader's language.
 *
 * `useActionError` catches and keeps that message and reports whether the
 * action got through, so the caller can decide what to close; `<ActionError>`
 * renders it next to the thing that failed. It is not a toast on purpose:
 * these components render on their own in tests with no <ToastProvider> above
 * them, and a toast would turn a failed save into a crash.
 */

const CLIENTS = [
  'components/auto/insurance-client.tsx',
  'components/auto/licenses-client.tsx',
  'components/auto/registration-client.tsx',
  'components/auto/rentals-client.tsx',
  'components/auto/service-client.tsx',
  'components/auto/vehicles-client.tsx',
  'components/home/pros-client.tsx',
  'components/home/service-client.tsx',
  'components/home/warranties-client.tsx',
  'components/app/app-shell.tsx',
];

/** `start(async () => { await someAction(...) })` with no `run(` around it. */
const BARE_AWAIT = /start\w*\(async \(\) => \{[^}]*await (?!run\()\w+Action\(/g;

describe('a thrown server action is reported to the person who caused it', () => {
  for (const file of CLIENTS) {
    const source = readFileSync(file, 'utf8');

    it(`${file.split('/').pop()} routes its actions through run()`, () => {
      expect(source.match(BARE_AWAIT) ?? [], `${file}: an action is awaited bare`).toEqual([]);
      expect(source).toContain('useActionError');
    });

    it(`${file.split('/').pop()} renders the message it captures`, () => {
      // Capturing without rendering is the same silence with more steps.
      expect(source).toMatch(/<ActionError message=\{\w+\}/);
    });
  }

  it('gates the "close the modal" step on the action succeeding', () => {
    // The save handlers closed their modal unconditionally; a refusal has to
    // leave the form open with the reason on it.
    const insurance = readFileSync('components/auto/insurance-client.tsx', 'utf8');
    expect(insurance).toMatch(/if \(await run\(\(\) => savePolicyAction\(fd\)\)\) setOpen\(false\)/);
  });

  it('issuing cards in a loop reports how many actually issued', () => {
    // money-cards-view counted the children it MEANT to issue for, then threw
    // part-way and told nobody; the toast still named the full number.
    const cards = readFileSync('components/wallet/money-cards-view.tsx', 'utf8');
    expect(cards).toMatch(/if \(issued > 0\) success\(`Issued \$\{issued\}/);
    expect(cards).toMatch(/finally \{\s*\n\s*setBusy\(null\);/);
  });

  it('falls back to a message that exists in every locale', () => {
    const helper = readFileSync('components/ui/action-error.tsx', 'utf8');
    expect(helper).toContain("t('globalError.somethingWentWrong')");
    for (const locale of ['en-US', 'nl-NL', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
      expect(messages['globalError.somethingWentWrong'], locale).toBeTruthy();
    }
  });
});
