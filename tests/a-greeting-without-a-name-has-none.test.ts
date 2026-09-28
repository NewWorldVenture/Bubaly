import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// P-36. A member whose display name is empty was greeted "Good afternoon, ."
// on the dashboard: the name was `display_name ?? …`, and `??` lets an empty
// string through. Four surfaces fell back to the English word 'there', which
// overrode roleGreeting's own translated fallback in every language, and the
// marketplace assistant said "Hi {name}" in English glued to a sentence
// fragment. Found while driving a fresh local account for MAIN-F-M01.

const COMPLETE = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const code = (path: string) =>
  readFileSync(path, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('a greeting without a name has none, in any language', () => {
  const files = execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' }).trim().split('\n');

  it('no surface falls back to an English "there"', () => {
    const hits = files.filter((f) => /(\?\?|\|\|)\s*'there'/.test(code(f)));
    expect(hits).toEqual([]);
  });

  it('the dashboard greeting drops the name, not just the letters, when there is none', () => {
    const src = code('components/dashboard/ai-home-dashboard.tsx');
    expect(src).not.toMatch(/display_name \?\? ctx\.user\.email/);
    expect(src).toMatch(/\{first \? `, \$\{first\}` : ''\}/);
  });

  it('the marketplace greeting is one sentence per language, with and without a name', () => {
    expect(code('components/marketplace/market-assistant.tsx')).not.toMatch(/>\s*Hi \{/);
    for (const c of COMPLETE) {
      const cat = JSON.parse(readFileSync(`lib/i18n/messages/${c}.json`, 'utf8')) as Record<string, string>;
      expect(cat['marketAssistant.greetingNamed'], c).toContain('{name}');
      expect(cat['marketAssistant.greeting'], c).toBeTruthy();
      expect(cat['marketAssistant.greeting'], c).not.toContain('{name}');
    }
  });
});
