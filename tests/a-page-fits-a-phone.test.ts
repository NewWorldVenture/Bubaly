import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Audit C1-S9-99 — the page audit crawl, signed in at 390px, found 17 routes
// that scrolled sideways (8px on /dashboard/sports up to 647px on
// /admin/support-tickets). Measured again after the fix with the crawl's own
// probe: 0px on all 17. That is a browser measurement and lives in
// scripts/page-audit-crawl.mjs; what can be pinned here is each cause, so the
// same line cannot come back unnoticed.
//
// Four causes, one per section below.

const read = (f: string) => readFileSync(f, 'utf8');

describe('1. a grid with no mobile column count sizes its column to its widest content', () => {
  // `grid gap-6 lg:grid-cols-[1fr_300px]` has NO template below lg, so its one
  // column is an implicit `auto` track — and an auto track is at least as wide
  // as its content's min-content. A table or a row of filters then sets the
  // column, and the page, wider than the phone. `grid-cols-1` is
  // `minmax(0,1fr)`: the column is the container's width and the content
  // scrolls or wraps inside it. (`1fr` alone is `minmax(auto,1fr)` and has the
  // same floor, hence `minmax(0,1fr)` in the lg templates too.)
  const FIXED: [string, string][] = [
    ['app/(app)/admin/admins/page.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'],
    ['app/(app)/admin/content/page.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'],
    ['app/(app)/admin/marketing/content/page.tsx', 'grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'],
    ['app/(app)/admin/support-tickets/page.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]'],
    ['app/(app)/admin/users/page.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]'],
    ['app/(app)/admin/settings/page.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
    ['app/(app)/dashboard/social/settings/page.tsx', 'grid grid-cols-1 gap-4 lg:grid-cols-2'],
    ['components/marketplace/community-module.tsx', 'mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2'],
    ['components/modules/outcomes-launcher.tsx', 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]'],
  ];
  it.each(FIXED)('%s caps its column at the container', (file, cls) => {
    expect(read(file)).toContain(`className="${cls}"`);
  });

  it('adds no new grid that is responsive above a phone and implicit on one (ratchet)', () => {
    // 330 remain. Most never overflow because nothing in them is wide; each one
    // is a page that does the moment a long name or a table lands in it. The
    // count may only fall. The crawl measures the rest.
    const CEILING = 330;
    const files = execFileSync('git', ['ls-files', 'app/**/*.tsx', 'components/**/*.tsx'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    let count = 0;
    for (const f of files) {
      for (const m of read(f).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\('([^']*)')/g)) {
        const tokens = (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/);
        if (!tokens.includes('grid')) continue;
        const responsive = tokens.some((t) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(t));
        const base = tokens.some((t) => /^grid-cols-/.test(t));
        if (responsive && !base) count++;
      }
    }
    expect(count, 'give the new grid a base column count: grid-cols-1 (minmax(0,1fr)) below its breakpoint').toBeLessThanOrEqual(CEILING);
    expect(count, 'the scan stopped finding grids; it is no longer measuring anything').toBeGreaterThan(100);
  });
});

describe('2. a row of controls handed to PageHeader wraps', () => {
  it('wraps the action row a module passes, whatever its own classes say', () => {
    // 31 modules pass `action={<div className="flex items-center gap-2">…`.
    // The header's own wrapper wrapped; the row inside it did not, and Recipes
    // ran 292px past the edge. `[&>div]:flex-wrap` wraps that row.
    const src = read('components/app/page-header.tsx');
    expect(src).toMatch(/className="[^"]*\bflex-wrap\b[^"]*\[&>div\]:flex-wrap[^"]*">\{action\}/);
  });
});

describe('3. a stat tile that stacks its icon over its numbers is a column', () => {
  it('declares flex-col wherever an icon block with a bottom margin opens a .stat-card', () => {
    // `.stat-card` is a flex ROW (app/globals.css). Sports and School put an
    // icon (mb-3, meant to sit above), the value, the label and a sub-label in
    // one — four blocks side by side, the last past the edge.
    const files = execFileSync('git', ['ls-files', 'app/**/*.tsx', 'components/**/*.tsx'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    let stacked = 0;
    for (const f of files) {
      for (const m of read(f).matchAll(/className="(stat-card[^"]*)">\s*<div className=\{cn\('mb-\d/g)) {
        stacked++;
        if (!/\bflex-col\b/.test(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(stacked, 'the scan no longer sees the stacked tiles it was written for').toBeGreaterThanOrEqual(2);
  });
});

describe('4. text that must wrap is a block, not loose flex items', () => {
  it('keeps the feedback admin GitHub notice one wrapping sentence', () => {
    // Loose in a flex <p>, each run of text and each <code> was its own flex
    // item and the notice ran 58px past the edge.
    const src = read('components/admin/feedback-admin.tsx');
    expect(src).toMatch(/<span className="min-w-0 break-words">\s*\{t\('feedbackAdmin\.githubTrackerIsDarkSet'\)\}/);
  });

  it('truncates a blog title as a block — truncate does nothing to an inline link', () => {
    expect(read('app/(app)/admin/marketing/content/page.tsx')).toContain('className="block truncate font-medium hover:underline"');
  });
});
