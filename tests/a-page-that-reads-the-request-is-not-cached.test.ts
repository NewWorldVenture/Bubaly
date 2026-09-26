import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// MAIN-F-005. /blog/[slug] declared `revalidate` and read the locale cookie.
// Next prerendered it, then saw the cookie on a later request and threw "Page
// changed from static to dynamic at runtime … reason: cookies", so every post
// not baked in at build time, and every unknown slug a crawler tried, was a
// 500. `force-dynamic` fixed the three pages; nothing stopped the combination
// from coming back on those or any other page.

const routeFiles = execSync("git ls-files 'app/**/page.tsx' 'app/**/layout.tsx' 'app/**/page.ts'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const READS_REQUEST = /\b(getTranslations|getLocaleContext)\(|\bcookies\(\)|\bheaders\(\)/;

describe('a page that reads the request is not cached per URL', () => {
  it('finds route files at all (guards the guard)', () => {
    expect(routeFiles.length).toBeGreaterThan(300);
    expect(routeFiles.filter((f) => READS_REQUEST.test(code(f))).length).toBeGreaterThan(50);
  });

  it('no page or layout both declares `revalidate` and reads cookies, headers or the locale', () => {
    const both = routeFiles.filter((f) => {
      const src = code(f);
      return /^export const revalidate\b/m.test(src) && READS_REQUEST.test(src);
    });
    expect(both, 'these prerender and then throw on the first request that carries a cookie').toEqual([]);
  });

  it.each(['app/(marketing)/blog/[slug]/page.tsx', 'app/(marketing)/blog/page.tsx', 'app/(marketing)/faq/page.tsx'])(
    '%s renders per request',
    (f) => {
      const src = code(f);
      expect(src).toMatch(/^export const dynamic = 'force-dynamic';$/m);
      expect(src).not.toMatch(/^export const revalidate\b/m);
    },
  );

  it('an unknown slug is a 404, not a 500', () => {
    expect(code('app/(marketing)/blog/[slug]/page.tsx')).toMatch(/if \(!post\) notFound\(\);/);
  });
});
