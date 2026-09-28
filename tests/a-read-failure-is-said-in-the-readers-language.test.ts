import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// P-38. Two family-facing controls showed a failed read as the raw error and
// nothing else: the App Lock card said "TypeError: Failed to fetch" and an
// event's RSVP list said whatever PostgREST answered, in English in every
// language. Found by the MAIN-F-J04 retest, which aborted the App Lock read in
// a browser: the card rightly no longer offered "Set up PIN" over a configured
// lock, and after the client's retries it printed the TypeError. The message is
// now the catalogue's; the raw text stays in the title attribute and the log.

const COMPLETE = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const SITES = [
  { file: 'components/settings/app-lock-settings.tsx', state: 'loadError', key: 'appLockSettings.couldNotLoad' },
  { file: 'components/modules/event-detail-modal.tsx', state: 'rsvpError', key: 'eventDetailModal.couldNotLoadRsvps' },
];

describe('a failed read is said in the reader’s language', () => {
  it.each(SITES)('$file renders its message, not the raw error', ({ file, state, key }) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(new RegExp(`>\\{${state}\\}<`));
    expect(src).toContain(`title={${state}}`);
    expect(src).toContain(`t('${key}')`);
  });

  it('every complete catalogue carries both messages', () => {
    for (const c of COMPLETE) {
      const cat = JSON.parse(readFileSync(`lib/i18n/messages/${c}.json`, 'utf8')) as Record<string, string>;
      for (const { key } of SITES) expect(cat[key], `${c} ${key}`).toBeTruthy();
    }
  });
});
