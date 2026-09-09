// The grocery delta used to be arithmetic with no memory of the household: it
// would put peanut butter on the list of a family whose medical profile records
// a peanut allergy, and jasmine rice on the list of a family with brown rice in
// the cupboard.
//
// These cases pin the three rules and, more importantly, the honesty around
// them: EVERY swap carries a reason and a reason key, a swap is never made into
// something else the family also cannot eat, and where nothing is safe the line
// is dropped and says so rather than being silently replaced.
import { describe, expect, it } from 'vitest';
import {
  applySubstitutions, collectDietaryConstraints, describeSubstitutions,
  normalize, parseConstraintText,
} from '@/lib/meals/substitutions';

const items = (...names: string[]) => names.map((name) => ({ name }));
const names = (result: { items: { name: string }[] }) => result.items.map((i) => i.name);

describe('parseConstraintText', () => {
  it('splits a free-text allergy column into terms', () => {
    expect(parseConstraintText('Peanuts, tree nuts; shellfish and dairy'))
      .toEqual(['Peanuts', 'tree nuts', 'shellfish', 'dairy']);
  });

  it('drops severity words, parentheticals and "none"', () => {
    expect(parseConstraintText('severe peanut (anaphylaxis)')).toEqual(['peanut']);
    expect(parseConstraintText('None')).toEqual([]);
    expect(parseConstraintText('NKA')).toEqual([]);
    expect(parseConstraintText(null)).toEqual([]);
    expect(parseConstraintText('')).toEqual([]);
  });
});

describe('normalize', () => {
  it('treats case, punctuation and a trailing plural as non-differences', () => {
    expect(normalize('Peanut Butter')).toBe('peanut butter');
    expect(normalize('eggs')).toBe(normalize('Egg'));
    expect(normalize('  oat   milk ')).toBe('oat milk');
  });
});

describe('allergies', () => {
  it('swaps peanut butter for a safe spread and says why', () => {
    const result = applySubstitutions(items('peanut butter', 'bread'), { allergies: ['peanuts'] });
    expect(names(result)).toEqual(['sunflower seed butter', 'bread']);
    const swap = result.substitutions[0];
    expect(swap).toMatchObject({
      from: 'peanut butter', to: 'sunflower seed butter', kind: 'allergy', reasonKey: 'allergySwap',
    });
    expect(swap.trigger).toBe('peanuts');
    expect(swap.reason).toContain('peanut');
    expect(swap.reason.length).toBeGreaterThan(10);
  });

  it('keeps the part of the name that is not the allergen', () => {
    const result = applySubstitutions(items('shredded cheddar cheese'), { allergies: ['dairy'] });
    expect(names(result)).toEqual(['shredded dairy-free cheddar']);
  });

  it('drops a line when there is no safe swap, and says it was dropped', () => {
    const result = applySubstitutions(items('shrimp', 'rice'), { allergies: ['shellfish'] });
    expect(names(result)).toEqual(['rice']);
    expect(result.substitutions[0]).toMatchObject({
      from: 'shrimp', to: null, kind: 'allergy', reasonKey: 'allergyDropped',
    });
    expect(result.substitutions[0].reason).toContain('No safe swap');
  });

  it('never swaps into something the family is ALSO allergic to', () => {
    // A dairy allergy would send milk to oat milk; a tree-nut allergy sends
    // almond milk to oat milk too. Neither may land on almond milk.
    const result = applySubstitutions(items('almond milk'), { allergies: ['tree nuts', 'dairy'] });
    expect(names(result)).toEqual(['oat milk']);
    expect(result.substitutions[0].to).toBe('oat milk');
  });

  it('leaves an item the plan already spelled safely exactly as written', () => {
    const result = applySubstitutions(items('gluten-free bread', 'oat milk', 'flax egg'), {
      allergies: ['gluten', 'dairy', 'egg'],
    });
    expect(names(result)).toEqual(['gluten-free bread', 'oat milk', 'flax egg']);
    expect(result.substitutions).toEqual([]);
  });

  it('leaves everything alone when the family records no allergy', () => {
    const result = applySubstitutions(items('peanut butter', 'shrimp', 'milk'), {});
    expect(names(result)).toEqual(['peanut butter', 'shrimp', 'milk']);
    expect(result.substitutions).toEqual([]);
  });

  it('an allergy the table does not know changes nothing rather than guessing', () => {
    const result = applySubstitutions(items('kiwi'), { allergies: ['kiwi'] });
    expect(names(result)).toEqual(['kiwi']);
    expect(result.substitutions).toEqual([]);
  });

  it('a nut or fruit butter is not dairy, whatever the word at the end says', () => {
    // `butter` is a whole-word match, so a bare substring rule rewrote every
    // spread whose name merely ends in it: "peanut olive oil" went on the list
    // of a family that is only allergic to dairy, with a reason that said
    // peanut butter contains butter.
    const result = applySubstitutions(
      items('peanut butter', 'apple butter', 'cocoa butter', 'butter lettuce'),
      { allergies: ['dairy'] },
    );
    expect(names(result)).toEqual(['peanut butter', 'apple butter', 'cocoa butter', 'butter lettuce']);
    expect(result.substitutions).toEqual([]);
  });

  it('still swaps the butter that IS dairy', () => {
    const result = applySubstitutions(items('butter', 'unsalted butter'), { allergies: ['dairy'] });
    expect(names(result)).toEqual(['olive oil', 'unsalted olive oil']);
  });

  it('a nut butter survives a household allergic to both peanuts and dairy', () => {
    // The safe spread is a SEED butter, and reading "butter" in it as dairy
    // dropped the line: the family got no spread at all and a message saying
    // there was no safe swap.
    const result = applySubstitutions(items('peanut butter'), { allergies: ['peanut', 'dairy'] });
    expect(names(result)).toEqual(['sunflower seed butter']);
    expect(result.substitutions[0]).toMatchObject({ to: 'sunflower seed butter', reasonKey: 'allergySwap' });
  });

  it('does not keep the allergen in the modifier it left standing', () => {
    // Rewriting only the matched span left "whole wheat gluten-free bread" —
    // wheat bread that is also gluten-free, on a coeliac household's list.
    const result = applySubstitutions(
      items('whole wheat bread', 'wheat pasta', 'whole wheat flour'),
      { allergies: ['gluten'] },
    );
    expect(names(result)).toEqual(['gluten-free bread', 'gluten-free pasta', 'gluten-free flour']);
    for (const swap of result.substitutions) {
      expect(swap.to).not.toMatch(/wheat/i);
      expect(swap.reasonKey).toBe('allergySwap');
    }
  });

  it('gluten reaches pasta, bread and flour, each with a reason', () => {
    const result = applySubstitutions(items('spaghetti', 'bread', 'all-purpose flour'), { allergies: ['gluten'] });
    expect(names(result)).toEqual(['gluten-free spaghetti', 'gluten-free bread', 'gluten-free flour']);
    expect(result.substitutions).toHaveLength(3);
    expect(result.substitutions.every((s) => s.reason.trim().length > 0)).toBe(true);
    expect(result.substitutions.every((s) => s.reasonKey === 'allergySwap')).toBe(true);
  });
});

describe('dislikes', () => {
  it('swaps inside the ingredient family rather than dropping the line', () => {
    const result = applySubstitutions(items('cilantro'), { dislikes: ['cilantro'] });
    expect(names(result)).toEqual(['parsley']);
    expect(result.substitutions[0]).toMatchObject({ kind: 'dislike', reasonKey: 'dislikeSwap', trigger: 'cilantro' });
  });

  it('drops the line only when the family has no equivalent', () => {
    const result = applySubstitutions(items('anchovy paste'), { dislikes: ['anchovy paste'] });
    expect(names(result)).toEqual([]);
    expect(result.substitutions[0]).toMatchObject({ to: null, kind: 'dislike', reasonKey: 'dislikeDropped' });
  });

  it('does not swap into another disliked member of the same family', () => {
    const result = applySubstitutions(items('cilantro'), { dislikes: ['cilantro', 'parsley'] });
    expect(names(result)).toEqual(['basil']);
  });

  it('an allergy is settled before a dislike, so the swap is the safe one', () => {
    const result = applySubstitutions(items('whole milk'), { allergies: ['dairy'], dislikes: ['whole milk'] });
    expect(result.substitutions[0].kind).toBe('allergy');
    expect(names(result)).toEqual(['oat milk']);
  });
});

describe('pantry preference', () => {
  it('uses the stocked member of the family instead of buying a near-identical one', () => {
    const result = applySubstitutions(items('jasmine rice', 'chicken breast'), {
      pantry: [{ name: 'brown rice', quantity: 2 }],
    });
    expect(names(result)).toEqual(['chicken breast']);
    expect(result.substitutions[0]).toMatchObject({
      from: 'jasmine rice', to: 'brown rice', kind: 'pantry', reasonKey: 'pantrySwap', trigger: 'brown rice',
    });
    expect(result.substitutions[0].reason).toContain('brown rice');
  });

  it('ignores a pantry row with no stock — an empty bag is not a substitute', () => {
    const result = applySubstitutions(items('jasmine rice'), { pantry: [{ name: 'brown rice', quantity: 0 }] });
    expect(names(result)).toEqual(['jasmine rice']);
    expect(result.substitutions).toEqual([]);
  });

  it('does not prefer a pantry item the family is allergic to', () => {
    const result = applySubstitutions(items('oat milk'), {
      allergies: ['tree nuts'],
      pantry: [{ name: 'almond milk', quantity: 1 }],
    });
    expect(names(result)).toEqual(['oat milk']);
    expect(result.substitutions).toEqual([]);
  });
});

describe('merging', () => {
  it('two lines that become the same thing merge, keeping both quantities', () => {
    const result = applySubstitutions(
      [{ name: 'whole milk', quantity: '1 gal' }, { name: 'heavy cream', quantity: '1 cup' }],
      { allergies: ['dairy'] },
    );
    // whole milk → oat milk, heavy cream → coconut cream: distinct lines.
    expect(names(result)).toEqual(['oat milk', 'coconut cream']);

    const merged = applySubstitutions(
      [{ name: 'milk', quantity: '1 gal' }, { name: 'whole milk', quantity: '2 cups' }],
      { allergies: ['milk'] },
    );
    expect(names(merged)).toEqual(['oat milk']);
    expect(merged.items[0].quantity).toBe('1 gal + 2 cups');
  });

  it('carries the source meal through a swap so the list still says which dish it is for', () => {
    const result = applySubstitutions(
      [{ name: 'peanut butter', quantity: '1 jar', sourceMealId: 'meal-9' }],
      { allergies: ['peanut'] },
    );
    expect(result.items[0]).toMatchObject({ name: 'sunflower seed butter', quantity: '1 jar', sourceMealId: 'meal-9' });
  });

  it('drops blank names and returns an empty list without complaint', () => {
    expect(applySubstitutions([{ name: '   ' }], {}).items).toEqual([]);
    expect(applySubstitutions([], {}).substitutions).toEqual([]);
  });
});

describe('collectDietaryConstraints', () => {
  it('folds medical profiles and family facts into one pair of lists', () => {
    const { allergies, dislikes } = collectDietaryConstraints({
      profiles: [{ allergies: 'Peanuts, dairy' }, { allergies: 'peanuts' }, { allergies: null }],
      facts: [
        { category: 'medical', label: 'Allergy', value: 'Shellfish' },
        { category: 'preference', label: 'Foods nobody eats', value: 'olives' },
        { category: 'preference', label: 'Dislikes', value: 'cilantro' },
        { category: 'important', label: 'Pediatrician', value: 'Dr. Lee' },
      ],
    });
    expect(allergies).toEqual(['Peanuts', 'dairy', 'Shellfish']);
    expect(dislikes).toEqual(['olives', 'cilantro']);
  });

  it('an unrelated fact is neither an allergy nor a dislike', () => {
    const { allergies, dislikes } = collectDietaryConstraints({
      facts: [{ category: 'other', label: 'Shoe size', value: 'US 2' }],
    });
    expect(allergies).toEqual([]);
    expect(dislikes).toEqual([]);
  });

  it('nothing recorded means nothing constrained', () => {
    expect(collectDietaryConstraints({})).toEqual({ allergies: [], dislikes: [] });
  });
});

describe('describeSubstitutions', () => {
  it('is null when nothing was swapped', () => {
    expect(describeSubstitutions([])).toBeNull();
  });

  it('reads as one line naming both the swap and the drop', () => {
    const { substitutions } = applySubstitutions(items('peanut butter', 'shrimp'), {
      allergies: ['peanut', 'shellfish'],
    });
    const line = describeSubstitutions(substitutions);
    expect(line).toContain('peanut butter → sunflower seed butter');
    expect(line).toContain('shrimp → left off');
  });
});
