import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// AskBubaly (mounted by the ask tile) uses the app router. On the real display
// that router is there — the shell is client-only (`ssr: false`) and runs in the
// browser — but a bare renderToStaticMarkup has no router context, so it is
// stubbed here. Everything else is the real component tree.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/display',
  useSearchParams: () => new URLSearchParams(),
}));

import { DisplayShell, WIDGETS, type DisplayData } from '@/components/display/display-grid';
import { DEFAULT_TILES, WIDGET_KEYS, resolveTiles, type Tile } from '@/lib/display/tiles';
import { HANDLED_TILE_ITEMS, type HandledToday } from '@/components/display/handled-today-tile';
import { normalizeSettings } from '@/lib/display/ambient';
import { ToastProvider } from '@/components/ui/toast';

const page = readFileSync('app/(app)/display/page.tsx', 'utf8');

function base(over: Partial<DisplayData> = {}): DisplayData {
  const now = new Date();
  return {
    familyName: 'The Test Family',
    members: [{ id: 'm1', display_name: 'Alex', color: '#7c3aed', role: 'parent' }],
    events: [], upcoming: [], chores: [], meals: [],
    grocery: { items: [], count: 0 }, reminders: [], birthdays: [],
    notes: [], featured: [], photos: [],
    calendar: { year: now.getFullYear(), month: now.getMonth(), today: now.getDate(), eventDays: [] },
    ...over,
  };
}

function render(data: DisplayData, tiles: Tile[]) {
  return renderToStaticMarkup(
    React.createElement(ToastProvider, null,
      React.createElement(DisplayShell, {
        initialTiles: tiles,
        initialSettings: normalizeSettings({ setupDismissed: true }),
        data,
        familyId: 'fam-1',
        userId: 'user-1',
      }),
    ),
  );
}

const askTile: Tile[] = [{ id: 'a', widget: 'ask', size: 'md' }];
const handledTile: Tile[] = [{ id: 'h', widget: 'handled_today', size: 'md' }];

describe('tile registration', () => {
  it('adds ask and handled_today to the widget keys', () => {
    expect(WIDGET_KEYS).toContain('ask');
    expect(WIDGET_KEYS).toContain('handled_today');
  });

  it('leaves DEFAULT_TILES exactly as it was — a saved-layout-less family sees no reshuffle', () => {
    expect(DEFAULT_TILES).toEqual([
      { id: 't1', widget: 'featured', size: 'hero' },
      { id: 't2', widget: 'schedule', size: 'md' },
      { id: 't3', widget: 'timers', size: 'md' },
      { id: 't4', widget: 'weather', size: 'sm' },
      { id: 't5', widget: 'meals', size: 'sm' },
      { id: 't6', widget: 'chores', size: 'sm' },
      { id: 't7', widget: 'grocery', size: 'sm' },
      { id: 't8', widget: 'calendar', size: 'md' },
      { id: 't9', widget: 'members', size: 'wide' },
    ]);
  });

  it('accepts both from the stored jsonb, and strips a stray href like every other built-in', () => {
    expect(resolveTiles([
      { id: 'a', widget: 'ask', size: 'md', href: '/dashboard' },
      { id: 'h', widget: 'handled_today', size: 'sm' },
    ])).toEqual([
      { id: 'a', widget: 'ask', size: 'md' },
      { id: 'h', widget: 'handled_today', size: 'sm' },
    ]);
  });

  it('offers both in the layout editor, with a catalogue key for the label', () => {
    for (const key of ['ask', 'handled_today'] as const) {
      const widget = WIDGETS.find((w) => w.key === key);
      expect(widget, key).toBeTruthy();
      expect(widget?.labelKey, `${key} needs a translated label`).toBeTruthy();
    }
  });
});

describe('the ask tile files a request — it does not act', () => {
  const source = readFileSync('components/display/ask-tile.tsx', 'utf8');

  it('mounts the shared AskBubaly rather than a display-only copy', () => {
    expect(source).toContain("from '@/components/concierge/ask-bubaly'");
    expect(source).toContain('<AskBubaly');
  });

  it('inherits the shared intake, so trust gating is unchanged', () => {
    // AskBubaly is the only submit path, and it posts to /api/ai/requests via
    // submitAIRequest. The display adds no second route and no direct write.
    const ask = readFileSync('components/concierge/ask-bubaly.tsx', 'utf8');
    expect(ask).toContain('submitAIRequest');
    expect(source).not.toMatch(/fetch\(|supabase|\.insert\(|\.upsert\(/);
  });

  it('keeps the shared mic (useSpeechRecognition through MicButton)', () => {
    const ask = readFileSync('components/concierge/ask-bubaly.tsx', 'utf8');
    expect(ask).toContain('MicButton');
    expect(readFileSync('components/voice/mic-button.tsx', 'utf8')).toContain('useSpeechRecognition');
  });

  it('server-renders without throwing', () => {
    expect(() => render(base(), askTile)).not.toThrow();
  });
});

describe('the handled-today tile fails closed', () => {
  const ok: HandledToday = {
    status: 'ok',
    count: 4,
    items: [
      { key: 'run:1', title: 'Booked the dentist slot', href: '/dashboard/concierge/runs/1', at: '2026-09-09T09:00:00.000Z' },
      { key: 'run:2', title: 'Added the field trip to the calendar', href: '/dashboard/concierge/runs/2', at: '2026-09-09T08:10:00.000Z' },
      { key: 'run:3', title: 'Topped up the grocery list', href: '/dashboard/concierge/runs/3', at: '2026-09-09T07:30:00.000Z' },
    ],
  };

  it('shows the count and the last items when the read succeeded', () => {
    const html = render(base({ handled: ok }), handledTile);
    expect(html).toContain('4');
    expect(html).toContain('Booked the dentist slot');
    expect(html).toContain('/dashboard/concierge/runs/1');
    expect(html).toContain('finished today');
  });

  it('lists at most three items', () => {
    expect(HANDLED_TILE_ITEMS).toBe(3);
    const four = { ...ok, items: [...ok.items, { key: 'run:4', title: 'A fourth thing', href: '/x', at: ok.items[0].at }] };
    const html = render(base({ handled: four }), handledTile);
    expect(html).not.toContain('A fourth thing');
  });

  it('renders the error state and a retry on a failed read — never a zero', () => {
    const html = render(base({ handled: { status: 'error' } }), handledTile);
    expect(html).toContain('Bubaly could not read what it finished');
    expect(html).toContain('Try again');
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it('treats a MISSING reading as a failed read, not as an empty day', () => {
    const html = render(base({ handled: undefined }), handledTile);
    expect(html).toContain('Bubaly could not read what it finished');
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it('says nothing finished only when the read actually came back empty', () => {
    const html = render(base({ handled: { status: 'ok', count: 0, items: [] } }), handledTile);
    expect(html).toContain('Nothing has finished yet today');
    expect(html).not.toContain('Bubaly could not read what it finished');
  });
});

describe('the server read behind the tile', () => {
  // The prose above the function explains why partial runs are excluded, so the
  // query itself is what is inspected — comments stripped.
  const handledQuery = page
    .slice(page.indexOf('async function loadHandledToday'), page.indexOf('// Kitchen Display Mode is a Family Basic feature'))
    .replace(/\/\/[^\n]*/g, '');

  it('counts COMPLETED runs only, inside today', () => {
    expect(handledQuery).toContain("from('family_automation_runs')");
    expect(handledQuery).toContain(".eq('state', 'completed')");
    expect(handledQuery).not.toContain('partially_completed');
    expect(handledQuery).not.toContain(".in('state'");
    expect(handledQuery).toContain(".gte('completed_at', start.toISOString())");
    expect(handledQuery).toContain(".lt('completed_at', end.toISOString())");
  });

  it('logs and fails closed on an error OR a count it cannot stand behind', () => {
    expect(page).toContain("console.error('[display] handled today read failed'");
    expect(page).toContain("typeof countRes.count !== 'number'");
    expect(page).toContain("return { status: 'error' }");
  });

  it('leaves handled unset in the whole-page fallback rather than inventing a zero', () => {
    const empty = page.slice(page.indexOf('function emptyDisplay'), page.indexOf('async function loadHandledToday'));
    expect(empty).not.toMatch(/handled:/);
  });

  it('reads only columns family_automation_runs actually has', () => {
    const migrations = [
      readFileSync('supabase/migrations/0022_family_os.sql', 'utf8'),
      readFileSync('supabase/migrations/0250_ai_runtime_core.sql', 'utf8'),
    ].join('\n');
    for (const column of ['summary', 'state', 'completed_at', 'family_id']) {
      expect(migrations, column).toContain(column);
    }
  });
});
