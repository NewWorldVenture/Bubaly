import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMessages } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

/**
 * Parity between English and the catalogues that are supposed to be complete.
 *
 * `tests/i18n-catalogue-integrity.test.ts` checks ORPHANS — a key a locale
 * carries that English no longer has — and never the reverse. The reverse is the
 * direction a reader notices: a key English has and a locale does not is a
 * sentence that comes out in the wrong language.
 *
 * Parity IS enforced elsewhere, but one namespace at a time, in whichever
 * feature test somebody remembered to write it in:
 *
 *   tests/contact-timeline-localization.test.ts   every `contactTimeline.` key
 *   tests/files-hub-localization.test.ts          every `filesHubModule.` key
 *   tests/photos-localization.test.ts, contacts-localization.test.ts, …
 *
 * That is coverage by memory, and it has the gap you would predict: thirty-four
 * English keys are absent from all six complete catalogues, in six namespaces —
 * `quickCapture.`, `commandBar.`, `roleSurface.`, `displayComfort.`,
 * `trialPaywallGate.` and part of `actions.` — and five of those six have no
 * parity test at all. The same thirty-four in every locale, which is the
 * signature of one batch of copy that shipped and never reached translation.
 *
 * What it is NOT. These do not render as raw keys, and the test below proves it
 * rather than asserting it: `getMessages` seeds every merge with `{ ...enUS }`
 * — "en-US is the root of every chain and is therefore never listed" — so a
 * missing key resolves to the English string. A German reader gets the quick
 * capture sheet, the command bar, the density settings and the trial paywall in
 * English inside an otherwise German product. Degraded, not broken, and worth
 * saying precisely: the alarming version of this finding would be raw keys on
 * screen, and that is not what happens.
 *
 * So this file does not invent the translations. Writing German, Spanish,
 * French, Italian, Dutch and Portuguese product copy that nobody here can read
 * back is worse than leaving the gap visible — it is the same "16 labels and 66
 * selects need copy in eleven locales" already filed for an owner. What this
 * file does is stop the gap GROWING, and record exactly what it is.
 */

const DIR = join(process.cwd(), 'lib/i18n/messages');
const read = (file: string) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, string>;
const source = read('en-US.json');

/**
 * Catalogues that are OVERLAYS: they carry only the keys where they diverge from
 * a nearer relative and inherit everything else, so a key they do not hold is a
 * deliberate absence rather than a gap. Full parity is not their contract.
 *
 * `en-GB` is one of these even though `FALLBACK_CHAIN` does not list it, because
 * en-US is the implicit root of every chain — the merge starts at `{ ...enUS }`.
 * It is spelled out here so the exemption is a claim rather than an oversight.
 */
const OVERLAYS: Record<string, string> = {
  'en-GB.json': 'overlay on en-US, the implicit root of every merge',
  'es-MX.json': 'overlay on es-ES (FALLBACK_CHAIN)',
  'es-US.json': 'overlay on es-MX then es-ES (FALLBACK_CHAIN)',
  'fr-CA.json': 'overlay on fr-FR (FALLBACK_CHAIN)',
};

/**
 * The untranslated backlog exactly as it stands. A ratchet, not a permission
 * slip: this list may only SHRINK. A new English key that ships without its six
 * translations fails the first rule below; a key translated everywhere fails the
 * second until it is deleted from here.
 */
const UNTRANSLATED: string[] = [
  "actions.missingSubmission",
  "actions.submissionNotFound",
  "actions.couldNotApproveTryAgain",
  "actions.couldNotAwardTheRewardTryAgain",
  "actions.couldNotSaveThatDecision",
  "actions.couldNotSendThatToAParent",
  "actions.giveTheChoreATitle",
  "actions.couldNotCreateTheChore",
  "actions.couldNotAssignTheChore",
  "quickCapture.task",
  "quickCapture.note",
  "quickCapture.event",
  "quickCapture.shopping",
  "quickCapture.egPackLunches",
  "quickCapture.jotSomethingDown",
  "quickCapture.egDentistAt3pm",
  "quickCapture.egMilk",
  "quickCapture.undo",
  "quickCapture.itemsAdded",
  "quickCapture.saved",
  "commandBar.undo",
  "commandBar.itemsAdded",
  "displayComfort.auto",
  "displayComfort.followYourRole",
  "roleSurface.densityStandard",
  "roleSurface.densityCozy",
  "roleSurface.densityRelaxed",
  "roleSurface.densityStandardDesc",
  "roleSurface.densityCozyDesc",
  "roleSurface.densityRelaxedDesc",
  "trialPaywallGate.familyBasic",
  "trialPaywallGate.familyPlus",
  "trialPaywallGate.basicTagline",
  "trialPaywallGate.plusTagline",];

const COMPLETE = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'en-US.json' && !OVERLAYS[f]);

describe('every complete catalogue is complete', () => {
  it('finds the catalogues at all (guards the guard)', () => {
    // A scan that matched nothing would make every rule below vacuous.
    expect(COMPLETE.length).toBe(6);
    expect(Object.keys(source).length).toBeGreaterThan(10_000);
  });

  it.each(COMPLETE)('%s is missing nothing but the recorded backlog', (file) => {
    const known = new Set(UNTRANSLATED);
    const catalogue = read(file);
    const unrecorded = Object.keys(source).filter((key) => !(key in catalogue) && !known.has(key));
    expect(
      unrecorded,
      `${file} is missing ${unrecorded.length} English key(s) that nobody recorded. A `
      + 'string added to en-US.json has to reach the six complete catalogues too, or '
      + 'it reaches that reader in English. Translate them, or add them to '
      + 'UNTRANSLATED to state plainly that they are owed:\n'
      + unrecorded.map((k) => `  ${k} = ${JSON.stringify(source[k])}`).join('\n'),
    ).toEqual([]);
  });

  it('carries no backlog entry that is already translated everywhere', () => {
    // The list shrinks as the copy lands, and never lies about what is owed.
    const done = UNTRANSLATED.filter((key) => COMPLETE.every((file) => key in read(file)));
    expect(
      done,
      'these are translated in every complete catalogue now; remove them from '
      + `UNTRANSLATED:\n${done.map((k) => `  ${k}`).join('\n')}`,
    ).toEqual([]);
  });

  it('carries no backlog entry English has dropped', () => {
    // A key deleted from the source is not owed to anybody.
    const stale = UNTRANSLATED.filter((key) => !(key in source));
    expect(stale, `no longer in en-US.json; remove from UNTRANSLATED:\n${stale.join('\n')}`).toEqual([]);
  });

  it('resolves the backlog to English rather than to a raw key', () => {
    // The finding's own limit, checked rather than asserted. `getMessages` seeds
    // the merge with `{ ...enUS }`, so the reader sees an English sentence. If
    // that ever stops being true these become the literal key text on screen,
    // which is a different and much worse bug — so it is pinned here.
    for (const file of COMPLETE) {
      const locale = file.replace('.json', '') as LocaleCode;
      const merged = getMessages(locale);
      for (const key of UNTRANSLATED) {
        expect(merged[key], `${locale} would render ${key} as a raw key`).toBe(source[key]);
      }
    }
  });

  it('names an overlay for every locale it exempts, and exempts no other', () => {
    // Non-vacuity for the exemption itself: a new locale cannot become an
    // overlay by being added to the list, only by being one.
    const shipped = new Set(readdirSync(DIR).filter((f) => f.endsWith('.json')));
    for (const [file, why] of Object.entries(OVERLAYS)) {
      expect(shipped.has(file), `${file} is exempted but not shipped`).toBe(true);
      expect(/overlay on /.test(why), `${file} does not say what it overlays`).toBe(true);
    }
    // Every shipped catalogue is either the source, an overlay, or complete.
    expect(shipped.size).toBe(1 + Object.keys(OVERLAYS).length + COMPLETE.length);
  });
});
