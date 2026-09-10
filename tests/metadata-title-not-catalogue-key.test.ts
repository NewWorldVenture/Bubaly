import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A Next.js `metadata` export is static: it cannot await `getTranslations()`, so
// whatever string sits in `title` is rendered VERBATIM into <title>. A catalogue
// key there therefore ships to the browser tab as-is — `/admin/system` showed
// "system.systemOverview", and `/dashboard` showed "dashboard.home" to every
// signed-in user.
//
// The i18n gate does not catch it: that scans JSX text, and this is neither JSX
// nor rendered through `t()`. So it needs its own guard.
const CATALOGUE_KEY = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;

function pageFiles(directory = 'app'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? pageFiles(path) : ['page.tsx', 'layout.tsx'].includes(entry.name) ? [path] : [];
  });
}

describe('metadata titles are real text, never catalogue keys', () => {
  it('has no page shipping a catalogue key as its browser-tab title', () => {
    const offenders: string[] = [];
    const files = pageFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/export const metadata: Metadata = \{[^}]*title: '([^']+)'/g)) {
        if (CATALOGUE_KEY.test(m[1])) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises the exact strings that were shipping', () => {
    // Guard the guard: these are the real values found in production.
    for (const key of ['system.systemOverview', 'dashboard.home', 'more.more']) {
      expect(CATALOGUE_KEY.test(key)).toBe(true);
    }
    // and does not fire on legitimate titles
    for (const title of ['Admin Dashboard', 'System Overview', 'Welcome to Bubaly', 'A/B Testing']) {
      expect(CATALOGUE_KEY.test(title)).toBe(false);
    }
  });
});
