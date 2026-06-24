import { describe, it, expect } from 'vitest';
import { buildCoachPrompt, parseCoachResponse, type HabitStat } from '@/lib/habits/ai';

const stats: HabitStat[] = [
  { title: 'Morning run', cadence: 'daily', currentStreak: 5, longestStreak: 12, completionRate: 0.8, doneToday: true },
  { title: 'Read', cadence: 'daily', currentStreak: 0, longestStreak: 4, completionRate: 0.3, doneToday: false },
];

describe('buildCoachPrompt', () => {
  it('embeds the name and per-habit numbers, asks for JSON', () => {
    const { system, user } = buildCoachPrompt(stats, 'Ada');
    expect(system).toContain('STRUCTURED JSON');
    expect(user).toContain('Ada');
    expect(user).toContain('Morning run');
    expect(user).toContain('80% last 30d');
    expect(user).toContain('streak 5');
  });
  it('handles an empty habit list', () => {
    expect(buildCoachPrompt([], 'Sam').user).toContain('(no habits yet)');
  });
});

describe('parseCoachResponse', () => {
  it('parses a clean object', () => {
    const raw = JSON.stringify({ headline: 'Great work, Ada!', nudges: ['Keep running', 'Try reading at night'], suggestion: 'Add a stretch habit' });
    expect(parseCoachResponse(raw)).toEqual({
      headline: 'Great work, Ada!',
      nudges: ['Keep running', 'Try reading at night'],
      suggestion: 'Add a stretch habit',
    });
  });
  it('strips code fences and prose', () => {
    const raw = 'Sure!\n```json\n{"headline":"Hi","nudges":["a"],"suggestion":""}\n```';
    expect(parseCoachResponse(raw).headline).toBe('Hi');
  });
  it('caps nudges at 4 and drops empties', () => {
    const raw = JSON.stringify({ headline: 'h', nudges: ['a', '', 'b', 'c', 'd', 'e'], suggestion: 's' });
    expect(parseCoachResponse(raw).nudges).toEqual(['a', 'b', 'c', 'd']);
  });
  it('returns empty shape on malformed input', () => {
    expect(parseCoachResponse('nope')).toEqual({ headline: '', nudges: [], suggestion: '' });
  });
});
