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
    // ...and the pages that shipped them no longer do. The fix moved each page
    // from a static `metadata` export to `generateMetadata`, which the scan
    // above does not read: handing the key back there
    // (`return { title: 'dashboard.home' }`) ships it exactly as before. So pin
    // the three pages themselves, and what the catalogue says.
    const messages: Record<string, string> = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
    const shipped = [
      { file: 'app/(app)/admin/system/page.tsx', key: 'system.systemOverview', english: 'System Overview' },
      { file: 'app/(app)/dashboard/page.tsx', key: 'dashboard.home', english: 'Home' },
      { file: 'app/(app)/dashboard/more/page.tsx', key: 'more.more', english: 'More' },
    ];
    for (const { file, key, english } of shipped) {
      const source = readFileSync(file, 'utf8');
      // however the page declares its metadata, the title is not a quoted key
      const quotedTitles = [...source.matchAll(/\btitle:\s*(['"`])([^'"`\n]*)\1/g)].map((m) => m[2]);
      expect(quotedTitles.filter((title) => CATALOGUE_KEY.test(title)), file).toEqual([]);
      expect(source, file).not.toMatch(/export const metadata\b/);
      const start = source.indexOf('export async function generateMetadata(): Promise<Metadata> {');
      expect(start, file).toBeGreaterThan(-1);
      const end = source.indexOf('\n}', start);
      expect(end, file).toBeGreaterThan(start);
      const body = source.slice(start, end);
      expect(body, file).toContain('const t = await getTranslations();');
      expect(body, file).toContain(`title: t('${key}')`);
      expect(messages[key], key).toBe(english);
      expect(CATALOGUE_KEY.test(messages[key]), key).toBe(false);
    }
  });
});
