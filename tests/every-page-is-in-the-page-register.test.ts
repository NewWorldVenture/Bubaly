import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The page audit register is only useful if it is COMPLETE: a page nobody
// listed is a page nobody audited, and it goes missing without a sound. The
// register is the "Every page" table in finalaudit.md (section "Page Audit —
// every page on www.bubaly.com"). These pin that every app/**/page.tsx has
// exactly one row there, so a page added without a row fails here by name.
// Audit C1-S9-93, re-pointed at the one register in C1-S9-107.
const register = await import('../scripts/page-audit-register.mjs');

const pages: string[] = execSync("git ls-files 'app/**/page.tsx' 'app/page.tsx'", { encoding: 'utf8' })
  .split('\n').filter(Boolean);

describe('every page is in the page audit register', () => {
  const rows = register.registerRows() as string[] | null;

  it('finds the register table in finalaudit.md', () => {
    expect(rows, 'finalaudit.md has lost its "### Every page" table').not.toBeNull();
    expect(rows!.length).toBeGreaterThan(300);
  });

  it('lists every page.tsx', () => {
    expect(pages.length, 'the tree has stopped yielding pages').toBeGreaterThan(300);
    const missing = pages.map(register.routeOf).filter((r: string) => !rows!.includes(r));
    expect(missing, 'add a row to finalaudit.md § Every page').toEqual([]);
  });

  it('lists no route twice', () => {
    expect(rows!.filter((r, i) => rows!.indexOf(r) !== i)).toEqual([]);
  });

  it('puts every page in a lane the crawl tools know, and none in OTHER', () => {
    const other = (register.routes() as { lane: string; file: string }[]).filter((r) => r.lane === 'OTHER').map((r) => r.file);
    expect(other).toEqual([]);
  });

  it('derives routes the way Next serves them', () => {
    expect(register.routeOf('app/(app)/dashboard/meals/[id]/page.tsx')).toBe('/dashboard/meals/[id]');
    expect(register.routeOf('app/(marketing)/page.tsx')).toBe('/');
    expect(register.routeOf('app/page.tsx')).toBe('/');
    expect(register.routeOf('app/s/[slug]/page.tsx')).toBe('/s/[slug]');
  });

  it('the table reader stops at the end of the table', () => {
    const text = '### Every page\n\nintro\n\n| Route | x |\n|---|---|\n| `/a` | 1 |\n| `/b` | 2 |\n\n| `/not-this` | 3 |\n';
    expect(register.registerRows(text)).toEqual(['/a', '/b']);
  });
});
