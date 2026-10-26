// ROLE-L07: the App Lock panel's toasts, its "On" badge and the whole PIN
// dialog (title, prompt, both validation errors, both buttons) were English in
// every language; and a save that never completed — the server action rejects
// when offline — left the panel
// on "saving" with every button disabled and no message.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/settings/app-lock-settings.tsx', 'utf8');
const KEYS = ['appLockIsOn', 'appLockTurnedOff', 'pinUpdated', 'on', 'savePin', 'next', 'enterExactly4Digits',
  'pinsDidNotMatch', 'setA4DigitPin', 'confirmYourPin', 'chooseAPinToLock', 'enterItAgainToConfirm'].map((k) => `appLockSettings.${k}`);

describe('App Lock settings say what happened, in the reader\'s language', () => {
  it('has no English literal on screen', () => {
    const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/console\.\w+\([^)]*\)/g, '');
    expect(code).not.toMatch(/'(?:App Lock|PIN|Enter|Set a|Confirm|Choose|Next|Save|Turn on)[^']*'/);
    expect(code).not.toMatch(/\/> On\n/);
    for (const key of KEYS) expect(source).toContain(`t('${key}')`);
  });

  it('the server save can fail without stranding the panel and credentials never return to the client', () => {
    const save = source.slice(source.indexOf('async function save('), source.indexOf('async function setEnabled('));
    expect(save).toMatch(/try \{\s*return await saveAppLockConfig\(cfg\);\s*\} catch/);
    expect(source.match(/saveAppLockConfig\(/g)).toHaveLength(1);
    expect(source).toContain('await getAppLockSettings()');
    expect(source).toContain('await save({ enabled: nextEnabled, pin })');
    expect(source).not.toContain('buildAppLockConfig');
    expect(source).not.toContain(".from('user_preferences')");
    expect(source).toContain('type="password"');
  });

  it('every full catalogue says all of it', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      for (const key of [...KEYS, 'appLockActions.couldNotSaveAppLockSettings']) expect(messages[key], `${code} ${key}`).toBeTruthy();
    }
  });
});
