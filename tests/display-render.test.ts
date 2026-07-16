import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisplayShell, DEFAULT_TILES, resolveDisplaySettings, type DisplayData } from '@/components/display/display-grid';
import { ToastProvider } from '@/components/ui/toast';

// Reproduce the Kitchen Display SSR render (what Next does on the server) with
// adversarial, real-world data shapes to catch the deterministic throw that
// crashed bubaly.com/display into an endless recover loop.
function makeData(over: Partial<DisplayData> = {}): DisplayData {
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

function render(data: DisplayData) {
  return renderToStaticMarkup(
    React.createElement(ToastProvider, null,
      React.createElement(DisplayShell, {
        initialTiles: DEFAULT_TILES,
        initialSettings: resolveDisplaySettings(null),
        data,
        familyId: 'fam-1',
        userId: 'user-1',
      }),
    ),
  );
}

describe('DisplayShell SSR render never throws', () => {
  it('renders clean with normal data', () => {
    expect(() => render(makeData())).not.toThrow();
  });

  it('survives a MALFORMED event timestamp (the prod crash shape)', () => {
    expect(() => render(makeData({
      events: [{ id: 'e1', title: 'Bad', starts_at: 'not-a-date', all_day: false, location: null, assignee_id: null }],
      upcoming: [{ id: 'e2', title: 'Bad2', starts_at: '2026-13-99', all_day: false, location: null, assignee_id: null }],
    }))).not.toThrow();
  });

  it('survives null/empty collections', () => {
    expect(() => render(makeData({
      members: [], events: [], upcoming: [], chores: [], meals: [], reminders: [], birthdays: [], notes: [], featured: [], photos: [],
      grocery: { items: [], count: 0 },
    }))).not.toThrow();
  });

  it('survives a member with a null display_name', () => {
    expect(() => render(makeData({
      // @ts-expect-error — prod data can violate the type
      members: [{ id: 'm1', display_name: null, color: null, role: 'parent' }],
    }))).not.toThrow();
  });
});
