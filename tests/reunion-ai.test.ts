import { describe, expect, it } from 'vitest';
import { analyzeReunions, buildReunionPrompt, parseReunionResponse, type ReunionForAI } from '@/lib/reunion/reunion-ai';

function reunion(overrides: Partial<ReunionForAI> = {}): ReunionForAI {
  return { title: 'Summer Reunion 2025', start_date: '2025-08-15', end_date: '2025-08-17', location: 'Lake House', guest_count: 25, ...overrides };
}

describe('analyzeReunions', () => {
  it('summarizes reunions', () => {
    const r = analyzeReunions([reunion(), reunion({ guest_count: 10 })]);
    expect(r.totalReunions).toBe(2);
    expect(r.totalGuests).toBe(35);
  });
  it('handles empty', () => { expect(analyzeReunions([]).summary).toContain('No family reunions'); });
});

describe('buildReunionPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildReunionPrompt([reunion()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Summer Reunion');
  });
});

describe('parseReunionResponse', () => {
  it('parses valid JSON', () => {
    const r = parseReunionResponse('{"suggestions":["send invites early"],"planningTips":["delegate tasks"],"activityIdea":"photo scavenger hunt"}');
    expect(r.suggestions).toEqual(['send invites early']);
  });
  it('handles malformed', () => { expect(parseReunionResponse('bad').suggestions).toEqual([]); });
});
