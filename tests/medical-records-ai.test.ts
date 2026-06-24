import { describe, expect, it } from 'vitest';
import { analyzeMedicalRecords, buildMedicalRecordsPrompt, parseMedicalRecordsResponse, type MedicalProfileForAI } from '@/lib/medical-records/medical-records-ai';

function profile(overrides: Partial<MedicalProfileForAI> = {}): MedicalProfileForAI {
  return { blood_type: 'O+', allergies: 'peanuts', conditions: 'asthma', ...overrides };
}

describe('analyzeMedicalRecords', () => {
  it('summarizes profiles', () => {
    const r = analyzeMedicalRecords([profile(), profile({ blood_type: 'A+' })]);
    expect(r.totalProfiles).toBe(2);
  });
  it('handles empty', () => { expect(analyzeMedicalRecords([]).summary).toContain('No medical'); });
});

describe('buildMedicalRecordsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildMedicalRecordsPrompt([profile()]);
    expect(system).toContain('JSON');
    expect(user).toContain('peanuts');
  });
});

describe('parseMedicalRecordsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseMedicalRecordsResponse('{"suggestions":["update records annually"],"organizationTips":["keep copies"],"preparationTip":"bring a list"}');
    expect(r.suggestions).toEqual(['update records annually']);
  });
  it('handles malformed', () => { expect(parseMedicalRecordsResponse('bad').suggestions).toEqual([]); });
});
