// A photo or flyer the model could not read is not one with nothing on it.
//
// Fridge Chef defaulted a missing reply to '[]' and parsed anything else that
// held no readable JSON array — a refusal, prose, or a list cut off at the
// token limit — as no recipes; the route answered 200 { recipes: [] }, the
// screen said "No food spotted — try a clearer photo", and the request was
// recorded as completed. The flyer scan did the same with "No events found on
// that flyer", which is what a dense calendar PDF cut off at 1,500 tokens got.
// Only a JSON `[]` from the model now means "nothing there"; anything else is
// a 502 "could not read", and Fridge Chef records the request as failed.
//
// And the `[]` must be the reply's own value. Both took the first `[` to the
// last `]`, so `{"error":[]}` was the model's empty list; and both filtered
// the items to the schema afterwards, so `[{}]` — a list of nothing usable —
// became the same `[]`. Both are now "could not read". A list with some good
// items still keeps those, and a fenced `[]` is still "nothing there".
//
// Both real routes; the model's HTTP reply is the fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, fetch: vi.fn(), used: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The plan gates and the AI allowance are covered by the features' own tests.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); this one is about reading the reply.
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: async () => ({ ok: true }), accessDeniedResponse: () => null, refuseOverAIAllowance: async () => null, withinAIAllowance: async () => true }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: async () => ({ openaiKey: 'sk-fixture', model: 'gpt-4o' }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: typeof h.used; failed: typeof h.failed }) => unknown) => run({ used: h.used, failed: h.failed }),
}));

import { POST as fridgeChef } from '@/app/api/ai/pantry-chef/route';
import { POST as flyer } from '@/app/api/ai/flyer/route';

beforeEach(() => {
  h.db = createInMemorySupabase<SupabaseClient<Database>>();
  h.fetch.mockReset();
  h.used.mockReset();
  h.failed.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const modelSays = (content: string | null) => h.fetch.mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
const photo = () => fridgeChef(new NextRequest('https://fixture.invalid/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'aGVsbG8=', mediaType: 'image/png' }),
}));
const scan = () => flyer(new NextRequest('https://fixture.invalid/api/ai/flyer', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'aGVsbG8=', mediaType: 'application/pdf' }),
}));

const UNREADABLE: [string, string | null][] = [
  ['no content at all', null],
  ['a refusal in prose', 'I\'m sorry, but I can\'t help identify the contents of this image.'],
  ['a list cut off at the token limit', '[{"title":"Vegetable soup","have":["carrots","celery"],"need":["stock"],"steps":"Chop and simm'],
];

// A quoted value after prose or inside a fence is a string, whatever it
// spells: a list in its text is never the reply's own.
const QUOTED_AFTER_PROSE: [string, string][] = [
  ['a quoted empty list after prose', 'Result: "[]"'],
  ['a quoted empty list fenced after prose', 'Here it is:\n```json\n"[]"\n```'],
  ['a quoted string with escaped quotes around a list', 'Result: "they said \\"[]\\" twice"'],
  ['a list after a quote the reply never closes', 'I read "nothing here [] at all'],
];

const SOUP = { title: 'Vegetable soup', have: ['carrots', 'celery'], need: ['stock'], steps: 'Chop and simmer.', minutes: 30 };

// Each of these used to answer 200 { recipes: [] } (or, for a wrapped list,
// 200 with whatever the object held) — "No food spotted".
const NOT_A_RECIPE_LIST: [string, string][] = [
  ['a list of empty objects', '[{}]'],
  ['a list whose items have no title', '[{"have":["eggs"],"need":["bread"]}, {"title":"   "}]'],
  ['a list of bare strings', '["soup","salad"]'],
  ['an error object with an empty list in it', '{"error":[]}'],
  ['the same error object, fenced and explained', 'I could not read it.\n```json\n{"error": [], "reason": "blurry"}\n```'],
  ['an object wrapping a list of empty objects', '{"recipes":[{}]}'],
  ['an object wrapping a real recipe, a shape the prompt never asked for', JSON.stringify({ recipes: [SOUP] })],
  // A complete JSON reply decides by its own value: a string that LOOKS like
  // a list is a string, not an empty one.
  ['a JSON string that looks like an empty list', JSON.stringify('[]')],
  ['a JSON string holding a list in prose', JSON.stringify('Here you go: [] nothing found')],
  ...QUOTED_AFTER_PROSE,
  ['a quoted list of a real recipe after prose', `Result: ${JSON.stringify(JSON.stringify([SOUP]))}`],
];

describe('Fridge Chef', () => {
  it.each(UNREADABLE)('answers 502 and records a failure for %s', async (_case, content) => {
    modelSays(content);

    const response = await photo();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'pantryChef.couldNotReadThatPhoto' });
    expect(h.failed).toHaveBeenCalledTimes(1);
  });

  it.each(NOT_A_RECIPE_LIST)('answers 502 and records a failure for %s', async (_case, content) => {
    modelSays(content);

    const response = await photo();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'pantryChef.couldNotReadThatPhoto' });
    expect(h.failed).toHaveBeenCalledTimes(1);
  });

  it('control: the model\'s own empty list is still "no food spotted"', async () => {
    modelSays('[]');

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [], allergiesConsidered: 0 });
    expect(h.failed).not.toHaveBeenCalled();
  });

  it('control: a fenced empty list is still "no food spotted"', async () => {
    modelSays('```json\n[]\n```');

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [], allergiesConsidered: 0 });
    expect(h.failed).not.toHaveBeenCalled();
  });

  it('control: a valid recipe is answered with it', async () => {
    modelSays(JSON.stringify([SOUP]));

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [{ ...SOUP, allergenConflict: null }], allergiesConsidered: 0 });
    expect(h.failed).not.toHaveBeenCalled();
  });

  it('control: a list mixing a valid recipe with invalid items keeps only the valid one', async () => {
    modelSays(`Here you go:\n${JSON.stringify([{}, 'salad', { have: ['eggs'] }, SOUP, null])}`);

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [{ ...SOUP, allergenConflict: null }], allergiesConsidered: 0 });
    expect(h.failed).not.toHaveBeenCalled();
  });

  it('control: a fence inside a recipe\'s steps does not empty the list', async () => {
    const pie = { ...SOUP, title: 'Pie', steps: 'Mix ```[]``` well, then bake "[20 min]".' };
    modelSays(JSON.stringify([pie]));

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [{ ...pie, allergenConflict: null }], allergiesConsidered: 0 });
  });

  it('control: quoted words in prose before the list, brackets and all, do not hide it', async () => {
    modelSays(`I can see "carrots", "celery [half a bunch]" and a "stock \\"cube\\"":\n${JSON.stringify([SOUP])}`);

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [{ ...SOUP, allergenConflict: null }], allergiesConsidered: 0 });
  });

  it('control: brackets inside the recipe text, or in prose before the list, do not hide it', async () => {
    const stew = { ...SOUP, title: 'Stew [easy]', steps: 'Brown it {in batches}, then simmer.' };
    modelSays(`I can see {carrots, celery} on the shelf.\n${JSON.stringify([stew])}`);

    const response = await photo();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [{ ...stew, allergenConflict: null }], allergiesConsidered: 0 });
  });
});

const BAKE_SALE = { title: 'Bake sale', date: '2026-10-20', time: '15:30', end_time: null, location: 'Gym', description: null, category: 'school' };
const BAKE_SALE_EVENT = {
  title: 'Bake sale', starts_at: '2026-10-20T15:30:00.000Z', ends_at: null, all_day: false,
  location: 'Gym', description: null, category: 'school', summary: expect.stringContaining('Bake sale'),
};

// Each of these used to answer 200 { events: [] } (or, for a wrapped list,
// 200 with whatever the object held) — "No events found on that flyer".
const NOT_AN_EVENT_LIST: [string, string][] = [
  ['a list of empty objects', '[{}]'],
  ['a list whose items have no date', '[{"title":"Bake sale"},{"title":"Field trip","date":null}]'],
  ['an error object with an empty list in it', '{"error":[]}'],
  ['the same error object, fenced and explained', 'I could not read it.\n```json\n{"error": [], "reason": "blurry"}\n```'],
  ['an object wrapping a list of empty objects', '{"events":[{}]}'],
  ['an object wrapping a real event, a shape the prompt never asked for', JSON.stringify({ events: [BAKE_SALE] })],
  ['a JSON string that looks like an empty list', JSON.stringify('[]')],
  ...QUOTED_AFTER_PROSE,
  ['a quoted list of a real event after prose', `Result: ${JSON.stringify(JSON.stringify([BAKE_SALE]))}`],
];

describe('the flyer scan', () => {
  it.each(UNREADABLE)('answers 502 for %s', async (_case, content) => {
    modelSays(content);

    const response = await scan();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'flyer.couldNotReadThatFlyer' });
  });

  it.each(NOT_AN_EVENT_LIST)('answers 502 for %s', async (_case, content) => {
    modelSays(content);

    const response = await scan();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'flyer.couldNotReadThatFlyer' });
  });

  it('control: a flyer the model found no events on is still an empty list', async () => {
    modelSays('[]');

    const response = await scan();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
  });

  it('control: a fenced empty list is still an empty list', async () => {
    modelSays('```json\n[]\n```');

    const response = await scan();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
  });

  it('control: a valid event is answered with it', async () => {
    modelSays(JSON.stringify([BAKE_SALE]));

    const response = await scan();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [BAKE_SALE_EVENT] });
  });

  // A fence or a bracket inside a string value is text: the reply's own
  // array is read whole, whether or not prose comes before it.
  it.each([
    ['backticks in a description', { ...BAKE_SALE, description: 'Bring ```[]``` and a smile' }],
    ['an escaped quote and brackets in the title', { ...BAKE_SALE, title: 'Bake sale "[2 tables]"' }],
  ])('control: %s does not empty a valid event list, bare or after prose', async (_case, event) => {
    for (const content of [JSON.stringify([event]), `Found one event:\n${JSON.stringify([event])}`]) {
      modelSays(content);

      const response = await scan();

      expect(response.status, content).toBe(200);
      expect(((await response.json()) as { events: { title: string; description: string | null }[] }).events)
        .toEqual([expect.objectContaining({ title: event.title, description: event.description })]);
    }
  });

  it('control: a quoted line of the flyer in prose before the list does not hide it', async () => {
    modelSays(`The flyer says "Bake sale [Gym], all welcome":\n${JSON.stringify([BAKE_SALE])}`);

    const response = await scan();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [BAKE_SALE_EVENT] });
  });

  it('control: a list mixing a valid event with invalid items keeps only the valid one', async () => {
    modelSays(JSON.stringify([{}, { title: 'Field trip' }, BAKE_SALE, null]));

    const response = await scan();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [BAKE_SALE_EVENT] });
  });
});
