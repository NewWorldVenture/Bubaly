// `applySubstitutions` is what stands between the week's dishes and the
// family's shopping list. It screened a line through `findAllergyHit`, which
// had two holes the module's own `allergenConflict` does not have:
//
//   1. It matched through `normalize`, which drops a plural only from the LAST
//      word of the whole name. "Peanuts, salted" normalises to "peanuts salted",
//      which mentions neither "peanut" nor "peanuts", so it went on the list of
//      a household with a peanut allergy.
//   2. It looked only for the INGREDIENTS in a rule's swap table, never the
//      words that switch the rule on. "mixed nuts" names no almond, "fish
//      fillets" names no salmon, so both passed under the matching allergy.
//
// Every case here goes through the real function with no stubs.
import { describe, expect, it } from 'vitest';
import { applySubstitutions } from '@/lib/meals/substitutions';

const items = (...names: string[]) => names.map((name) => ({ name }));
const names = (result: { items: { name: string }[] }) => result.items.map((i) => i.name);

describe('a plural anywhere in the name is still the allergen', () => {
  it.each([
    ['Peanuts, salted', 'peanut', 'roasted sunflower seeds, salted'],
    ['Eggs, large', 'egg', 'flax eggs, large'],
    ['almonds sliced', 'almond', 'pumpkin seeds sliced'],
  ])('%s under a %s allergy is swapped, not passed through', (name, allergy, safe) => {
    const result = applySubstitutions(items(name, 'rice'), { allergies: [allergy] });
    expect(names(result)).toEqual([safe, 'rice']);
    expect(result.substitutions).toEqual([
      expect.objectContaining({ from: name, to: safe, kind: 'allergy', trigger: allergy, reasonKey: 'allergySwap' }),
    ]);
  });

  it('drops "Prawns, peeled" under a shellfish allergy, where no swap exists', () => {
    const result = applySubstitutions(items('Prawns, peeled', 'rice'), { allergies: ['shellfish'] });
    expect(names(result)).toEqual(['rice']);
    expect(result.substitutions).toEqual([
      expect.objectContaining({ from: 'Prawns, peeled', to: null, kind: 'allergy', reasonKey: 'allergyDropped' }),
    ]);
  });
});

describe("a line that names the allergy itself is left off, though no swap-table ingredient is in it", () => {
  it.each([
    ['mixed nuts', 'tree nuts'],
    ['fish fillets', 'fish'],
    ['sesame bagel', 'sesame'],
    ['soy protein', 'soy'],
    ['shellfish stock', 'shellfish'],
    ['wheat crackers', 'wheat'],
    ['Soybeans, dried', 'soy'],
    ['groundnut stew base', 'peanuts'],
  ])('%s under a %s allergy', (name, allergy) => {
    const result = applySubstitutions(items(name, 'rice'), { allergies: [allergy] });
    expect(names(result)).toEqual(['rice']);
    expect(result.substitutions).toHaveLength(1);
    const dropped = result.substitutions[0];
    expect(dropped).toMatchObject({ from: name, to: null, kind: 'allergy', trigger: allergy, reasonKey: 'allergyDropped' });
    // The reason names what was read in the line, in words a person can check.
    expect(dropped.reason).toContain(name);
    expect(dropped.reason).toContain(`${allergy} allergy`);
  });

  it('still prefers a real swap to dropping: wheat bread becomes gluten-free bread', () => {
    const result = applySubstitutions(items('whole wheat bread'), { allergies: ['wheat'] });
    expect(names(result)).toEqual(['gluten-free bread']);
  });

  it('does not read the allergy into a word that only contains it, or into a name that says it is free of it', () => {
    const result = applySubstitutions(
      items('nutmeg', 'butternut squash', 'coconut', 'buckwheat groats', 'eggplant', 'nut-free granola', 'sesame-free hummus', 'goldfish crackers'),
      { allergies: ['tree nuts', 'wheat', 'egg', 'sesame', 'fish'] },
    );
    expect(names(result)).toEqual(
      ['nutmeg', 'butternut squash', 'coconut', 'buckwheat groats', 'eggplant', 'nut-free granola', 'sesame-free hummus', 'goldfish crackers']);
    expect(result.substitutions).toEqual([]);
  });

  it('does not screen for an allergy the household does not record', () => {
    const result = applySubstitutions(items('mixed nuts', 'fish fillets'), { allergies: ['egg'] });
    expect(names(result)).toEqual(['mixed nuts', 'fish fillets']);
    expect(result.substitutions).toEqual([]);
  });
});

describe('a swap made for one allergy does not carry another allergen onto the list', () => {
  it('sesame spaghetti under gluten and sesame allergies is dropped, not rewritten to "sesame gluten-free spaghetti"', () => {
    const result = applySubstitutions(items('sesame spaghetti', 'rice'), { allergies: ['gluten', 'sesame'] });
    expect(names(result)).toEqual(['rice']);
    expect(result.substitutions).toEqual([
      expect.objectContaining({ from: 'sesame spaghetti', to: null, kind: 'allergy', trigger: 'sesame', reasonKey: 'allergyDropped' }),
    ]);
  });

  it('a swap whose result is safe for every recorded allergy still goes through', () => {
    const result = applySubstitutions(items('almond milk', 'peanut butter'), { allergies: ['tree nuts', 'dairy', 'peanuts'] });
    expect(names(result)).toEqual(['oat milk', 'sunflower seed butter']);
  });
});
