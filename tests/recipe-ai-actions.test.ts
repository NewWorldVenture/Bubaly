import { describe, it, expect } from 'vitest';
import { RECIPE_AI_ACTIONS, getRecipeAiAction, buildTransformPrompt, parseTransformResult } from '@/lib/recipes/ai-actions';

const recipe = {
  name: 'Mac & Cheese', cuisine: 'American', servings: 4,
  ingredients: [{ name: 'pasta', quantity: '1', unit: 'lb' }, { name: 'cheddar', quantity: '2', unit: 'cups' }],
  instructions: [{ step: 1, text: 'Boil pasta.' }, { step: 2, text: 'Add cheese.' }],
  allergyFlags: ['Dairy'],
};

describe('action catalog', () => {
  it('includes the key transforms', () => {
    const ids = RECIPE_AI_ACTIONS.map((a) => a.id);
    for (const id of ['healthier', 'cheaper', 'higher_protein', 'lower_sodium', 'gluten_free', 'vegan', 'liver_friendly']) {
      expect(ids).toContain(id);
    }
    expect(getRecipeAiAction('nope')).toBeUndefined();
  });
});

describe('buildTransformPrompt', () => {
  it('embeds the recipe + a JSON-only instruction', () => {
    const p = buildTransformPrompt(recipe, 'healthier')!;
    expect(p.system).toMatch(/ONLY valid JSON/);
    expect(p.system).toMatch(/do not claim/i);
    expect(p.user).toContain('Mac & Cheese');
    expect(p.user).toContain('pasta');
    expect(p.user).toContain('Dairy');
  });
  it('returns null for unknown action', () => {
    // @ts-expect-error testing invalid id
    expect(buildTransformPrompt(recipe, 'bogus')).toBeNull();
  });
});

describe('parseTransformResult', () => {
  it('parses JSON and appends disclaimers (health action adds medical disclaimer)', () => {
    const text = 'sure! {"name":"Lighter Mac","description":"d","ingredients":[{"name":"whole wheat pasta","quantity":"1","unit":"lb"}],"instructions":[{"step":1,"text":"Boil."}],"notes":"Used whole wheat.","tags":["healthy"]}';
    const r = parseTransformResult(text, 'healthier')!;
    expect(r.name).toBe('Lighter Mac');
    expect(r.ingredients).toHaveLength(1);
    expect(r.instructions[0].text).toBe('Boil.');
    expect(r.notes).toMatch(/estimates/i);
    expect(r.notes).toMatch(/not medical/i);
  });
  it('non-health action omits the medical disclaimer but keeps the estimate note', () => {
    const r = parseTransformResult('{"name":"X","ingredients":[],"instructions":[]}', 'gluten_free')!;
    expect(r.notes).toMatch(/estimates/i);
    expect(r.notes).not.toMatch(/not medical/i);
  });
  it('returns null on unparseable or nameless output', () => {
    expect(parseTransformResult('no json here', 'healthier')).toBeNull();
    expect(parseTransformResult('{"description":"x"}', 'healthier')).toBeNull();
  });
});
