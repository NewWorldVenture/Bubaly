import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

// app/auth/callback and app/auth/signout set `Referrer-Policy: no-referrer` on
// their own responses (tests/auth-callback-admission and signout-bridge pin
// that), but a production build served `strict-origin-when-cross-origin` for
// both: next.config's rule for every path replaced the route's header. Next
// applies header rules in order and, for the same key, the last match wins.
// So what is served is decided here, and this holds it.

type Rule = { source: string; headers: { key: string; value: string }[] };

/** Enough of Next's source syntax for the rules in next.config.mjs. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .replace(/:[a-zA-Z]+\(([^)]+)\)/g, '($1)')
    .replace(/:[a-zA-Z]+\*/g, '.*')
    .replace(/:[a-zA-Z]+/g, '[^/]+');
  return new RegExp(`^${pattern}$`).test(path);
}

function served(rules: Rule[], path: string, key: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!matches(rule.source, path)) continue;
    const header = rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
    if (header) value = header.value;
  }
  return value;
}

describe('the auth routes are served the referrer policy they ask for', () => {
  it('the OAuth callback and the sign-out post are no-referrer', async () => {
    const rules = (await nextConfig.headers!()) as Rule[];
    expect(served(rules, '/auth/callback', 'Referrer-Policy')).toBe('no-referrer');
    expect(served(rules, '/auth/signout', 'Referrer-Policy')).toBe('no-referrer');
  });

  it('every other page keeps the global policy', async () => {
    const rules = (await nextConfig.headers!()) as Rule[];
    for (const path of ['/', '/login', '/dashboard', '/auth/complete', '/auth/signout/complete', '/blog/some-post']) {
      expect(served(rules, path, 'Referrer-Policy'), path).toBe('strict-origin-when-cross-origin');
    }
  });
});
