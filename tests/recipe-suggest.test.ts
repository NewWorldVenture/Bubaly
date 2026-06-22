import { describe, it, expect } from 'vitest';
import { buildSuggestPrompt, parseSuggestions } from '@/lib/recipes/suggest';

const recipes = [
  { id: 'a', name: 'Tacos', cuisine: 'Mexican', tags: ['quick'], ingredients: [{ name: 'beef' }, { name: 'tortilla' }] },
  { id: 'b', name: 'Pad Thai', cuisine: 'Thai', ingredients: [{ name: 'noodles' }] },
];

describe('buildSuggestPrompt', () => {
  it('lists ids + names and JSON-only instruction; embeds constraint', () => {
    const p = buildSuggestPrompt(recipes, 'no dairy, quick');
    expect(p.system).toMatch(/ONLY valid JSON/);
    expect(p.user).toContain('id:a');
    expect(p.user).toContain('Tacos');
    expect(p.user).toContain('Constraint: no dairy, quick');
  });
  it('handles no constraint + empty vault', () => {
    const p = buildSuggestPrompt([], undefined);
    expect(p.user).toContain('No special constraint');
    expect(p.user).toContain('(none)');
  });
});

describe('parseSuggestions', () => {
  it('keeps only valid, de-duped ids', () => {
    const text = '{"picks":[{"id":"a","reason":"Fast & kid-friendly"},{"id":"zzz","reason":"x"},{"id":"a","reason":"dup"}]}';
    const picks = parseSuggestions(text, ['a', 'b']);
    expect(picks).toEqual([{ id: 'a', reason: 'Fast & kid-friendly' }]);
  });
  it('defaults a missing reason and returns [] on junk', () => {
    expect(parseSuggestions('{"picks":[{"id":"b"}]}', ['a', 'b'])).toEqual([{ id: 'b', reason: 'A great fit for tonight.' }]);
    expect(parseSuggestions('not json', ['a'])).toEqual([]);
  });
});
