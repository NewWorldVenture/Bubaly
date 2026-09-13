import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

// TODO-0416 — hydration ships as habit presets + count logging, not a new module.
const src = readUiSource('components/modules/habits-module.tsx');

describe('habits hydration (TODO-0416)', () => {
  // Count mutation, readback, conflict and lifecycle guarantees execute through
  // the actual component and SDK in e2e/hydration-ledger.spec.ts. The previous
  // source-shape assertion required id-only writes and missed those failures.
  it('streaks only count days that met the daily target', () => {
    expect(src).toContain("doneDates(logsQ.data, h.id, h.cadence === 'daily' ? h.target_per_period : 1)");
  });
  it('the form offers presets and a daily target instead of forcing 1', () => {
    expect(src).toContain('Start from a preset');
    expect(src).toContain("target_per_period: Math.max(1, Math.min(cadence === 'weekly' ? 7 : 30, target))");
    expect(src).not.toContain("target_per_period: cadence === 'weekly' ? Math.max(1, target) : 1");
    expect(src).toContain('presetToHabit(preset, { id: memberId, age: memberAge })');
  });
});
