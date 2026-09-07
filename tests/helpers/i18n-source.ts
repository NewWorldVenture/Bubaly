import fs from 'node:fs';

import { SOURCE_MESSAGES } from '@/lib/i18n/messages';

// Reading a component's SOURCE and asserting on the copy in it is a pattern used
// by ~73 guard tests in this repo — a11y labels, touch targets, empty states.
// They are cheap and they catch real regressions.
//
// The i18n migration breaks every one of them: `aria-label="Previous photo"`
// becomes `aria-label={t('photos.previousPhoto')}`, and a test looking for the
// English no longer finds it even though the rendered label is identical. That
// is a false failure — the a11y guarantee still holds — and rewriting 73 files
// to assert on key names would make them worse: a key is not what a user hears,
// and a test asserting `t('photos.previousPhoto')` passes happily if the
// catalogue value is the empty string.
//
// So instead this resolves the catalogue back to English at read time. The tests
// keep asserting on the words a person actually sees, and they keep working for
// components whether or not they have been migrated yet.

/** Matches a translate call in either binding the extractor may have chosen. */
const CALL = String.raw`(?:t|tr|i18nT|translateMessage|i18nTranslate)\('([^']+)'\)`;

/**
 * Read a component and substitute catalogue English for its translate calls, so
 * the returned source reads the way it did before the string was extracted.
 *
 * Attribute position (`aria-label={t('k')}`) restores the quoted form; JSX text
 * position (`>{t('k')}<`) restores the bare text. A key with no catalogue entry
 * is left untouched rather than silently blanked — a missing key should surface
 * as a failing assertion, not as an empty string that quietly passes.
 */
export function readUiSource(path: string): string {
  const raw = fs.readFileSync(path, 'utf8');
  return raw
    .replace(new RegExp(String.raw`=\{${CALL}\}`, 'g'), (match, key: string) => {
      const english = SOURCE_MESSAGES[key];
      return english === undefined ? match : `="${english}"`;
    })
    .replace(new RegExp(String.raw`\{${CALL}\}`, 'g'), (match, key: string) => {
      const english = SOURCE_MESSAGES[key];
      return english === undefined ? match : english;
    });
}
