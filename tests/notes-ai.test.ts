import { describe, it, expect } from 'vitest';
import {
  buildNotesPrompt,
  parseNotesResponse,
  clampNoteContent,
  formatInsightsForNote,
} from '@/lib/notes/ai';

describe('clampNoteContent', () => {
  it('trims whitespace', () => {
    expect(clampNoteContent('  hello  ')).toBe('hello');
  });
  it('caps overly long content', () => {
    expect(clampNoteContent('x'.repeat(100), 10)).toHaveLength(10);
  });
  it('handles nullish input', () => {
    expect(clampNoteContent(undefined as unknown as string)).toBe('');
  });
});

describe('buildNotesPrompt', () => {
  it('embeds the note content and asks for JSON', () => {
    const { system, user } = buildNotesPrompt('Buy milk and call the dentist');
    expect(system).toContain('STRUCTURED JSON');
    expect(system).toContain('"summary"');
    expect(user).toContain('Buy milk and call the dentist');
  });
});

describe('parseNotesResponse', () => {
  it('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      summary: 'Errands for the weekend.',
      actionItems: ['Buy milk', 'Call dentist'],
      tags: ['errands', 'health'],
    });
    expect(parseNotesResponse(raw)).toEqual({
      summary: 'Errands for the weekend.',
      actionItems: ['Buy milk', 'Call dentist'],
      tags: ['errands', 'health'],
    });
  });

  it('extracts JSON wrapped in code fences and prose', () => {
    const raw = 'Here you go:\n```json\n{"summary":"S","actionItems":[],"tags":["a"]}\n```\nDone.';
    const out = parseNotesResponse(raw);
    expect(out.summary).toBe('S');
    expect(out.tags).toEqual(['a']);
  });

  it('normalizes tags (lowercase, strips #, dedupes, spaces to dashes)', () => {
    const raw = JSON.stringify({
      summary: 'x',
      actionItems: [],
      tags: ['#School', 'school', 'Back To School', 'Health!'],
    });
    expect(parseNotesResponse(raw).tags).toEqual(['school', 'back-to-school', 'health']);
  });

  it('drops empty action items and caps the list', () => {
    const raw = JSON.stringify({
      summary: 's',
      actionItems: ['a', '', '  ', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      tags: [],
    });
    expect(parseNotesResponse(raw).actionItems).toHaveLength(8);
  });

  it('returns an empty shape for malformed input', () => {
    expect(parseNotesResponse('not json at all')).toEqual({ summary: '', actionItems: [], tags: [] });
    expect(parseNotesResponse('')).toEqual({ summary: '', actionItems: [], tags: [] });
    expect(parseNotesResponse('{bad json')).toEqual({ summary: '', actionItems: [], tags: [] });
  });
});

describe('formatInsightsForNote', () => {
  it('renders summary, checklist action items, and tags', () => {
    const out = formatInsightsForNote({
      summary: 'Weekend errands.',
      actionItems: ['Buy milk', 'Call dentist'],
      tags: ['errands', 'health'],
    });
    expect(out).toContain('🪄 AI summary');
    expect(out).toContain('Weekend errands.');
    expect(out).toContain('[ ] Buy milk');
    expect(out).toContain('Tags: #errands #health');
  });

  it('omits empty sections gracefully', () => {
    const out = formatInsightsForNote({ summary: 'Just a thought.', actionItems: [], tags: [] });
    expect(out).toContain('Just a thought.');
    expect(out).not.toContain('Action items:');
    expect(out).not.toContain('Tags:');
  });
});
