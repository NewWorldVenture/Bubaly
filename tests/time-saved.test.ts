import { describe, it, expect } from 'vitest';
import {
  HANDLED_RUN_STATES, SAVED_KINDS, computeTimeSaved, humanizeSaved, isHandledRun,
} from '@/lib/metric/time-saved';
import enUS from '@/lib/i18n/messages/en-US.json';

describe('humanizeSaved', () => {
  it('renders minutes under an hour, hours above', () => {
    expect(humanizeSaved(40)).toBe('about 40 minutes');
    expect(humanizeSaved(1)).toBe('about 1 minute');
    expect(humanizeSaved(90)).toBe('about 1.5 hours');
    expect(humanizeSaved(60)).toBe('about 1 hour');
  });
});

describe('computeTimeSaved', () => {
  it('weights each kind and totals minutes + actions', () => {
    const t = computeTimeSaved([
      { kind: 'autopilot', count: 10 }, // 10*5 = 50
      { kind: 'assistant', count: 5 },  // 5*4  = 20
      { kind: 'reminder', count: 20 },  // 20*2 = 40
    ]);
    expect(t.minutes).toBe(110);
    expect(t.hours).toBe(1.8);
    expect(t.actions).toBe(35);
    expect(t.show).toBe(true);
    expect(t.headline).toContain('about 1.8 hours');
    expect(t.headline).toContain('35 things');
  });

  it('drops zero-count kinds from the breakdown', () => {
    const t = computeTimeSaved([{ kind: 'autopilot', count: 3 }, { kind: 'reminder', count: 0 }]);
    expect(t.rows.map((r) => r.kind)).toEqual(['autopilot']);
  });

  it('hides and gives an encouraging headline when nothing was handled', () => {
    const t = computeTimeSaved([{ kind: 'autopilot', count: 0 }]);
    expect(t.show).toBe(false);
    expect(t.actions).toBe(0);
    expect(t.headline).toContain('start saving you time');
  });
});

// ─── S-15: the run kind, and the labels the UI actually renders ──────────────

describe('the run kind', () => {
  it('weights a whole automation run above a single reminder', () => {
    const t = computeTimeSaved([{ kind: 'run', count: 1 }, { kind: 'reminder', count: 1 }]);
    const run = t.rows.find((r) => r.kind === 'run');
    const reminder = t.rows.find((r) => r.kind === 'reminder');
    expect(run!.minutes).toBeGreaterThan(reminder!.minutes);
    expect(t.minutes).toBe(run!.minutes + reminder!.minutes);
  });

  it('counts runs in the one handled-this-week number', () => {
    const t = computeTimeSaved([
      { kind: 'run', count: 2 }, { kind: 'autopilot', count: 1 },
      { kind: 'assistant', count: 1 }, { kind: 'reminder', count: 3 },
    ]);
    expect(t.actions).toBe(7);
  });

  it('lists every kind in SAVED_KINDS', () => {
    const t = computeTimeSaved(SAVED_KINDS.map((kind) => ({ kind, count: 1 })));
    expect(t.rows.map((r) => r.kind)).toEqual([...SAVED_KINDS]);
  });
});

describe('row labels', () => {
  // The banner renders `labelKey`, never `label` — an English label reaching a
  // screen is exactly the regression the i18n gate exists to prevent, and a
  // key with no catalogue entry renders as the key itself.
  it('carries a catalogue key whose English matches the label', () => {
    const catalogue = enUS as Record<string, string>;
    const t = computeTimeSaved(SAVED_KINDS.map((kind) => ({ kind, count: 1 })));
    for (const row of t.rows) {
      expect(row.labelKey.startsWith('timeSaved.')).toBe(true);
      expect(catalogue[row.labelKey]).toBe(row.label);
    }
  });
});

describe('the handled-run vocabulary', () => {
  it('is the one definition every surface reads', () => {
    expect([...HANDLED_RUN_STATES]).toEqual(['completed', 'partially_completed']);
  });

  it('accepts a partial run and refuses everything unfinished or failed', () => {
    expect(isHandledRun({ state: 'partially_completed' })).toBe(true);
    for (const state of ['queued', 'planning', 'executing', 'verifying', 'failed', 'blocked', 'cancelled', 'paused']) {
      expect(isHandledRun({ state })).toBe(false);
    }
  });

  it('reads the legacy `status` column when `state` never moved', () => {
    // The concierge approval path writes only `status`; a definition that
    // ignored it told a family "0 handled" beside a plan it had just run.
    expect(isHandledRun({ state: 'awaiting_approval', status: 'executed' })).toBe(true);
    expect(isHandledRun({ state: 'queued', status: 'executed' })).toBe(true);
    for (const status of ['pending', 'approved', 'skipped', 'dismissed', 'failed']) {
      expect(isHandledRun({ state: 'queued', status })).toBe(false);
    }
  });
});
