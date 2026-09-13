import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-023: the service worker must NEVER write authenticated HTML into Cache
// Storage. Cached pages persist unencrypted after logout and are served offline
// to whoever next opens the app on a shared/family device. The previous worker
// cached EVERY successful navigation (including /dashboard, /wallet, /admin)
// and precached /dashboard at install. Only the public app shell ('/', '/offline')
// may be cached for navigations; /api + /auth stay fully uncached.
const sw = readFileSync('public/sw.js', 'utf8');

describe('service worker never caches authenticated pages (M-023)', () => {
  it('precaches only the public app shell (no /dashboard or other authed routes)', () => {
    const shell = sw.match(/const APP_SHELL = (\[[^\]]*\])/)?.[1] ?? '';
    expect(shell).toContain("'/'");
    expect(shell).toContain("'/offline'");
    expect(shell).not.toContain('/dashboard');
    expect(shell).not.toContain('/wallet');
    expect(shell).not.toContain('/admin');
  });

  it('gates navigation caching to the public-shell allowlist', () => {
    expect(sw).toContain('const CACHEABLE_NAV = new Set(APP_SHELL);');
    expect(sw).toContain('if (CACHEABLE_NAV.has(url.pathname)) {');
    // The put must sit INSIDE the allowlist gate (no unconditional navigation put).
    const navBlock = sw.slice(sw.indexOf("request.mode === 'navigate'"), sw.indexOf('caches.match(request)'));
    const putIdx = navBlock.indexOf('c.put(request');
    const gateIdx = navBlock.indexOf('CACHEABLE_NAV.has(url.pathname)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(putIdx).toBeGreaterThan(gateIdx);
  });

  it('purges the previous contaminated cache via a version bump + cleanup', () => {
    expect(sw).not.toContain("'bubaly-v3'");
    expect(sw).toMatch(/const CACHE = 'bubaly-v\d+'/);
    // The sweep is now allowlist-based rather than "everything but CACHE". The
    // M-023 guarantee is unchanged — an old app-shell cache still has no entry
    // in KEEP, so a version bump still purges the HTML it held.
    expect(sw).toContain('keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))');
    expect(sw).toMatch(/const KEEP = new Set\(\[CACHE, LIBRARY_CACHE\]\)/);
  });

  it('spares the downloads a family made, and nothing else', () => {
    // The sweep deleted 'bubaly-library-v1' along with everything it did not
    // recognise, so the first deploy that changed this file threw away every
    // episode anyone had saved for a flight. Two things are asserted: the
    // library cache survives, and the allowlist has exactly these two entries
    // so a third cannot be added without this test being read.
    expect(sw).toContain("const LIBRARY_CACHE = 'bubaly-library-v1'");
    const keep = /const KEEP = new Set\(\[([^\]]*)\]\)/.exec(sw);
    expect(keep).not.toBeNull();
    expect((keep as RegExpExecArray)[1].split(',').map((entry) => entry.trim())).toEqual(['CACHE', 'LIBRARY_CACHE']);
  });

  it('still never touches API or auth requests', () => {
    expect(sw).toContain("url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')");
  });

  it('keeps the offline navigation fallback', () => {
    expect(sw).toContain("caches.match('/offline')");
  });
});
