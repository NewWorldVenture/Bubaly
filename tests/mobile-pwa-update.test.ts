import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 16 — PWA update UX): a PWA must surface a
// visible, reliable update mechanism so users are never stuck on stale code. The
// SW self-activates (skipWaiting), and RegisterSW now detects a freshly-installed
// worker and shows a mobile-safe "new version available → Reload" banner. The
// service worker must also never cache authenticated Supabase/API responses.

const reg = fs.readFileSync('components/pwa/register-sw.tsx', 'utf8');
const sw = fs.readFileSync('public/sw.js', 'utf8');
const manifest = fs.readFileSync('app/manifest.ts', 'utf8');

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
  });
  it('manifest is installable (standalone, maskable icon, scope)', () => {
    expect(manifest).toContain("display: 'standalone'");
    expect(manifest).toContain("purpose: 'maskable'");
    expect(manifest).toContain("scope: '/'");
  });
});
