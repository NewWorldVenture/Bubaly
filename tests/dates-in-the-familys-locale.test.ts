import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// I18N-006. Bubaly is region-aware by design (lib/i18n/locales.ts: "a family
// in Mexico and a family in Spain both read Spanish but expect different
// dates"), yet 130 calls in the signed-in app and the marketing pages
// formatted dates and times with a hard-coded 'en-US'. A German family read
// "Mar 4" beside German copy, and an en-GB family read 3/4/2026 for 3 April.
// Every one now formats in the active locale: useLocale().code in a client
// component, getLocaleContext() in a server one, and a `locale` parameter on
// the module helpers, so tsc found every caller. Voice capture listened for
// English whatever the family spoke; it now listens in the family's language.
//
// Left on purpose, and outside this guard: app/api (prompts written for the
// model, not for a reader) and USD currency formatting, which is a product
// decision about currency rather than a translation.
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return path === join('app', 'api') || name === 'node_modules' ? [] : files(path);
  return name.endsWith('.tsx') ? [path] : [];
});
const ui = ['app', 'components'].flatMap(files);
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//'));

describe('dates and times are formatted in the family\'s locale', () => {
  it('scans the real UI (guards the guard)', () => {
    expect(ui.length).toBeGreaterThan(500);
    expect(ui.some((f) => f.startsWith(join('app', 'api')))).toBe(false);
  });

  it('no date or time is formatted with a hard-coded en-US', () => {
    const sites = ui.flatMap((f) => code(f).map((line, i) =>
      /\.toLocale(Date|Time)?String\(\s*['"]en-US['"]|Intl\.DateTimeFormat\(\s*['"]en-US['"]/.test(line) ? `${f}:${i + 1}` : null,
    ).filter((x): x is string => x !== null));
    expect(sites, "pass useLocale().code, (await getLocaleContext()).locale.code, or a `locale` parameter").toEqual([]);
  });

  it('voice capture listens in the family\'s language', () => {
    const shell = code('components/capture/capture-shell.tsx').join('\n');
    expect(shell).toMatch(/recognition\.lang = locale\b/);
    expect(shell).toContain('useLocale().code');
  });
});
