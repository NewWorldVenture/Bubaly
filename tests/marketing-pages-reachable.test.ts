// Every marketing page family must be reachable without a session.
//
// The platform publishes eleven families of page, each under its own prefix.
// The middleware kept its own hand-written copy of which of those were public,
// and eight were missing. Measured against production on 2026-09-13 (build
// f9c4d7a1), before the fix:
//
//   /compare/cozi       -> 307 /login      /customers/anything -> 404
//   /alternatives/cozi  -> 307 /login      /blog/anything      -> 404
//   /guides/anything    -> 307 /login
//   /glossary/anything  -> 307 /login
//   /audiences/anything -> 307 /login
//   /questions/anything -> 307 /login
//   /p/anything         -> 307 /login
//
// The 404s are the tell: those prefixes ARE public, so the page ran and
// correctly reported a missing slug. A 307 means the request never reached the
// page at all. Every published comparison, alternative, guide, glossary entry,
// audience page, question and custom page was invisible to anonymous visitors
// and to search engines.
//
// The middleware now derives the list instead of restating it, so this checks
// the derivation holds rather than re-listing the prefixes a third time.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { PAGE_TYPES, MARKETING_PUBLIC_PREFIXES } from '@/lib/marketing/page-types';

describe('every published marketing page family is publicly reachable', () => {
// The public allowlist moved to lib/auth/route-access.ts when middleware
// gained a PROTECTED list (so an unrouted path 404s instead of being sent
// to /login). Both files are read here: the routing LOGIC is still in
// middleware.ts, the allowlist entries are in the other.
  const middleware = readFileSync('middleware.ts', 'utf8') + readFileSync('lib/auth/route-access.ts', 'utf8');

  it('derives the prefixes rather than keeping a second copy', () => {
    expect(middleware, 'a hand-copied list is what went stale').toContain('...MARKETING_PUBLIC_PREFIXES');
    expect(MARKETING_PUBLIC_PREFIXES).toEqual(PAGE_TYPES.map((type) => type.prefix));
  });

  it('covers every page type the platform can publish', () => {
    expect(PAGE_TYPES.length).toBeGreaterThanOrEqual(11);
    for (const type of PAGE_TYPES) {
      expect(MARKETING_PUBLIC_PREFIXES, `${type.value} publishes under ${type.prefix}`)
        .toContain(type.prefix);
    }
  });

  it('has a route that actually serves each prefix', () => {
    // A prefix nobody can render is a worse bug than one nobody can reach.
    const missing = PAGE_TYPES.filter((type) => {
      const dir = `app/(marketing)${type.prefix}`;
      return !existsSync(`${dir}/[slug]/page.tsx`) && !existsSync(`${dir}/page.tsx`);
    });
    expect(missing.map((type) => type.prefix), 'declared prefixes with no page').toEqual([]);
  });

  it('did not open anything beyond those prefixes', () => {
    // The session boundary is the default; this widened it deliberately and by
    // exactly eleven documented paths.
    for (const shouldStayPrivate of ['/dashboard', '/admin', '/display', '/settings']) {
      expect(MARKETING_PUBLIC_PREFIXES).not.toContain(shouldStayPrivate);
    }
  });
});
