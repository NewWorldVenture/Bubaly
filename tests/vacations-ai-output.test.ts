import { describe, expect, it } from 'vitest';
import { parseVacationAIOutput, VACATION_AI_OUTPUT_LIMITS as limits } from '@/lib/vacations/ai-output';
import { BUDGET_CATEGORIES, DAY_PARTS, ITEM_KINDS } from '@/lib/vacations/meta';

const parse = (value: unknown, days = 3) => parseVacationAIOutput(JSON.stringify(value), days);

describe('vacation AI output schema', () => {
  it('preserves optional sections, nullable activity fields, and itinerary defaults', () => {
    expect(parse({})).toEqual({ activities: [], itinerary: [], budget: [] });
    expect(parse({ activities: [{ name: 'Park', category: null, location: null, family_friendly: null, cost: null }] })?.activities[0])
      .toEqual({ name: 'Park', category: null, location: null, family_friendly: null, cost: null });
    expect(parse({ itinerary: [{ day: 3, title: 'Rest' }] })?.itinerary[0])
      .toEqual({ day: 3, title: 'Rest', day_part: 'morning', kind: 'activity' });
  });

  it('accepts bounded JSON with an optional single markdown fence', () => {
    expect(parseVacationAIOutput('```json\n{"activities":[{"name":"Park"}]}\n```', 3)?.activities).toEqual([{ name: 'Park' }]);
  });

  it.each(BUDGET_CATEGORIES)('accepts real budget category $value', ({ value }) => {
    expect(parse({ budget: [{ category: value, planned: 12.5 }] })?.budget[0].category).toBe(value);
  });
  it.each(DAY_PARTS)('accepts real day part $value', ({ value }) => {
    expect(parse({ itinerary: [{ day: 1, title: 'Rest', day_part: value }] })?.itinerary[0].day_part).toBe(value);
  });
  it.each(ITEM_KINDS)('accepts real itinerary kind $value', ({ value }) => {
    expect(parse({ itinerary: [{ day: 1, title: 'Rest', kind: value }] })?.itinerary[0].kind).toBe(value);
  });

  it.each([null, [], [{ activities: [] }], true, 2, 'plan'])('rejects a non-object plan: %j', (value) => {
    expect(parse(value)).toBeNull();
  });

  it.each([
    { activities: null }, { itinerary: {} }, { budget: 'food' },
    { activities: [null] }, { activities: [[]] }, { activities: [{ name: {} }] },
    { activities: [{ name: ' ' }] }, { activities: [{ name: 'Park', family_friendly: 'yes' }] },
    { activities: [{ name: 'Park', category: [] }] }, { activities: [{ name: 'Park', location: {} }] },
    { activities: [{ name: 'Park', booked: true }] }, { unknown: 'ignored before' },
    { itinerary: [null] }, { itinerary: [{ title: 'Missing day' }] },
    { itinerary: [{ day: 1, title: null }] }, { itinerary: [{ day: 1, title: 'Rest', day_part: 'night' }] },
    { itinerary: [{ day: 1, title: 'Rest', kind: 'flight' }] },
    { budget: [null] }, { budget: [{ category: 'unknown', planned: 10 }] },
    { budget: [{ category: 'food' }] }, { budget: [{ category: 'food', planned: null }] },
  ])('rejects malformed fields without coercion: %j', (value) => {
    expect(parse(value)).toBeNull();
  });

  it.each([0, -1, 1.5, 4, 61, '1', null])('rejects an invalid or out-of-trip day: %j', (day) => {
    expect(parse({ itinerary: [{ day, title: 'Rest' }] })).toBeNull();
  });

  it('requires a real trip day for itinerary entries but supports undated activity plans', () => {
    expect(parse({ itinerary: [{ day: 1, title: 'Rest' }] }, 0)).toBeNull();
    expect(parse({ activities: [{ name: 'Park' }] }, 0)).not.toBeNull();
    expect(parse({}, -1)).toBeNull();
    expect(parse({}, 1.5)).toBeNull();
  });

  it.each([-1, '10', true, limits.moneyCents / 100 + 1, Number.MAX_SAFE_INTEGER])('rejects invalid dollars in either section: %j', (value) => {
    expect(parse({ activities: [{ name: 'Park', cost: value }] })).toBeNull();
    expect(parse({ budget: [{ category: 'food', planned: value }] })).toBeNull();
  });

  it('rejects JSON numbers that overflow to infinity', () => {
    expect(parseVacationAIOutput('{"activities":[{"name":"Park","cost":1e309}]}', 3)).toBeNull();
    expect(parseVacationAIOutput('{"budget":[{"category":"food","planned":1e309}]}', 3)).toBeNull();
  });

  it.each([0, 12.345, limits.moneyCents / 100])('preserves valid dollar amounts, including zero: %s', (value) => {
    expect(parse({ activities: [{ name: 'Park', cost: value }], budget: [{ category: 'food', planned: value }] }))
      .toMatchObject({ activities: [{ cost: value }], budget: [{ planned: value }] });
  });

  it('accepts exact array/string bounds and rejects oversized collections instead of truncating', () => {
    const value = {
      activities: Array.from({ length: limits.activities }, () => ({ name: 'x'.repeat(limits.name), category: 'x'.repeat(limits.category), location: 'x'.repeat(limits.location) })),
      itinerary: Array.from({ length: limits.itinerary }, () => ({ day: 3, title: 'x'.repeat(limits.name) })),
      budget: Array.from({ length: limits.budget }, () => ({ category: 'food', planned: 0 })),
    };
    expect(parse(value)).not.toBeNull();
    expect(parse({ activities: [...value.activities, { name: 'overflow' }] })).toBeNull();
    expect(parse({ itinerary: [...value.itinerary, { day: 1, title: 'overflow' }] })).toBeNull();
    expect(parse({ budget: [...value.budget, { category: 'food', planned: 0 }] })).toBeNull();
    expect(parse({ activities: [{ name: 'x'.repeat(limits.name + 1) }] })).toBeNull();
    expect(parse({ activities: [{ name: 'Park', category: 'x'.repeat(limits.category + 1) }] })).toBeNull();
    expect(parse({ activities: [{ name: 'Park', location: 'x'.repeat(limits.location + 1) }] })).toBeNull();
    expect(parse({ itinerary: [{ day: 1, title: 'x'.repeat(limits.name + 1) }] })).toBeNull();
  });

  it('rejects malformed, oversized, or wrapped provider text', () => {
    for (const text of ['', '{', '{} trailing', 'Here is your plan: {}', '[{}]', '{"plan":{}}', `${' '.repeat(limits.text)}{}`]) {
      expect(parseVacationAIOutput(text, 3)).toBeNull();
    }
    expect(parseVacationAIOutput(null, 3)).toBeNull();
  });
});
