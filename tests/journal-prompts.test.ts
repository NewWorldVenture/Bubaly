import { describe, it, expect } from 'vitest';
import {
  REFLECTION_PROMPTS, dayOfYear, promptOfTheDay, buildJournalPrompt, parseJournalPrompt,
} from '@/lib/journal/prompts';

describe('promptOfTheDay', () => {
  it('is stable for a given day and within the prompt set', () => {
    const d = new Date('2026-06-24T15:00:00Z');
    const p = promptOfTheDay(d);
    expect(REFLECTION_PROMPTS).toContain(p);
    expect(promptOfTheDay(new Date('2026-06-24T23:00:00Z'))).toBe(p); // same calendar day
  });
  it('rotates across days', () => {
    const a = promptOfTheDay(new Date('2026-06-24T12:00:00Z'));
    const b = promptOfTheDay(new Date('2026-06-25T12:00:00Z'));
    expect(a).not.toBe(b);
  });
});

describe('dayOfYear', () => {
  it('is 1 on Jan 1 and increments', () => {
    expect(dayOfYear(new Date('2026-01-01T00:00:00Z'))).toBe(1);
    expect(dayOfYear(new Date('2026-01-02T00:00:00Z'))).toBe(2);
  });
});

describe('buildJournalPrompt', () => {
  it('embeds recent snippets and asks for one question', () => {
    const { system, user } = buildJournalPrompt([{ mood: 'good', snippet: 'Had a great walk' }]);
    expect(system).toMatch(/ONE short reflective question/);
    expect(user).toContain('Had a great walk');
  });
  it('handles no entries', () => {
    expect(buildJournalPrompt([]).user).toContain('(no entries yet)');
  });
});

describe('parseJournalPrompt', () => {
  it('strips quotes, numbering, and extra lines', () => {
    expect(parseJournalPrompt('"What made you smile today?"')).toBe('What made you smile today?');
    expect(parseJournalPrompt('1. What are you grateful for?')).toBe('What are you grateful for?');
    expect(parseJournalPrompt('\n\nWhat is on your mind?\nextra')).toBe('What is on your mind?');
  });
  it('returns empty on empty input', () => {
    expect(parseJournalPrompt('')).toBe('');
  });
});
