import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useHydrated } from '@/components/ui/modal';

/**
 * Audit C1-S9-96 — found by the page audit crawl, signed in, on
 * /dashboard/vacations/new, which opens its "New trip" modal on arrival:
 *
 *   Hydration failed because the server rendered HTML didn't match the client.
 *   + <div className="fixed inset-0 z-[90] flex items-end …">
 *
 * Modal returned null when `typeof document === 'undefined'`. That is true on
 * the server and FALSE on the client's first render — which is the hydration
 * render — so a modal open on arrival rendered nothing on the server and a
 * portal while hydrating, and React discarded the whole tree and rebuilt it on
 * the client. `useHydrated` reads the server snapshot during hydration, so the
 * portal waits one commit instead. The crawl on the rebuilt server is the
 * behavioural proof (the page-audit crawl, C1-S9-96); these hold the class shut.
 */
describe('a modal open on arrival hydrates (C1-S9-96)', () => {
  it('useHydrated answers false on the server, which is the snapshot hydration reads', () => {
    const Probe = () => createElement('span', null, useHydrated() ? 'client' : 'server');
    expect(renderToString(createElement(Probe))).toContain('server');
  });

  it('no portal is gated on a typeof document / window check', () => {
    // `typeof document` is false on the client's first render, so it cannot
    // tell hydration apart from a later render. Gate on useHydrated (or a
    // mounted flag set in an effect) instead.
    const files = execSync("git ls-files 'components/**/*.tsx' 'app/**/*.tsx'", { encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('createPortal(')) return false;
      return /if \(!?[\w.]*\s*(\|\||&&)?\s*typeof (document|window) === 'undefined'\) return null;/.test(src);
    });
    expect(offenders).toEqual([]);
    // Non-vacuity: the scan sees the portals that exist.
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('createPortal(')).length).toBeGreaterThanOrEqual(3);
  });

  it('Modal and the command bar gate on useHydrated', () => {
    expect(readFileSync('components/ui/modal.tsx', 'utf8')).toContain('if (!open || !hydrated) return null;');
    expect(readFileSync('components/app/command-bar.tsx', 'utf8')).toContain('if (!open || !hydrated) return null;');
  });
});
