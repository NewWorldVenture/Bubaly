import { describe, it, expect } from 'vitest';
import { HANDLED_RUN_STATES, SAVED_KINDS, computeTimeSaved, humanizeSaved, isHandledRun, type SavedInput } from '@/lib/metric/time-saved';
import { MODELED_MINUTES_PER_COMPLETED_PLAN } from '@/lib/metric/completed-plans-model';
import enUS from '@/lib/i18n/messages/en-US.json';

describe('modeled planning time', () => {
  it('uses the shared explicit assumption for recorded completed plans', () => {
    const result = computeTimeSaved([{ kind: 'run', count: 5 }]);
    expect(result.minutes).toBe(5 * MODELED_MINUTES_PER_COMPLETED_PLAN);
    expect(result.hours).toBe(1);
    expect(result.actions).toBe(5);
    expect(result.headline).toContain('modeled planning time');
    expect(result.headline).not.toContain('saved');
    expect(SAVED_KINDS).toEqual(['run']);
  });

  it('does not accidentally add legacy activity or reminder inputs to the model', () => {
    const inputs = [{ kind: 'run', count: 1 }, { kind: 'assistant', count: 9 }, { kind: 'reminder', count: 4 }, { kind: 'autopilot', count: 3 }] as SavedInput[];
    expect(computeTimeSaved(inputs)).toMatchObject({ actions: 1, minutes: 12, rows: [{ kind: 'run' }] });
  });

  it('shows missing-date coverage even when the dated subset is empty', () => {
    expect(computeTimeSaved([{ kind: 'run', count: 0 }], 3)).toMatchObject({ actions: 0, minutes: 0, undatedCompletedRuns: 3, show: true });
    expect(computeTimeSaved([{ kind: 'run', count: 0 }])).toMatchObject({ actions: 0, undatedCompletedRuns: 0, show: false });
  });

  it('uses translated recorded-completion labels', () => {
    const row = computeTimeSaved([{ kind: 'run', count: 1 }]).rows[0];
    expect((enUS as Record<string, string>)[row.labelKey]).toBe(row.label);
    expect(row.label).toBe('recorded completed plans');
  });

  it('formats modeled duration without changing the arithmetic', () => {
    expect(humanizeSaved(40)).toBe('about 40 minutes');
    expect(humanizeSaved(1)).toBe('about 1 minute');
    expect(humanizeSaved(90)).toBe('about 1.5 hours');
    expect(humanizeSaved(60)).toBe('about 1 hour');
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
