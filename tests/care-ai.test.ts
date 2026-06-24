import { describe, expect, it } from 'vitest';
import { analyzeCare, buildCarePrompt, parseCareResponse, type CareEntryForAI } from '@/lib/care/care-ai';

function entry(overrides: Partial<CareEntryForAI> = {}): CareEntryForAI {
  return { log_type: 'check_in', occurred_at: new Date().toISOString(), wellbeing: null, note: null, ...overrides };
}

describe('analyzeCare', () => {
  it('summarizes entries', () => {
    const r = analyzeCare([entry({ log_type: 'check_in' }), entry({ log_type: 'visit', wellbeing: 7 }), entry({ log_type: 'check_in', wellbeing: 9 })]);
    expect(r.totalEntries).toBe(3);
    expect(r.typeCounts['check_in']).toBe(2);
    expect(r.avgWellbeing).toBe(8);
  });

  it('handles empty list', () => {
    const r = analyzeCare([]);
    expect(r.totalEntries).toBe(0);
    expect(r.avgWellbeing).toBeNull();
  });
});

describe('buildCarePrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildCarePrompt([entry({ log_type: 'call', note: 'Feeling good' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('call');
  });
});

describe('parseCareResponse', () => {
  it('parses valid JSON', () => {
    const r = parseCareResponse('{"suggestions":["more visits"],"wellbeingTips":["exercise"],"coordinationTip":"share schedule"}');
    expect(r.suggestions).toEqual(['more visits']);
    expect(r.coordinationTip).toBe('share schedule');
  });

  it('handles malformed input', () => {
    expect(parseCareResponse('bad').suggestions).toEqual([]);
  });
});
