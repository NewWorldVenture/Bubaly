import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The page audit register (docs/audit/pages/*.md, rolled up into finalaudit.md)
// is only useful if it is COMPLETE: a page nobody listed is a page nobody
// audited, and it would be missing silently. These pin that every page.tsx is
// in exactly one lane, that no lane lists a page that is gone, that every
// status is one the protocol defines, and that the finalaudit.md roll-up is the
// one the lane files produce — so a new page, a deleted page or a hand edit of
// the generated table fails here by name. Audit C1-S9-93.
//
// A plain .mjs script, imported for its pure helpers.
const register = await import('../scripts/page-audit-register.mjs');

const pages: string[] = execSync("git ls-files 'app/**/page.tsx' 'app/page.tsx'", { encoding: 'utf8' })
  .split('\n').filter(Boolean);

describe('every page is in the page audit register', () => {
  const { lanes } = register.build() as { lanes: { lane: { id: string }; rows: { file: string; status: string }[]; text: string; existing: string }[] };
  const listed = lanes.flatMap((l) => l.rows.map((r) => r.file));

  it('lists every page.tsx exactly once', () => {
    expect(pages.length, 'the tree has stopped yielding pages').toBeGreaterThan(300);
    const missing = pages.filter((p) => !listed.includes(p));
    const twice = listed.filter((p, i) => listed.indexOf(p) !== i);
    expect(missing, 'pages no lane lists — run node scripts/page-audit-register.mjs --write').toEqual([]);
    expect(twice).toEqual([]);
  });

  it('keeps each lane file current with the tree', () => {
    const stale = lanes.filter((l) => l.text !== l.existing).map((l) => l.lane.id);
    expect(stale, 'run node scripts/page-audit-register.mjs --write').toEqual([]);
  });

  it('uses only the statuses the protocol defines', () => {
    const bad = lanes.flatMap((l) => l.rows.filter((r) => !register.STATUSES.includes(r.status)).map((r) => `${l.lane.id} ${r.file}: ${r.status}`));
    expect(bad).toEqual([]);
  });

  it('leaves the OTHER lane empty, so every page has an owner', () => {
    const other = lanes.find((l) => l.lane.id === 'OTHER');
    expect(other?.rows.map((r) => r.file) ?? []).toEqual([]);
  });

  it('carries the roll-up the lane files produce in finalaudit.md', () => {
    const final = readFileSync('finalaudit.md', 'utf8');
    const start = final.indexOf('<!-- page-register:start');
    const end = final.indexOf('<!-- page-register:end -->');
    expect(start, 'finalaudit.md has lost its page-register markers').toBeGreaterThan(-1);
    expect(final.slice(start, end + '<!-- page-register:end -->'.length)).toBe(register.rollup(lanes));
  });

  it('derives routes the way Next serves them', () => {
    expect(register.routeOf('app/(app)/dashboard/meals/[id]/page.tsx')).toBe('/dashboard/meals/[id]');
    expect(register.routeOf('app/(marketing)/page.tsx')).toBe('/');
    expect(register.routeOf('app/page.tsx')).toBe('/');
    expect(register.routeOf('app/s/[slug]/page.tsx')).toBe('/s/[slug]');
  });
});
