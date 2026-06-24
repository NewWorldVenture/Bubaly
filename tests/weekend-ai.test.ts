import { describe, expect, it } from 'vitest';
import { analyzeWeekend, buildWeekendPrompt, parseWeekendResponse, type WeekendEventForAI } from '@/lib/weekend/weekend-ai';

function event(overrides: Partial<WeekendEventForAI> = {}): WeekendEventForAI {
  return { title: 'Family Movie Night', category: 'entertainment', venue_name: 'AMC Theater', city: 'Austin', starts_at: '2025-07-05T19:00:00Z', is_family_friendly: true, ...overrides };
}

describe('analyzeWeekend', () => {
  it('summarizes events', () => {
    const r = analyzeWeekend([event(), event({ category: 'sports' })], 1);
    expect(r.totalEvents).toBe(2);
    expect(r.totalPlans).toBe(1);
  });
  it('handles empty', () => { expect(analyzeWeekend([], 0).summary).toContain('No weekend'); });
});

describe('buildWeekendPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildWeekendPrompt([event()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Movie Night');
  });
});

describe('parseWeekendResponse', () => {
  it('parses valid JSON', () => {
    const r = parseWeekendResponse('{"suggestions":["try local parks"],"activityTips":["pack snacks"],"familyIdea":"scavenger hunt"}');
    expect(r.suggestions).toEqual(['try local parks']);
  });
  it('handles malformed', () => { expect(parseWeekendResponse('bad').suggestions).toEqual([]); });
});
