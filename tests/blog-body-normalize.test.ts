import { describe, it, expect } from 'vitest';
import { normalizeBody, extractHeadings, estimateReadingTime, type BlogBlock } from '@/lib/blog/posts';

describe('normalizeBody', () => {
  it('passes through a clean block array (coercing type)', () => {
    const blocks = [{ type: 'h2', text: 'Heading' }, { type: 'p', text: 'Body' }, { type: 'weird', text: 'Para' }];
    expect(normalizeBody(blocks)).toEqual([
      { type: 'h2', text: 'Heading' }, { type: 'p', text: 'Body' }, { type: 'p', text: 'Para' },
    ]);
  });
  it('maps an array of strings to paragraphs', () => {
    expect(normalizeBody(['one', '  ', 'two'])).toEqual([{ type: 'p', text: 'one' }, { type: 'p', text: 'two' }]);
  });
  it('parses a JSON-encoded array string (the seed-data crash case)', () => {
    const json = JSON.stringify([{ type: 'h2', text: 'H' }, { type: 'p', text: 'P' }]);
    expect(normalizeBody(json)).toEqual([{ type: 'h2', text: 'H' }, { type: 'p', text: 'P' }]);
  });
  it('treats a plain-text string as paragraph blocks (split on blank lines)', () => {
    expect(normalizeBody('First para.\n\nSecond para.')).toEqual([
      { type: 'p', text: 'First para.' }, { type: 'p', text: 'Second para.' },
    ]);
  });
  it('accepts {content} objects', () => {
    expect(normalizeBody([{ content: 'hi' }])).toEqual([{ type: 'p', text: 'hi' }]);
  });
  it('returns [] for null / object / number (never throws)', () => {
    expect(normalizeBody(null)).toEqual([]);
    expect(normalizeBody({ foo: 'bar' })).toEqual([]);
    expect(normalizeBody(42)).toEqual([]);
    expect(normalizeBody('')).toEqual([]);
  });
});

describe('extractHeadings / estimateReadingTime are array-safe', () => {
  it('handle a non-array body without throwing', () => {
    expect(extractHeadings('nope' as unknown as BlogBlock[])).toEqual([]);
    expect(estimateReadingTime(undefined as unknown as BlogBlock[])).toBe(1);
  });
  it('extract h2 headings with slug ids', () => {
    expect(extractHeadings(normalizeBody([{ type: 'h2', text: 'Hello World!' }]))).toEqual([
      { id: 'hello-world', text: 'Hello World!' },
    ]);
  });
});
