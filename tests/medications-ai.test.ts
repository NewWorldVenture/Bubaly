import { describe, expect, it } from 'vitest';
import {
  analyzeMedications,
  buildMedicationsPrompt,
  parseMedicationsResponse,
  type MedicationEntryLike,
} from '@/lib/medications/medications-ai';

function med(overrides: Partial<MedicationEntryLike>): MedicationEntryLike {
  return { name: 'Aspirin', dosage: '100mg', is_active: true, ...overrides };
}

describe('analyzeMedications', () => {
  it('summarizes medications', () => {
    const r = analyzeMedications(
      [med({}), med({ name: 'Vitamin D', is_active: false })],
      3,
      { taken: 20, skipped: 2, missed: 3 },
    );
    expect(r.totalMedications).toBe(2);
    expect(r.totalSchedules).toBe(3);
    expect(r.adherenceRate).toBe(80);
    expect(r.missedDoses).toBe(3);
    expect(r.summary).toContain('2 medications');
    expect(r.summary).toContain('80% adherence');
  });

  it('handles no doses', () => {
    const r = analyzeMedications([med({})], 1, { taken: 0, skipped: 0, missed: 0 });
    expect(r.adherenceRate).toBeNull();
  });

  it('handles empty', () => {
    const r = analyzeMedications([], 0, { taken: 0, skipped: 0, missed: 0 });
    expect(r.totalMedications).toBe(0);
    expect(r.summary).toContain('0 medications');
  });
});

describe('buildMedicationsPrompt', () => {
  it('builds prompt with medication info', () => {
    const { system, user } = buildMedicationsPrompt([med({ name: 'Lisinopril', dosage: '10mg' })], 2, { taken: 10, skipped: 1, missed: 0 });
    expect(system).toContain('JSON');
    expect(user).toContain('Lisinopril');
    expect(user).toContain('10mg');
  });
});

describe('parseMedicationsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseMedicationsResponse('{"suggestions":["set alarms"],"adherenceTips":["use pill box"],"organizationTip":"group by time"}');
    expect(r.suggestions).toEqual(['set alarms']);
    expect(r.adherenceTips).toEqual(['use pill box']);
    expect(r.organizationTip).toBe('group by time');
  });

  it('handles malformed input', () => {
    const r = parseMedicationsResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseMedicationsResponse('```json\n{"suggestions":["x"],"adherenceTips":[],"organizationTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
