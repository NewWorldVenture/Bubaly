import { describe, expect, it } from 'vitest';
import { analyzeTripMemories, buildTripMemoriesPrompt, parseTripMemoriesResponse, type TripMemoryForAI } from '@/lib/trip-memories/trip-memories-ai';

function memory(overrides: Partial<TripMemoryForAI> = {}): TripMemoryForAI {
  return { title: 'Beach sunset', location: 'Hawaii', memory_date: '2025-06-15', note: 'Amazing sunset at Waikiki', ...overrides };
}

describe('analyzeTripMemories', () => {
  it('summarizes memories', () => {
    const r = analyzeTripMemories([memory(), memory({ location: 'Paris' })]);
    expect(r.totalMemories).toBe(2);
    expect(Object.keys(r.locationCounts)).toHaveLength(2);
  });
  it('handles empty', () => { expect(analyzeTripMemories([]).summary).toContain('No trip'); });
});

describe('buildTripMemoriesPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildTripMemoriesPrompt([memory()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Beach sunset');
  });
});

describe('parseTripMemoriesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseTripMemoriesResponse('{"suggestions":["create a photo book"],"travelTips":["travel off-season"],"memoryIdea":"write journal entries"}');
    expect(r.suggestions).toEqual(['create a photo book']);
  });
  it('handles malformed', () => { expect(parseTripMemoriesResponse('bad').suggestions).toEqual([]); });
});
