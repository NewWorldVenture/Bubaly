// ROLE-L06: the member's role — on the family members page, the permissions
// matrix (labels AND descriptions), the settings role picker, the app shell,
// the sidebar, the personal dashboard, three places in Messages and the admin
// console — was ROLE_LABELS' English whatever the reader's language, while the
// invite form and the trust screens beside them already said it through
// `trustRole.*`. Screens now render ROLE_LABEL_KEYS / ROLE_DESCRIPTION_KEYS;
// the English maps remain for the assistant's context, which has no reader.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_DESCRIPTION_KEYS, ROLE_LABEL_KEYS, ROLE_ORDER, roleLabel,
} from '@/lib/constants/roles';

const CODES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogue = (code: string) =>
  JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe('a role is named in the reader\'s language', () => {
  it('no screen renders the English role maps', () => {
    const offenders = [...sources('app'), ...sources('components')]
      .filter((file) => /import\s*\{[^}]*\bROLE_(LABELS|DESCRIPTIONS)\b[^}]*\}\s*from\s*'@\/lib\/constants\/roles'/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every full catalogue names and describes every role', () => {
    for (const code of CODES) {
      const messages = catalogue(code);
      for (const role of ROLE_ORDER) {
        expect(messages[ROLE_LABEL_KEYS[role]], `${code} ${role} label`).toBeTruthy();
        expect(messages[ROLE_DESCRIPTION_KEYS[role]], `${code} ${role} description`).toBeTruthy();
      }
    }
  });

  it('the matrix header can still shorten "Parent / Admin" in every language', () => {
    for (const code of CODES) expect(catalogue(code)['trustRole.parent'], code).toMatch(/ \/ /);
  });

  it('an unknown role reads as itself, never as a key', () => {
    const t = (key: string) => catalogue('de-DE')[key] ?? key;
    expect(roleLabel(t, 'guest')).toBe('Gast');
    expect(roleLabel(t, 'grandparent')).toBe('grandparent');
    expect(roleLabel(t, 'constructor')).toBe('constructor');
    expect(roleLabel(t, null)).toBe('');
  });
});
