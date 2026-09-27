import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIBRARY_CACHE } from '@/lib/library/progress';

// Execute the worker's pure admission rules. Browser coverage separately
// exercises its fetch/activate handlers, real CacheStorage and explicit logout.
const sw = readFileSync('public/sw.js', 'utf8');
const policy = new Function('self', sw + '\nreturn { cache: CACHE, keep: [...KEEP], shell: APP_SHELL, images: [...PUBLIC_IMAGES], publicShell, publicResource, safeResponse, libraryItem: LIBRARY_ITEM };')({ addEventListener() {} }) as {
  cache: string; keep: string[]; shell: string[]; images: string[];
  publicShell: (url: URL, request: Request) => boolean;
  publicResource: (request: { destination: string }, url: URL) => string | null;
  safeResponse: (response: Response, request: Request, kind: string, publicInstall?: boolean) => boolean;
  libraryItem: RegExp;
};
const origin = 'https://worker-policy.invalid';
const classify = (path: string, destination = 'image') => policy.publicResource({ destination }, new URL(path, origin));

describe('service worker cache admission (M-023)', () => {
  it('retires the contaminated cache and preserves only the new shell and explicit publisher downloads', () => {
    expect(policy.cache).toBe('bubaly-v5');
    expect(policy.keep).toEqual([policy.cache, LIBRARY_CACHE]);
    expect(sw).toContain('keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))');
  });

  it('allows only query-free public shell documents', () => {
    expect(policy.shell).toEqual(['/', '/offline']);
    for (const path of policy.shell) expect(policy.publicShell(new URL(path, origin), new Request(origin + path))).toBe(true);
    for (const path of ['/home', '/dashboard', '/wallet', '/admin', '/?code=synthetic', '/offline?_rsc=synthetic', '/#synthetic']) {
      expect(policy.publicShell(new URL(path, origin), new Request(origin + path)), path).toBe(false);
    }
    for (const name of ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-action']) {
      expect(policy.publicShell(new URL(origin), new Request(origin, { headers: { [name]: 'synthetic' } })), name).toBe(false);
    }
  });

  it('has an exact allowlist matching the checked-in public PNG assets', () => {
    function images(directory: string, prefix = ''): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const href = prefix + '/' + entry.name;
        return entry.isDirectory() ? images(join(directory, entry.name), href) : entry.name.endsWith('.png') ? [href] : [];
      });
    }
    expect([...policy.images].sort()).toEqual(images('public').sort());
    expect(new Set(policy.images).size).toBe(policy.images.length);
    for (const path of policy.images) expect(classify(path), path).toBe('image');
  });

  it('does not infer public images from their destination, directory or extension', () => {
    for (const path of ['/private/photo.png', '/icons/private.png', '/brand/bubaly-logo.png?owner=a',
      '/api/family-media?path=synthetic', '/images/family-ai-lifestyle.png/private', '/brand/%62ubaly-logo.png']) {
      expect(classify(path), path).toBeNull();
    }
  });

  it('keeps optimized public logos while rejecting private or ambiguous optimizer requests', () => {
    expect(classify('/_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=384&q=75')).toBe('image');
    expect(classify('/_next/image?q=100&w=1920&url=%2Fimages%2Ffamily-ai-lifestyle.png')).toBe('image');
    for (const query of [
      'url=https%3A%2Fproject.supabase.co%2Fprivate.png&w=384&q=75',
      'url=%2Fapi%2Ffamily-media&w=384&q=75', 'url=%2Fbrand%2Fbubaly-logo.png&w=384&q=75&owner=a',
      'url=%2Fbrand%2Fbubaly-logo.png&url=%2Fprivate.png&w=384&q=75',
      'url=%2Fbrand%2Fbubaly-logo.png&w=384&w=640&q=75',
      'url=%2Fbrand%2Fbubaly-logo.png&w=0384&q=75', 'url=%2Fbrand%2Fbubaly-logo.png&w=385&q=75',
      'url=%2Fbrand%2Fbubaly-logo.png&w=384&q=0', 'url=%2Fbrand%2Fbubaly-logo.png&w=384&q=101',
      'url=%252Fbrand%252Fbubaly-logo.png&w=384&q=75', 'url=%2Fbrand%2Fbubaly-logo.png&w=384',
    ]) expect(classify('/_next/image?' + query), query).toBeNull();
  });

  it('admits only canonical build scripts and styles, including deployment queries', () => {
    expect(classify('/_next/static/chunks/app/%28app%29/home/page-ab12.js?dpl=dpl_test123', 'script')).toBe('script');
    expect(classify('/_next/static/css/ab12.css', 'style')).toBe('style');
    for (const path of ['/private.js', '/_next/static/file.css', '/_next/static/%2fprivate.js',
      '/_next/static/%252fprivate.js', '/_next/static/%2e%2e/private.js',
      '/_next/static/chunk.js?owner=a', '/_next/static/chunk.js?dpl=dpl_a&dpl=dpl_b']) {
      expect(classify(path, 'script'), path).toBeNull();
    }
    expect(classify('/_next/static/chunk.js', 'image')).toBeNull();
  });

  it('refuses private, no-store, redirected, error and wrong-content public resource responses', () => {
    const request = new Request(origin + '/brand/bubaly-logo.png');
    const response = (headers: HeadersInit, status = 200) => new Response('synthetic', { headers, status });
    expect(policy.safeResponse(response({ 'content-type': 'image/png', 'cache-control': 'public, max-age=600' }), request, 'image')).toBe(true);
    for (const control of ['private', 'public, no-store', 'private="Set-Cookie", max-age=0']) {
      expect(policy.safeResponse(response({ 'content-type': 'image/png', 'cache-control': control }), request, 'image')).toBe(false);
    }
    expect(policy.safeResponse(response({ 'content-type': 'text/html' }), request, 'image')).toBe(false);
    expect(policy.safeResponse(response({ 'content-type': 'image/png' }, 404), request, 'image')).toBe(false);
    const redirected = response({ 'content-type': 'image/png' });
    Object.defineProperty(redirected, 'redirected', { value: true });
    expect(policy.safeResponse(redirected, request, 'image')).toBe(false);
    const wrongUrl = response({ 'content-type': 'image/png' });
    Object.defineProperty(wrongUrl, 'url', { value: origin + '/private.png' });
    expect(policy.safeResponse(wrongUrl, request, 'image')).toBe(false);
  });

  it('recognizes exact library item paths and media bodies, without admitting arbitrary library content', () => {
    const path = '/library/media/00000000-0000-4000-8000-000000000001';
    expect(policy.libraryItem.test(path)).toBe(true);
    for (const other of [path + '/private.png', '/library/media/private.png', '/library/media/not-an-id', path + '?owner=a']) {
      expect(policy.libraryItem.test(other), other).toBe(false);
    }
    const request = new Request(origin + path);
    for (const type of ['audio/mpeg', 'video/mp4', 'application/octet-stream']) {
      expect(policy.safeResponse(new Response('publisher', { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } }), request, 'library')).toBe(true);
    }
    expect(policy.safeResponse(new Response('private page', { headers: { 'content-type': 'text/html' } }), request, 'library')).toBe(false);
  });

  it('never falls back to global CacheStorage reads or automatically caches publisher downloads', () => {
    expect(sw).not.toMatch(/\bcaches\.match\(/);
    expect(sw).toContain("cachedResponse(LIBRARY_CACHE, request, 'library')");
    expect(sw).not.toMatch(/caches\.open\(LIBRARY_CACHE\).*\.put/s);
    expect(sw).toContain("url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')");
    expect(sw).toContain("new Request(new URL('/offline', self.location.origin))");
  });

  it('installs only generic public HTML without cookies or followed redirects', () => {
    expect(sw).toContain("credentials: 'omit', redirect: 'error'");
    const request = new Request(origin + '/offline');
    const generic = new Response('public shell', { headers: { 'content-type': 'text/html', 'cache-control': 'private, no-store' } });
    expect(policy.safeResponse(generic, request, 'shell')).toBe(false);
    expect(policy.safeResponse(generic, request, 'shell', true)).toBe(true);
  });
});
