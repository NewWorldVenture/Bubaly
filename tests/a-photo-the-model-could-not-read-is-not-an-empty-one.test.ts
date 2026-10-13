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
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: async () => ({ ok: true }), accessDeniedResponse: () => null }));
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

describe('Fridge Chef', () => {
  it.each(UNREADABLE)('answers 502 and records a failure for %s', async (_case, content) => {
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
});

describe('the flyer scan', () => {
  it.each(UNREADABLE)('answers 502 for %s', async (_case, content) => {
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
});
