import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// I18N-004, the browser-tab half. 302 pages set `metadata = { title: 'English' }`,
// so a German family's tabs, history and bookmarks read "Orders · Marketplace".
// 50 of them also ended in "| Bubaly" or "· Bubaly" while the root layout's
// template already appends " · Bubaly": the tab read "Trip Planner | Bubaly ·
// Bubaly". Every signed-in, auth and public-link page now builds its title in
// generateMetadata() from the catalogue, and the brand comes from the template
// alone.
//
// Left on purpose: the staff-only /admin pages, the root layout's default
// title (the brand line), and /offline, which must stay static so the service
// worker can precache it.
const pages = execSync("git ls-files 'app/**/page.tsx' 'app/**/layout.tsx'", { encoding: 'utf8' }).trim().split('\n');
const EXEMPT = (f: string) => f.includes('/admin/') || f === 'app/layout.tsx' || f === 'app/offline/page.tsx';
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('page titles', () => {
  it('reads the real tree (guards the guard)', () => {
    expect(pages.length).toBeGreaterThan(300);
    expect(pages.filter((f) => /generateMetadata/.test(code(f))).length).toBeGreaterThan(300);
  });

  it('no page outside the exemptions sets a literal title', () => {
    const literal = pages.filter((f) => !EXEMPT(f)).filter((f) => /export const metadata[^=]*=\s*\{[^}]*\btitle:\s*['"`]/.test(code(f)));
    expect(literal).toEqual([]);
  });

  it('no page repeats the brand the layout template adds', () => {
    expect(code('app/layout.tsx')).toContain("template: '%s · Bubaly'");
    const doubled = pages.filter((f) => /title:[^\n]*[·|]\s*Bubaly['"`]/.test(code(f)) && f !== 'app/layout.tsx');
    expect(doubled).toEqual([]);
  });
});
