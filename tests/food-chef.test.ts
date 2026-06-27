import { describe, it, expect } from 'vitest';
import {
  buildChefSystem, buildChefUser, parseChefReply, planCostCents, fallbackChefReply, type ChefContext,
} from '@/lib/food/chef';

describe('buildChefUser', () => {
  it('grounds the prompt in real family context', () => {
    const ctx: ChefContext = {
      request: 'Plan dinners this week under $150',
      dietary: ['vegetarian', 'no peanuts'],
      weeklyBudget: 150,
      busyNights: ['Tue: soccer 6pm', 'Thu: dance 5pm'],
      expiringItems: ['spinach', 'mushrooms'],
      leftovers: ['roast chicken'],
      recipeNames: ['Veggie chili', 'Pasta primavera'],
      window: 'this week (Mon–Sun)',
    };
    const user = buildChefUser(ctx);
    expect(user).toContain('under $150');
    expect(user).toContain('vegetarian, no peanuts');
    expect(user).toContain('$150');
    expect(user).toContain('soccer');
    expect(user).toContain('spinach');
    expect(user).toContain('roast chicken');
    expect(user).toContain('Veggie chili');
  });
  it('system prompt enforces constraints + JSON', () => {
    const s = buildChefSystem();
    expect(s).toContain('strictly');
    expect(s).toContain('JSON');
    expect(s).toContain('usesExpiring');
  });
});

describe('parseChefReply', () => {
  it('parses a valid plan', () => {
    const text = JSON.stringify({
      message: 'A quick, budget-friendly week.',
      meals: [
        { day: 'Mon', mealType: 'dinner', dish: 'Veggie chili', reason: 'Uses spinach', quick: true, usesExpiring: true, estCostCents: 1100 },
        { day: 'Tue', mealType: 'dinner', dish: 'Crockpot curry', reason: 'Busy soccer night', quick: true, usesExpiring: false, estCostCents: 1400 },
      ],
      groceryAdds: ['coconut milk', 'rice'],
      tips: ['Prep veggies Sunday.'],
    });
    const r = parseChefReply(text)!;
    expect(r.meals).toHaveLength(2);
    expect(r.meals[0].dish).toBe('Veggie chili');
    expect(r.meals[0].usesExpiring).toBe(true);
    expect(r.groceryAdds).toContain('rice');
    expect(planCostCents(r.meals)).toBe(2500);
  });
  it('extracts JSON wrapped in markdown fences', () => {
    const text = '```json\n{"message":"hi","meals":[{"day":"Mon","mealType":"dinner","dish":"Tacos","reason":"fast","quick":true,"usesExpiring":false}],"groceryAdds":[],"tips":[]}\n```';
    const r = parseChefReply(text)!;
    expect(r.meals[0].dish).toBe('Tacos');
  });
  it('drops meals without a dish; returns null on junk', () => {
    expect(parseChefReply('not json')).toBeNull();
    const r = parseChefReply(JSON.stringify({ message: 'x', meals: [{ day: 'Mon', reason: 'y' }], groceryAdds: [], tips: [] }))!;
    expect(r.meals).toHaveLength(0);
  });
});

describe('fallbackChefReply', () => {
  it('builds a plan from leftovers + expiring + saved recipes', () => {
    const r = fallbackChefReply({
      request: 'plan dinners', leftovers: ['chicken'], expiringItems: ['spinach'],
      recipeNames: ['Chili', 'Stir fry'], busyNights: ['Tue: soccer'],
    });
    expect(r.meals.length).toBeGreaterThan(0);
    expect(r.meals[0].dish).toContain('chicken'); // leftovers first
    expect(r.meals[0].usesExpiring).toBe(true);
  });
  it('degrades gracefully with no data', () => {
    const r = fallbackChefReply({ request: 'plan dinners' });
    expect(r.meals).toHaveLength(0);
    expect(r.message).toContain('Add a few recipes');
  });
});
