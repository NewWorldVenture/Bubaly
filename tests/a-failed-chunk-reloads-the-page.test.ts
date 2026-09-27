import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalError from '@/app/global-error';
import { contrastRatio } from '@/lib/utils/readable-text';
import { RELOAD_WINDOW_MS, shouldReloadForChunkFailure } from '@/lib/utils/stale-bundle-reload';

// The production crawl's 8 of 786: one JavaScript chunk answered 502 and the
// page sat on the error boundary, whose "Try again" re-renders the same bundle
// and asks for the same chunk. A chunk failure reloads the page once instead.
// The same crawl's axe pass caught the root error page's button, white on
// #7c5dff at 4.31:1.

const CHUNK = { name: 'ChunkLoadError', message: 'Loading chunk 7177 failed.\n(error: https://www.bubaly.com/_next/static/chunks/app/layout-51451d37b525791a.js)' };

describe('a boundary that catches a chunk that failed to load', () => {
  it('reloads the page once', () => {
    expect(shouldReloadForChunkFailure(CHUNK, '/dashboard/memories', null, 1_000)).toBe(true);
    expect(shouldReloadForChunkFailure({ name: 'Error', message: 'Failed to fetch dynamically imported module: https://x/_next/a.js' }, '/a', null, 1)).toBe(true);
  });

  it('does not reload again for the same page within the window, so a chunk that is gone cannot loop', () => {
    const last = { path: '/dashboard/memories', at: 1_000 };
    expect(shouldReloadForChunkFailure(CHUNK, '/dashboard/memories', last, 1_000 + RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(shouldReloadForChunkFailure(CHUNK, '/dashboard/memories', last, 1_000 + RELOAD_WINDOW_MS)).toBe(true);
    expect(shouldReloadForChunkFailure(CHUNK, '/wallet/invest', last, 1_001)).toBe(true);
  });

  it('leaves every other error to the card and its Try again', () => {
    expect(shouldReloadForChunkFailure({ name: 'TypeError', message: 'x is not a function' }, '/a', null, 1)).toBe(false);
    expect(shouldReloadForChunkFailure(null, '/a', null, 1)).toBe(false);
  });

  it('is what every error boundary in the app does', () => {
    const boundaries: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry === 'error.tsx' || entry === 'global-error.tsx') boundaries.push(p);
      }
    };
    walk('app');
    expect(boundaries.length).toBeGreaterThan(10);
    const sectionError = readFileSync('components/app/section-error.tsx', 'utf8');
    expect(sectionError).toMatch(/reloadOnceForChunkFailure\(error\)/);
    const bare = boundaries.filter((file) => {
      const src = readFileSync(file, 'utf8');
      // The Kitchen Display hard-reloads on its own, stricter policy.
      if (/isStaleBundleError\(/.test(src) && /window\.location\.reload\(\)/.test(src)) return false;
      if (/from '@\/components\/app\/section-error'/.test(src)) return false;
      return !/reloadOnceForChunkFailure\(error\)/.test(src);
    });
    expect(bare).toEqual([]);
  });
});

describe('the root error page', () => {
  const html = renderToStaticMarkup(createElement(GlobalError, { error: Object.assign(new Error('x'), { digest: 'abc' }), reset: () => {} }));
  const style = (tag: RegExp) => {
    const m = tag.exec(html);
    expect(m, String(tag)).not.toBeNull();
    return Object.fromEntries(m![1].split(';').filter(Boolean).map((d) => d.split(':').map((s) => s.trim()) as [string, string]));
  };

  it('draws its Try again button at AA', () => {
    const button = style(/<button[^>]*style="([^"]+)"/);
    expect(contrastRatio(button.color, button.background)!).toBeGreaterThanOrEqual(4.5);
  });

  it('draws its reference line at AA on the page background', () => {
    const body = style(/<body[^>]*style="([^"]+)"/);
    const reference = style(/<p style="([^"]+)">Reference:/);
    expect(contrastRatio(reference.color, body.background)!).toBeGreaterThanOrEqual(4.5);
  });
});
