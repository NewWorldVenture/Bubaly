import { describe, expect, it } from 'vitest';
import { analyzeYearbook, buildYearbookPrompt, parseYearbookResponse, type YearbookEntryForAI } from '@/lib/yearbook/yearbook-ai';

function entry(overrides: Partial<YearbookEntryForAI> = {}): YearbookEntryForAI {
  return { title: 'First day of school', category: 'milestone', entry_date: '2025-08-15', description: 'Starting 3rd grade!', ...overrides };
}

describe('analyzeYearbook', () => {
  it('summarizes yearbook data', () => {
    const r = analyzeYearbook(2, [entry(), entry({ category: 'holiday' })]);
    expect(r.totalYearbooks).toBe(2);
    expect(r.totalEntries).toBe(2);
    expect(Object.keys(r.categoryCounts)).toHaveLength(2);
  });
  it('handles empty', () => { expect(analyzeYearbook(0, []).summary).toContain('No yearbooks'); });
});

describe('buildYearbookPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildYearbookPrompt([entry()]);
    expect(system).toContain('JSON');
    expect(user).toContain('First day');
  });
});

describe('parseYearbookResponse', () => {
  it('parses valid JSON', () => {
    const r = parseYearbookResponse('{"suggestions":["add monthly photos"],"memoryTips":["interview grandparents"],"themeIdea":"seasons of growth"}');
    expect(r.suggestions).toEqual(['add monthly photos']);
  });
  it('handles malformed', () => { expect(parseYearbookResponse('bad').suggestions).toEqual([]); });
});
