// A rate limit that each lambda keeps to itself is not a rate limit.
//
// `lib/server/rate-limit.ts` is a module-scope Map, and says so in its own
// header: "Good for a single instance / dev; swap for Upstash Redis in
// multi-instance prod." On a serverless deployment every cold instance starts
// with an empty map and concurrent instances share nothing, so "30 per minute"
// is 30 per minute PER INSTANCE — and the number of instances is the caller's to
// raise, by sending in parallel.
//
// `/api/assistant` went further and wrote the claim down: "Rate limited by IP
// BEFORE the token lookup, so an attacker cannot use this endpoint to test
// guessed tokens at speed." That was wrong twice — the mechanism could not
// provide it, and it is not the property that matters here, since a link token
// is 32 CSPRNG bytes stored as a SHA-256 and the keyspace is the defence. What
// the limit is for is cost.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const routes = () =>
  execSync("git ls-files 'app/api/**/route.ts'", { encoding: 'utf8' }).split('\n').filter(Boolean);

const DURABLE = /rateLimitDb\(|enforceRequestRateLimit\(|enforceAIRateLimit\(/;
const isFnLike = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

/** Every in-memory `rateLimit()` gate with no durable check in the same handler. */
function perInstanceOnly(): string[] {
  const hits: string[] = [];
  for (const file of routes()) {
    const source = readFileSync(file, 'utf8');
    if (!/\brateLimit\(/.test(source)) continue;
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'rateLimit') {
        // The durable half has to be on THIS path, not merely somewhere in the
        // file — a route with two handlers can protect one and not the other.
        let fn: ts.Node | undefined = n.parent;
        while (fn && !isFnLike(fn)) fn = fn.parent;
        if (!fn || !DURABLE.test(fn.getText())) {
          hits.push(`${file}:${source.slice(0, n.getStart()).split('\n').length}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(src, visit);
  }
  return hits.sort();
}

// One route is exempt, and the exemption is argued rather than assumed.
// `blog/search-index` answers with `s-maxage=300` and takes no query string, so
// a scripted hammer is served by the CDN and the origin sees roughly one request
// per five minutes per edge location: the cache is the bound, and the map is
// belt-and-braces behind it. Converting it would put a SERVICE-ROLE client and a
// database write on an unauthenticated marketing path, to protect a read that is
// already cached — a worse trade than the one it fixes.
const CACHE_BOUNDED = ['app/api/blog/search-index/route.ts'];

describe('no route gates on a per-instance limit', () => {
  it('every in-memory rate limit has a durable one on the same path', () => {
    const found = perInstanceOnly().filter((h) => !CACHE_BOUNDED.includes(h.split(':')[0]));
    expect(found, 'this gate is per-lambda, so it is not a gate').toEqual([]);
  });

  it('the exempt route still earns its exemption', () => {
    // If the caching goes, so does the argument.
    const source = readFileSync('app/api/blog/search-index/route.ts', 'utf8');
    expect(source).toMatch(/s-maxage=\d{3,}/);
    expect(source).not.toMatch(/searchParams/);
  });

  it('the scan is not blind', () => {
    // Planted in the shape the defect took: a handler whose only gate is the
    // module-scope Map. Repair the scan, not this case, if it goes red.
    const planted = `
      import { rateLimit, clientIp } from '@/lib/server/rate-limit';
      export async function POST(req: NextRequest) {
        const limited = rateLimit(\`x:\${clientIp(req.headers)}\`, { limit: 30 });
        if (!limited.ok) return new NextResponse('429', { status: 429 });
        return NextResponse.json({ ok: true });
      }`;
    const src = ts.createSourceFile('planted.ts', planted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = 0;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'rateLimit') {
        let fn: ts.Node | undefined = n.parent;
        while (fn && !isFnLike(fn)) fn = fn.parent;
        if (fn && !DURABLE.test(fn.getText())) found++;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(src, visit);
    expect(found).toBe(1);

    // And the scan still reaches the routes that do it correctly, so "zero
    // findings" is not "zero files read" — asserted BY NAME, never by a count.
    // A count here falls as the work succeeds: the first version of this line
    // wanted ten files holding a bare `rateLimit(`, and converting seven of them
    // to the durable helper took it to four. Finishing the job would have looked
    // identical to the scanner breaking. These four hand-inline the correct
    // pattern — a cheap local check, then `rateLimitDb` — and are not going away.
    const seen = routes().filter((f) => /\brateLimit\(/.test(readFileSync(f, 'utf8')));
    for (const route of [
      'app/api/ai/chat/route.ts',
      'app/api/ai/gift/route.ts',
      'app/api/ai/route.ts',
      'app/api/sync/feeds/[token]/route.ts',
    ]) expect(seen, route).toContain(route);
  });

  it('the assistant route no longer claims the limiter stops token guessing', () => {
    const source = readFileSync('app/api/assistant/route.ts', 'utf8');
    expect(source).not.toContain('cannot use this\n  // endpoint to test guessed tokens at speed');
    // What it says instead has to name the real reason, or the comment has just
    // become vaguer rather than truer.
    expect(source).toMatch(/COST|cost/);
  });
});
