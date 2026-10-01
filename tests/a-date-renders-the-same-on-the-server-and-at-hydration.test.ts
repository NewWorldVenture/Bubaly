// P-11 review on #604. `useFormat()` binds the reader's locale, not a zone, so
// a timestamp drawn on the server and again in a browser in another zone is
// different text: `2026-07-14T00:30:00Z` is "0:30" in UTC, "2:30" in Berlin and
// the day before in New York, and React threw #418 on hydration. The first
// render — the server's and the browser's hydrating one — must use one zone;
// the reader's own zone arrives in the render after hydration.
//
// Rendered here with React's real server renderer while this process runs in
// America/New_York, standing in for a browser in that zone: the hydration-safe
// formatter still draws the UTC text, and the zone-less formatter (the control)
// draws the local text a server in UTC would not have sent. `useFormat()` now
// binds UTC for the server and hydrating renders too (#607), so it is held to
// the same first-render text.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ISO = '2026-07-14T00:30:00Z';
let savedTz: string | undefined;

beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = 'America/New_York'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

const { useFormat, useHydrationSafeFormat } = await import('@/components/i18n/use-format');
const { createFormat } = await import('@/lib/utils/format');

function Safe() { return createElement('span', null, useHydrationSafeFormat().fmtDateTime(ISO)); }
function Bound() { return createElement('span', null, useFormat().fmtDateTime(ISO)); }
function Plain() { return createElement('span', null, createFormat('en-US', (key: string) => key).fmtDateTime(ISO)); }

describe('a date on the first render', () => {
  it('this process really is in New York (the control that makes the next two mean something)', () => {
    expect(new Date(ISO).getHours()).toBe(20);
  });

  it('is the UTC text, whatever zone the renderer runs in', () => {
    const html = renderToString(createElement(Safe));
    expect(html).toMatch(/14/);
    expect(html).toMatch(/12:30|0:30|00:30/);
    expect(html).not.toMatch(/8:30|20:30/);
  });

  it('would have been the local text through a zone-less formatter (why the hook exists)', () => {
    const html = renderToString(createElement(Plain));
    expect(html).toMatch(/13/);
    expect(html).toMatch(/8:30|20:30/);
  });

  it('is the UTC text through useFormat as well', () => {
    const html = renderToString(createElement(Bound));
    expect(html).toMatch(/14/);
    expect(html).toMatch(/12:30|0:30|00:30/);
    expect(html).not.toMatch(/8:30|20:30/);
  });

  // TIME-003: with a family bound the family's zone is used on every render,
  // server and client alike; the UTC-then-reader switch applies only where
  // there is no family (a public page).
  it('switches to the reader\'s zone only once hydration is done, where there is no family', () => {
    const src = readFileSync('components/i18n/use-format.ts', 'utf8');
    expect(src).toMatch(/useSyncExternalStore\(noSubscribe, \(\) => true, \(\) => false\)/);
    expect(src).toMatch(/createFormat\(locale\.code, t, familyZone \?\? \(hydrated \? undefined : 'UTC'\)\)/);
    expect(src).not.toMatch(/suppressHydrationWarning\s*[={}]/);
  });

  it('is what every P-11 date and time display uses', () => {
    for (const f of [
      'components/admin/admin-notifications-list.tsx',
      'components/social/account-row.tsx',
      'app/(app)/admin/marketing/reviews/review-row.tsx',
      'app/(app)/admin/marketing/loyalty/redemption-row.tsx',
    ]) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/const \{[^}]*\bfmtDate(Time)?\b[^}]*\} = useHydrationSafeFormat\(\)/);
    }
  });
});
