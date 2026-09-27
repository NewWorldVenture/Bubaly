import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Page audit B7. Opening /dashboard/sync/accounts/google as a teen never
// settled: the page's "Connect Google" button was a Next <Link> to
// /api/sync/google/auth. <Link> prefetches what is on screen, and that route
// handler mints an OAuth state, sets its cookie, clears the calendar-onboarding
// continuation cookie and redirects to the provider. So viewing the page did
// all of that, and a click went through an RSC fetch that fails cross-origin
// before falling back to a full navigation. The calendar module already links
// the same two starts with a plain <a>. A route handler is not a page; nothing
// may reach one through <Link>.

function files(dir: string, test: RegExp): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => test.test(f) && !f.includes('node_modules'))
    .map((f) => join(dir, f));
}

/** Every route handler's URL path, from app/**\/route.ts. */
const HANDLERS = files('app', /(^|\/)route\.ts$/)
  .map((f) => '/' + f.replace(/\\/g, '/').replace(/^app\//, '').replace(/\/route\.ts$/, '')
    .split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/'))
  .map((p) => p.replace(/\[[^\]]+\]/g, '[^/]+'));

const SURFACE = [...files('app', /\.tsx$/), ...files('components', /\.tsx$/)];

/** `<Link` opening tags with `{…}` balanced. */
function linkTags(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf('<Link'); at !== -1; at = src.indexOf('<Link', at + 1)) {
    if (!/[\s\n]/.test(src[at + 5] ?? '')) continue;
    let depth = 0;
    for (let i = at; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      else if (depth === 0 && src[i] === '>') { out.push(src.slice(at, i + 1)); break; }
    }
  }
  return out;
}

describe('a <Link> never points at a route handler', () => {
  it('finds the handlers and the links it checks', () => {
    expect(HANDLERS.length).toBeGreaterThan(100);
    expect(HANDLERS).toContain('/api/sync/google/auth');
    expect(SURFACE.flatMap((f) => linkTags(readFileSync(f, 'utf8'))).length).toBeGreaterThan(200);
  });

  it('no <Link> has a literal href that is a route handler', () => {
    const matchers = HANDLERS.map((p) => new RegExp(`^${p}(?:[?#/]|$)`));
    const offenders = SURFACE.flatMap((file) => linkTags(readFileSync(file, 'utf8'))
      .map((tag) => /\bhref=(?:\{\s*)?['"`]([^'"`$]+)/.exec(tag)?.[1])
      .filter((href): href is string => !!href && matchers.some((m) => m.test(href)))
      .map((href) => `${file}: <Link href="${href}">`));
    expect(offenders).toEqual([]);
  });

  it('the sync accounts page starts OAuth with a plain <a>', () => {
    const page = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');
    expect(page).toContain("connectHref: '/api/sync/google/auth'");
    expect(page).toMatch(/<a href=\{setup\.connectHref\}/);
    expect(linkTags(page).filter((tag) => tag.includes('connectHref'))).toEqual([]);
  });
});
