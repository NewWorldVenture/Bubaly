import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0797): Focus Mode read events+chores+todos via Promise.all
// and dropped every `error`, so a failed read rendered items=[] → the "Nothing on
// your plate / Enjoy the calm" state — telling a family their day is clear when the
// load actually failed. It now flags a real error on the primary reads (events +
// todos) and shows an honest, retryable "Couldn't load your day" state instead.

const src = readUiSource('components/modules/focus-module.tsx');

describe('focus mode surfaces a failed read (A-05)', () => {
  it('captures errors on the primary events + todos reads', () => {
    expect(src).toContain('data: events, error: evErr');
    expect(src).toContain('data: todos, error: tdErr');
    expect(src).toContain('if (evErr || tdErr) { setLoadError(true); setItems([]); return; }');
  });

  it('renders the error state before the "Nothing on your plate" false-empty', () => {
    expect(src).toContain('loadError ?');
    expect(src).toContain('Couldn’t load your day');
    // Error branch precedes the empty/finished branch (match JSX, not the comment).
    expect(src.indexOf('loadError ?')).toBeLessThan(src.indexOf('total === 0 || finished ?'));
  });
});
