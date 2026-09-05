import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// TODO-0416 — hydration ships as habit presets + count logging, not a new module.
const src = readFileSync('components/modules/habits-module.tsx', 'utf8');
function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('habits hydration (TODO-0416)', () => {
  it('count logging updates the single row per day and guards every write', () => {
    const b = body('logCount');
    expect(b).toContain("from('habit_logs').delete().eq('id', existing.id)");
    expect(b).toContain("from('habit_logs').update({ count: next }).eq('id', existing.id)");
    expect(b).toContain("from('habit_logs').insert({");
    expect(b.match(/if \(error\) return toastError\(describeDbError\(error\)\)/g)).toHaveLength(2);
  });
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
