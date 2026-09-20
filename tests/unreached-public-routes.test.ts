import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  normalizeSlug,
  normalizeSource,
  normalizeVisitorId,
} from '@/lib/blog/engagement';

// The five routes docs/audit/coverage-census.sh reported as reached by NEITHER a
// test that names them NOR a test that walks their directory:
//
//   /api/blog/like  /api/blog/subscribe  /api/notifications/generate
//   /api/recipes/search  /api/sync/google/sync
//
// "Never exercised" is not the same as "broken", and this file does not pretend
// otherwise. What it pins is the property each route would lose QUIETLY, chosen
// by reading the handler rather than by covering lines: two of these are
// PUBLIC and hold a service-role client, which bypasses RLS entirely, so the
// only thing standing between an anonymous caller and those tables is the code
// in the handler itself.
//
// The shape assertions read the route source. That is deliberate and it is the
// house pattern (tests/cron-auth.test.ts): CI has no Postgres and no Next
// server, so a behavioural test here would need a mock deep enough that it
// asserted the mock. A source assertion cannot prove the route WORKS; it can
// prove a specific guard was not deleted, which is the regression that matters.

const source = (p: string) => readFileSync(p, 'utf8');

const LIKE = 'app/api/blog/like/route.ts';
const SUBSCRIBE = 'app/api/blog/subscribe/route.ts';
const GENERATE = 'app/api/notifications/generate/route.ts';
const RECIPE_SEARCH = 'app/api/recipes/search/route.ts';
const GOOGLE_SYNC = 'app/api/sync/google/sync/route.ts';

describe('the anonymous blog ♥ endpoint bounds what it is handed', () => {
  // These run against the real helpers, not the route, because
  // lib/blog/engagement.ts says it is "Kept DB-free so the rules are
  // unit-testable" and nothing had taken it up on that.
  it('refuses a slug that is not lowercase kebab-case', () => {
    expect(normalizeSlug('a-real-post')).toBe('a-real-post');
    expect(normalizeSlug('  a-real-post  ')).toBe('a-real-post');
    // The ones that matter: a slug reaching .eq('slug', …) unbounded.
    expect(normalizeSlug('../../etc/passwd')).toBeNull();
    expect(normalizeSlug("a' or 1=1--")).toBeNull();
    expect(normalizeSlug('Has-Capitals')).toBeNull();
    expect(normalizeSlug('trailing-')).toBeNull();
    expect(normalizeSlug('a'.repeat(121))).toBeNull();
    expect(normalizeSlug('ab')).toBeNull();
    expect(normalizeSlug(null)).toBeNull();
    expect(normalizeSlug(12345)).toBeNull();
  });

  it('refuses a visitor id that is not a bounded opaque token', () => {
    expect(normalizeVisitorId('abcd1234')).toBe('abcd1234');
    expect(normalizeVisitorId('v.1:2-3_x')).toBe('v.1:2-3_x');
    expect(normalizeVisitorId('short')).toBeNull();        // < 8
    expect(normalizeVisitorId('a'.repeat(101))).toBeNull(); // > 100
    expect(normalizeVisitorId('has space')).toBeNull();
    expect(normalizeVisitorId('has/slash')).toBeNull();
    expect(normalizeVisitorId(undefined)).toBeNull();
  });

  it('only ever counts ♥ on a PUBLISHED post', () => {
    // The route holds a service-role client, so RLS is not the thing keeping a
    // draft post's existence private — this filter is. Drop it and GET /like
    // turns into an oracle for unreleased article slugs.
    expect(source(LIKE)).toMatch(/\.eq\('published',\s*true\)/);
  });

  it('keeps the anonymous write rate limited and the body bounded', () => {
    const s = source(LIKE);
    expect(s).toMatch(/enforceRequestRateLimit\(/);
    expect(s).toMatch(/readBoundedRequestJson\(req,\s*MAX_BODY_BYTES\)/);
    // One ♥ per (post, visitor) is a DB unique constraint, and the handler
    // treats 23505 as "already liked → unlike" rather than as an error. If that
    // branch goes, a repeat POST 500s instead of toggling.
    expect(s).toMatch(/23505/);
  });
});

describe('the anonymous subscribe endpoint bounds what it is handed', () => {
  it('refuses anything that is not plausibly an email', () => {
    expect(normalizeEmail('  Reader@Example.COM ')).toBe('reader@example.com');
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('two@@at.com')).toBeNull();
    expect(normalizeEmail('dots..dots@example.com')).toBeNull();
    expect(normalizeEmail('has space@example.com')).toBeNull();
    expect(normalizeEmail('a@b.c')).toBeNull();           // tld too short + under length floor
    expect(normalizeEmail(`${'a'.repeat(250)}@x.com`)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it('pins the source column to a known set instead of storing what it is sent', () => {
    expect(normalizeSource('blog-footer')).toBe('blog-footer');
    expect(normalizeSource('article')).toBe('article');
    // Anything else falls back rather than writing a caller-chosen string.
    expect(normalizeSource('<script>')).toBe('blog');
    expect(normalizeSource('')).toBe('blog');
    expect(normalizeSource(undefined)).toBe('blog');
  });

  it('keeps the honeypot answering success so a bot learns nothing', () => {
    const s = source(SUBSCRIBE);
    expect(s).toMatch(/body\.website/);
    // The point of a honeypot is that the refusal is INDISTINGUISHABLE from
    // success. If this ever becomes a 400, the field stops being a honeypot and
    // becomes a field bots simply stop filling.
    expect(s).toMatch(/website[\s\S]{0,200}?NextResponse\.json\(\{\s*ok:\s*true\s*\}\)/);
  });

  it('keeps the anonymous write rate limited and the body bounded', () => {
    const s = source(SUBSCRIBE);
    expect(s).toMatch(/enforceRequestRateLimit\(/);
    expect(s).toMatch(/readBoundedRequestJson\(req,\s*MAX_BODY_BYTES\)/);
  });
});

describe('the three authenticated routes fail closed', () => {
  // Each of these holds a service-role client or dispatches push. The thing
  // that keeps them from being open endpoints is one call, and that call is
  // what is pinned here.
  it('/api/notifications/generate requires a user before it dispatches anything', () => {
    const s = source(GENERATE);
    expect(s).toMatch(/requireUserContext\(\)/);
    // The dispatch uses the SERVICE client, so the auth call above is the whole
    // boundary — there is no RLS behind it to catch a mistake.
    expect(s).toMatch(/createServiceClient\(\)/);
    expect(s).toMatch(/enforceRequestRateLimit|notifications:generate/);
  });

  it('/api/recipes/search answers 401 rather than throwing when unauthenticated', () => {
    const s = source(RECIPE_SEARCH);
    // It deliberately catches requireUserContext and converts it to a 401; the
    // catch is load-bearing, because an uncaught throw here is a 500 that leaks
    // a stack rather than a clean refusal.
    expect(s).toMatch(/catch\s*\{\s*return NextResponse\.json\([\s\S]{0,120}?status:\s*401/);
    expect(s).toMatch(/enforceRequestRateLimit\(/);
  });

  it('/api/sync/google/sync scopes its work to the caller, not to a supplied id', () => {
    const s = source(GOOGLE_SYNC);
    expect(s).toMatch(/requireUserContext\(\)/);
    // The row it acts on is selected by the SESSION's user id. If this ever
    // reads an id from the request body instead, one signed-in user could drive
    // another's Google sync — and the service client would let them.
    expect(s).toMatch(/\.eq\('user_id',\s*ctx\.user\.id\)/);
    expect(s).toMatch(/enforceRequestRateLimit\(/);
  });
});

describe('what this file does NOT claim', () => {
  it('records that two of these routes are public and hold a service-role client', () => {
    // Not an assertion about a bug — an assertion that the fact stays visible.
    // createServiceClient bypasses RLS, so for these two the handler IS the
    // access-control layer. A future edit that adds a table write here has no
    // database-side net under it.
    for (const p of [LIKE, SUBSCRIBE]) {
      const s = source(p);
      expect(s).toMatch(/createServiceClient/);
      expect(s).not.toMatch(/requireUserContext/);
    }
  });
});
