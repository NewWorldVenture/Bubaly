import { describe, expect, it } from 'vitest';
import { analyzeSports, buildSportsPrompt, parseSportsResponse, type SportsEventForAI } from '@/lib/sports/sports-ai';

function event(overrides: Partial<SportsEventForAI> = {}): SportsEventForAI {
  return { sport: 'soccer', title: 'Practice', event_type: 'practice', starts_at: '2025-07-01T16:00:00Z', ...overrides };
}

describe('analyzeSports', () => {
  it('summarizes events', () => {
    const r = analyzeSports([event(), event({ sport: 'basketball' })]);
    expect(r.totalEvents).toBe(2);
    expect(Object.keys(r.sportCounts)).toHaveLength(2);
  });
  it('handles empty', () => { expect(analyzeSports([]).summary).toContain('No sports'); });
});

describe('buildSportsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildSportsPrompt([event()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Practice');
  });
});

describe('parseSportsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseSportsResponse('{"suggestions":["cross-train"],"scheduleTips":["avoid back-to-back"],"fitnessTip":"stay hydrated"}');
    expect(r.suggestions).toEqual(['cross-train']);
  });
  it('handles malformed', () => { expect(parseSportsResponse('bad').suggestions).toEqual([]); });
});
