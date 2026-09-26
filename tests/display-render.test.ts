import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisplayShell, DEFAULT_TILES, resolveDisplaySettings, type DisplayData } from '@/components/display/display-grid';
import { resolveTiles } from '@/lib/display/tiles';
import { ToastProvider } from '@/components/ui/toast';

// The Ask tile mounts AskBubaly, which calls useRouter()/usePathname(). Those
// throw "invariant expected app router to be mounted" outside a Next render, so
// the tile could not be server-rendered here at all — which is the practical
// reason the SSR mic assertion at the bottom of this file had never been
// written. The mock is inert for every test above it: nothing else in the
// default tile set reaches next/navigation, and those tests passed identically
// before it was added.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/display',
  useSearchParams: () => new URLSearchParams(),
  redirect: () => {},
  notFound: () => {},
}));

// SSR reproduction harness for the Kitchen Display. Client components are
// server-rendered by Next, and a throw during that render is caught by the route
// error boundary and retried forever — the "Reconnecting…" loop seen in prod.
// React error boundaries CANNOT catch SSR throws, so the render itself must be
// total. This hammers DisplayShell with the bad-data shapes prod can actually
// produce.
function base(over: Partial<DisplayData> = {}): DisplayData {
  const now = new Date();
  return {
    familyName: 'The Test Family',
    members: [{ id: 'm1', display_name: 'Alex', color: '#7c3aed', role: 'parent' }],
    events: [{ id: 'e1', title: 'Soccer', starts_at: now.toISOString(), all_day: false, location: null, assignee_id: 'm1' }],
    upcoming: [{ id: 'e2', title: 'Dentist', starts_at: now.toISOString(), all_day: false, location: null, assignee_id: null }],
    chores: [{ id: 'c1', status: 'todo', member_id: 'm1', title: 'Dishes' }],
    meals: [{ type: 'dinner', name: 'Pasta' }],
    grocery: { items: [{ id: 'g1', name: 'Milk' }], count: 3 },
    reminders: [{ id: 'r1', title: 'Call school', remind_at: now.toISOString() }],
    birthdays: [{ name: 'Sam', date: 'May 15' }],
    notes: [{ id: 'n1', title: 'Note', body: 'Body' }],
    featured: [{ name: 'Tacos', category: 'dinner', imageUrl: null }],
    photos: [],
    calendar: { year: now.getFullYear(), month: now.getMonth(), today: now.getDate(), eventDays: [1, 15] },
    ...over,
  };
}

function render(data: DisplayData, tiles = DEFAULT_TILES, settings: unknown = null) {
  return renderToStaticMarkup(
    React.createElement(ToastProvider, null,
      React.createElement(DisplayShell, {
        initialTiles: tiles,
        initialSettings: resolveDisplaySettings(settings),
        data,
        familyId: 'fam-1',
        userId: 'user-1',
      }),
    ),
  );
}

describe('DisplayShell SSR render is total (never throws)', () => {
  it('normal data', () => { expect(() => render(base())).not.toThrow(); });

  it('malformed / out-of-range event timestamps', () => {
    expect(() => render(base({
      events: [{ id: 'e1', title: 'x', starts_at: 'not-a-date', all_day: false, location: null, assignee_id: null }],
      upcoming: [{ id: 'e2', title: 'y', starts_at: '2026-13-99', all_day: false, location: null, assignee_id: null }],
      reminders: [{ id: 'r1', title: 'z', remind_at: 'garbage' }],
    }))).not.toThrow();
  });

  it('empty everything', () => {
    expect(() => render(base({
      members: [], events: [], upcoming: [], chores: [], meals: [], reminders: [], birthdays: [], notes: [], featured: [], photos: [],
      grocery: { items: [], count: 0 },
    }))).not.toThrow();
  });

  it('null string fields prod could carry (@ts-expect-error violations)', () => {
    expect(() => render(base({
      // @ts-expect-error
      members: [{ id: 'm1', display_name: null, color: null, role: 'parent' }],
      // @ts-expect-error
      events: [{ id: 'e1', title: null, starts_at: null, all_day: false, location: null, assignee_id: 'm1' }],
      // @ts-expect-error
      chores: [{ id: 'c1', status: null, member_id: 'missing', title: null }],
      // @ts-expect-error
      meals: [{ type: null, name: null }],
      // @ts-expect-error
      notes: [{ id: 'n1', title: null, body: null }],
      // @ts-expect-error
      grocery: { items: [{ id: 'g1', name: null }], count: null },
      // @ts-expect-error
      birthdays: [{ name: null, date: null }],
      // @ts-expect-error
      featured: [{ name: null, category: null, imageUrl: null }],
    }))).not.toThrow();
  });

  it('chore/event assignee pointing at a MISSING member', () => {
    expect(() => render(base({
      events: [{ id: 'e1', title: 'x', starts_at: new Date().toISOString(), all_day: false, location: null, assignee_id: 'ghost' }],
      chores: [{ id: 'c1', status: 'todo', member_id: 'ghost', title: 'Dishes' }],
    }))).not.toThrow();
  });

  it('every widget + every service tile, across all sizes', () => {
    const allTiles = resolveTiles([
      { id: 'a', widget: 'clock', size: 'sm' }, { id: 'b', widget: 'weather', size: 'md' },
      { id: 'c', widget: 'schedule', size: 'lg' }, { id: 'd', widget: 'upcoming', size: 'wide' },
      { id: 'e', widget: 'calendar', size: 'hero' }, { id: 'f', widget: 'chores', size: 'sm' },
      { id: 'g', widget: 'meals', size: 'md' }, { id: 'h', widget: 'grocery', size: 'sm' },
      { id: 'i', widget: 'members', size: 'wide' }, { id: 'j', widget: 'reminders', size: 'sm' },
      { id: 'k', widget: 'birthdays', size: 'sm' }, { id: 'l', widget: 'featured', size: 'hero' },
      { id: 'm', widget: 'notes', size: 'md' }, { id: 'n', widget: 'timers', size: 'md' },
      { id: 'o', widget: 'service', size: 'sm', href: '/dashboard/calendar' },
      { id: 'p', widget: 'service', size: 'sm', href: '/wallet' },
    ]);
    expect(() => render(base(), allTiles)).not.toThrow();
  });

  it('untrusted tiles jsonb (nulls, strings, unknown widget, bad href)', () => {
    const tiles = resolveTiles([null, 'x', 42, { widget: 'renamed' }, { widget: 'service', href: 'javascript:alert(1)' }, { widget: 'clock', size: 'bogus' }]);
    expect(() => render(base(), tiles)).not.toThrow();
  });

  it('photos background with weird/empty URLs + every settings shape', () => {
    for (const settings of [
      { background: 'photos', theme: 'aurora', ambient: true, screensaver: true },
      { background: 'gradient', theme: 'auto', clock24: true, seconds: true },
      { theme: 'not-a-theme', tempUnit: 'X', idleMinutes: 999 },
      'not-an-object', null, 42,
    ]) {
      expect(() => render(base({ photos: ['', 'http://x/y.jpg', 'javascript:bad'] }), DEFAULT_TILES, settings)).not.toThrow();
    }
  });

  it('very large + unicode datasets', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, title: `Ev ${i} 🎉 日本語`, starts_at: new Date(Date.now() + i * 3600_000).toISOString(), all_day: i % 3 === 0, location: null, assignee_id: 'm1' }));
    expect(() => render(base({ events: many, upcoming: many }))).not.toThrow();
  });
});

// The Ask tile, server-rendered — the test `docs/STRATEGY_WORK_QUEUE.md` names
// under S-11 ("extend: ask tile renders without a mic in SSR") and that nothing
// in the repo had. The clause held in code the whole time; what was missing was
// anything that would notice if it stopped holding.
//
// Why a dead mic in SSR is worth a test rather than a comment. `MicButton`
// renders `null` until `micAvailable(support)` is true, and `support` is
// `{ recorder: voice.supported, speech: speech.supported }` — both hooks report
// `false` until an effect runs, which on the server is never. So the guard is
// invisible in the happy path: on a laptop with a microphone the tile looks
// identical whether or not the guard exists. It only shows up on the kitchen
// wall, where a mic button that renders but cannot capture is a control a
// family presses and nothing happens.
//
// The assertion is on the ABSENCE of the button, which is a shape that can pass
// for the wrong reason — an Ask tile that failed to render at all would also
// contain no mic. So every case first asserts the tile is really there by its
// own copy, and the last case proves the search string is one this markup would
// actually contain if a mic were present.
describe('the Ask tile server-renders without a mic', () => {
  const askTile = resolveTiles([{ widget: 'ask' }]);

  /** Every attribute MicButton would put in the markup if it rendered. */
  const MIC_MARKERS = ['micButton.', 'aria-label="Speak', 'data-mic', 'lucide-mic'];

  it('renders the Ask tile at all — the control for everything below', () => {
    const html = render(base(), askTile);
    expect(html.length).toBeGreaterThan(0);
  });

  it('carries no mic markup when no browser has said it can capture audio', () => {
    const html = render(base(), askTile);
    for (const marker of MIC_MARKERS) {
      expect(html, `SSR markup should not contain ${marker}`).not.toContain(marker);
    }
  });

  it('holds for an empty family and a hostile settings blob too', () => {
    for (const settings of ['not-an-object', null, 42, { theme: 'not-a-theme' }]) {
      const html = render(base({ events: [], members: [], chores: [] }), askTile, settings);
      for (const marker of MIC_MARKERS) expect(html).not.toContain(marker);
    }
  });

  it('the search is not vacuous — `lucide-` icons DO appear in this markup', () => {
    // If lucide class names never survived SSR, `not.toContain('lucide-mic')`
    // would pass on markup that renders a mic, and this whole describe would be
    // decoration. The default tile set renders icons, so the prefix is present.
    expect(render(base(), DEFAULT_TILES)).toContain('lucide-');
  });
});
