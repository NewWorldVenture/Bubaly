import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, parseContentSecurityPolicy } from '@/lib/security/csp.mjs';

describe('Content-Security-Policy composition', () => {
  const prod = parseContentSecurityPolicy(buildContentSecurityPolicy({ supabaseUrl: 'https://abc.supabase.co', isProduction: true }));

  it('locks down the high-value directives', () => {
    expect(prod['object-src']).toEqual(["'none'"]);
    expect(prod['base-uri']).toEqual(["'self'"]);
    expect(prod['frame-ancestors']).toEqual(["'none'"]);
    expect(prod['default-src']).toEqual(["'self'"]);
    expect(prod['manifest-src']).toEqual(["'self'"]);
  });

  it('allows the Supabase project (REST + Realtime) and Stripe, nothing else, for fetches', () => {
    expect(prod['connect-src']).toContain('https://abc.supabase.co');
    expect(prod['connect-src']).toContain('wss://abc.supabase.co');
    expect(prod['connect-src']).toContain('https://*.supabase.co');
    expect(prod['connect-src']).toContain('https://api.stripe.com');
    expect(prod['connect-src']).toContain('https://api.open-meteo.com');
    expect(prod['connect-src']).toContain('https://router.project-osrm.org');
    expect(prod['connect-src']).not.toContain('http://localhost:*');
    expect(prod['connect-src']).not.toContain('*');
  });

  it('permits only the third-party scripts and frames the codebase uses', () => {
    expect(prod['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://js.stripe.com']);
    expect(prod['script-src']).not.toContain("'unsafe-eval'");
    expect(prod['frame-src']).toContain('https://js.stripe.com');
    expect(prod['frame-src']).toContain('https://www.youtube-nocookie.com');
    expect(prod['frame-src']).toContain('https://player.vimeo.com');
    expect(prod['worker-src']).toEqual(["'self'", 'blob:']);
  });

  it('omits form-action so server-action redirects into Stripe/OAuth keep working', () => {
    expect(prod['form-action']).toBeUndefined();
  });

  it('adds eval + local sockets only outside production (Next.js dev/HMR)', () => {
    const dev = parseContentSecurityPolicy(buildContentSecurityPolicy({ supabaseUrl: 'http://127.0.0.1:54321', isProduction: false }));
    expect(dev['script-src']).toContain("'unsafe-eval'");
    expect(dev['connect-src']).toContain('ws://localhost:*');
    expect(dev['connect-src']).toContain('http://127.0.0.1:54321');
    expect(dev['connect-src']).toContain('ws://127.0.0.1:54321');
  });

  it('mirrors X-Frame-Options per route and survives a missing/invalid Supabase URL', () => {
    const blog = parseContentSecurityPolicy(buildContentSecurityPolicy({ supabaseUrl: undefined, frameAncestors: "'self'" }));
    expect(blog['frame-ancestors']).toEqual(["'self'"]);
    expect(blog['connect-src']).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'https://api.stripe.com', 'https://r.stripe.com', 'https://m.stripe.network', 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com', 'https://api.bigdatacloud.net', 'https://router.project-osrm.org']);
    const bad = buildContentSecurityPolicy({ supabaseUrl: 'not a url' });
    expect(bad).not.toContain('null');
  });

  it('emits a well-formed header (no double spaces, every directive named)', () => {
    const value = buildContentSecurityPolicy({ supabaseUrl: 'https://abc.supabase.co' });
    expect(value).not.toMatch(/\s{2,}/);
    expect(value.split('; ').every((d) => /^[a-z-]+ \S/.test(d))).toBe(true);
  });
});
