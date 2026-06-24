import { describe, expect, it } from 'vitest';
import {
  analyzeImmunizations,
  buildImmunizationsPrompt,
  parseImmunizationsResponse,
  type ImmunizationEntryLike,
} from '@/lib/health/immunizations-ai';

function record(overrides: Partial<ImmunizationEntryLike> = {}): ImmunizationEntryLike {
  return { vaccine: 'Flu', dose_label: 'Annual', date_given: '2024-01-15', next_due_date: null, ...overrides };
}

describe('analyzeImmunizations', () => {
  it('summarizes records', () => {
    const r = analyzeImmunizations([
      record({ vaccine: 'Flu' }),
      record({ vaccine: 'COVID-19' }),
      record({ vaccine: 'Flu', next_due_date: '2000-01-01' }),
    ]);
    expect(r.totalRecords).toBe(3);
    expect(r.vaccineCounts['Flu']).toBe(2);
    expect(r.vaccineCounts['COVID-19']).toBe(1);
    expect(r.overdueCount).toBe(1);
  });

  it('detects due soon', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const r = analyzeImmunizations([record({ next_due_date: soon.toISOString().slice(0, 10) })]);
    expect(r.dueSoonCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeImmunizations([]);
    expect(r.totalRecords).toBe(0);
    expect(r.overdueCount).toBe(0);
  });
});

describe('buildImmunizationsPrompt', () => {
  it('builds prompt with record info', () => {
    const { system, user } = buildImmunizationsPrompt([record({ vaccine: 'Tdap', dose_label: 'Booster' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Tdap');
    expect(user).toContain('Booster');
  });
});

describe('parseImmunizationsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseImmunizationsResponse('{"suggestions":["check boosters"],"scheduleTips":["set calendar"],"reminderTip":"use app"}');
    expect(r.suggestions).toEqual(['check boosters']);
    expect(r.scheduleTips).toEqual(['set calendar']);
    expect(r.reminderTip).toBe('use app');
  });

  it('handles malformed input', () => {
    const r = parseImmunizationsResponse('bad');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseImmunizationsResponse('```json\n{"suggestions":["x"],"scheduleTips":["y"],"reminderTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
