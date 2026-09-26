import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every child row on /wallet/treasury linked to `/wallet/wallets/<id>`. The id
// was right — `child_wallets.id`, exactly what the detail page looks up — and
// the route was `/wallet/children/[childId]`, which the wallet dashboard links
// to correctly. One wrong path segment made a whole page's primary interaction
// a 404, and nothing caught it: a dead `href` is not a type error, not a lint
// error, and not a failing render.
//
// So resolve them. Collect every internal href in app/ and components/ and
// check it against the real route tree. An href that ends in an interpolation
// (`/wallet/children/${id}`) is checked as a PREFIX — the dynamic part cannot
// be known here, but the static part in front of it must still name something.

const ROOTS = ['app', 'components'];
const CODE = /\.(ts|tsx)$/;

// Paths served by something other than a route file.
const NON_ROUTE_PATHS = new Set([
  '/sitemap.xml',  // app/sitemap.ts
  '/robots.txt',   // app/robots.ts
  '/sw.js',        // public/sw.js, rewritten in next.config.mjs
  '/manifest.webmanifest',
  '/',
]);

// Redirect sources declared in next.config.mjs: a real destination for a user,
// even though no file sits at that path.
const REDIRECTED = ['/dashboard/marketplace'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(entry)) out.push(path);
  }
  return out;
}

/** Route paths the app serves, with route groups `(x)` stripped as Next does. */
function routeTree(): string[][] {
  const routes: string[][] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/^(page|route)\.(ts|tsx)$/.test(entry)) {
        routes.push(
          dir.slice('app'.length).split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')'))),
        );
      }
    }
  };
  visit('app');
  return routes;
}

function segmentMatches(routeSegment: string, hrefSegment: string): boolean {
  return routeSegment.startsWith('[') || routeSegment === hrefSegment;
}

/** Does `segments` name a route? `asPrefix` allows unknown trailing segments. */
function resolves(segments: string[], routes: string[][], asPrefix: boolean): boolean {
  return routes.some((route) => {
    const catchAllAt = route.findIndex((s) => s.startsWith('[...') || s.startsWith('[['));
    if (catchAllAt >= 0) {
      return route.slice(0, catchAllAt).every((s, i) => segmentMatches(s, segments[i] ?? ''));
    }
    if (asPrefix ? route.length < segments.length : route.length !== segments.length) return false;
    return segments.every((s, i) => segmentMatches(route[i], s));
  });
}

type Href = { path: string; dynamic: boolean; where: string };

function internalHrefs(files: string[]): Href[] {
  const found: Href[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/href=\{?["'`](\/[A-Za-z0-9/_.-]*)/g)) {
        const rest = line.slice(match.index + match[0].length);
        found.push({
          path: match[1],
          // `${` immediately after the static part means the tail is a value.
          dynamic: rest.startsWith('${'),
          where: `${file}:${index + 1}`,
        });
      }
    });
  }
  return found;
}

describe('internal links resolve to real routes', () => {
  const routes = routeTree();
  const hrefs = internalHrefs(ROOTS.flatMap((root) => walk(root)));

  it('finds the route tree and the links, so the assertion below means something', () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(hrefs.length).toBeGreaterThan(200);
  });

  it('has no href pointing at a path the app does not serve', () => {
    const dead = hrefs
      .filter(({ path, dynamic }) => {
        if (NON_ROUTE_PATHS.has(path)) return false;
        if (REDIRECTED.some((r) => path === r || path.startsWith(`${r}/`))) return false;
        // A static asset shipped from public/.
        if (existsSync(join('public', path))) return false;
        const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
        if (segments.length === 0) return false;
        return !resolves(segments, routes, dynamic);
      })
      .map(({ path, dynamic, where }) => `${path}${dynamic ? '${…}' : ''} at ${where}`)
      .sort();
    expect(dead).toEqual([]);
  });
});
