import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// Mobile production-readiness (Phase 16 — PWA update UX): a PWA must surface a
// visible, reliable update mechanism so users are never stuck on stale code. The
// SW self-activates (skipWaiting), and RegisterSW now detects a freshly-installed
// worker and shows a mobile-safe "new version available → Reload" banner. The
// service worker must also never cache authenticated Supabase/API responses.

const reg = readUiSource('components/pwa/register-sw.tsx');
const sw = fs.readFileSync('public/sw.js', 'utf8');
const manifest = readUiSource('app/manifest.ts');

describe('PWA surfaces a visible update prompt (Phase 16)', () => {
  it('detects a new worker (updatefound + installed / controllerchange)', () => {
    expect(reg).toContain("addEventListener('updatefound'");
    expect(reg).toContain("installing.state === 'installed'");
    expect(reg).toContain("addEventListener('controllerchange'");
  });
  it('shows a reload action and is mobile-safe (fixed, safe-area bottom)', () => {
    expect(reg).toContain('window.location.reload()');
    expect(reg).toMatch(/new version of Bubaly is available/i);
    expect(reg).toContain('env(safe-area-inset-bottom)');
    expect(reg).toContain('fixed inset-x-0 bottom-0');
  });
  it('polls for updates so a long-lived tab is not left stale', () => {
    expect(reg).toContain('reg?.update()');
  });
});

describe('service worker + manifest are production-safe', () => {
  it('never caches authenticated Supabase/API responses', () => {
    expect(sw.toLowerCase()).toContain('never cache');
    expect(sw).toMatch(/skipWaiting/);
    // Those two read a comment and the install step. This runs the worker's own
    // fetch handler: a request it never answers with respondWith is one it can
    // neither serve from Cache Storage nor write into it.
    const origin = 'https://worker-fetch.invalid';
    const listeners = new Map<string, (event: unknown) => void>();
    new Function('self', 'fetch', 'caches', sw)(
      { location: { origin }, addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) },
      () => Promise.reject(new Error('offline')),
      { open: () => Promise.reject(new Error('no cache storage')) },
    );
    const onFetch = listeners.get('fetch');
    expect(onFetch).toBeTypeOf('function');
    const answered = (path: string, mode: string, destination: string) => {
      let calls = 0;
      onFetch?.({
        request: { method: 'GET', url: origin + path, mode, destination, headers: new Headers() },
        respondWith: (answer: Promise<unknown>) => { calls += 1; answer.catch(() => undefined); },
      });
      return calls;
    };
    // The handler does answer an ordinary page navigation, so the silence below
    // is the /api and /auth guard and not a handler that answers nothing.
    expect(answered('/home', 'navigate', 'document')).toBe(1);
    for (const path of ['/api', '/api/family-media?path=synthetic', '/api/wallet/balance', '/auth', '/auth/callback?code=synthetic', '/auth/confirm']) {
      for (const mode of ['navigate', 'same-origin', 'cors', 'no-cors']) {
        for (const destination of ['', 'document', 'image', 'script', 'style', 'audio', 'video']) {
          expect(answered(path, mode, destination), `${mode} ${destination || 'fetch'} ${path}`).toBe(0);
        }
      }
    }
  });
  it('manifest is installable (standalone, maskable icon, scope)', () => {
    expect(manifest).toContain("display: 'standalone'");
    expect(manifest).toContain("purpose: 'maskable'");
    expect(manifest).toContain("scope: '/'");
  });
});
