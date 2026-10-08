import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { at } from './helpers/source-order';
import { orPredicate } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), urls: [] as URL[],
  rows: {} as Record<string, Record<string, unknown>[]>, cap: 2, fault: '', faultTable: 'meals', client: 0,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'synthetic-user' },
  active: { familyId: 'synthetic-family', role: 'parent', member: { id: 'synthetic-member' }, family: { timezone: 'UTC' } },
}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'Synthetic failure' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_scope: unknown, _feature: unknown,
  run: (observer: { used: () => void }) => Promise<string>) => run({ used: () => {} }),
}));
import { POST } from '@/app/api/ai/meals/plan/route';

const family = 'synthetic-family';
const tables = ['meals', 'family_recipes', 'pantry_items'] as const;
const dish = (id: string, name = id) => ({ id, family_id: family, name, meal_type: 'dinner', category: 'dinner', allergy_flags: [] });
const today = () => new Date().toISOString().slice(0, 10);
const pantry = (id: string, name = id, expires_at = today()) => ({ id, family_id: family, name, expires_at });
const request = (extra: Record<string, unknown> = {}) => new Request('https://synthetic.invalid/api/ai/meals/plan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ weekStart: '2026-09-14', write: false, useExpiring: true, ...extra }),
});
const prompt = () => String(h.complete.mock.calls[0]?.[0].messages[0].content);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.rows = {}; h.urls = []; h.cap = 2; h.fault = ''; h.faultTable = 'meals';
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ date: '2026-09-14', meal_type: 'dinner', ref: 'new', name: 'Synthetic soup' }] }) });
  h.db = createClient('https://synthetic-library.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: `library-${++h.client}` },
    global: { fetch: async (input, init) => {
      expect(init?.method ?? 'GET').toBe('GET'); // Preview and refusals must never issue writes.
      const url = new URL(String(input)); h.urls.push(url);
      const table = url.pathname.split('/').at(-1)!;
      expect(url.searchParams.get('family_id')).toBe(`eq.${family}`);
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      if (table === 'calendar_events') return Response.json([], { headers: { 'content-range': '*/0' } });
      expect(tables).toContain(table);
      expect(url.searchParams.get('order')).toBe('id.asc');
      expect(url.searchParams.get('select')?.split(',')).toEqual(expect.arrayContaining(['id', 'family_id', 'name']));
      let rows = (h.rows[table] ?? []).filter(orPredicate(`family_id.${url.searchParams.get('family_id')}`));
      for (const expression of url.searchParams.getAll('expires_at')) rows = rows.filter(orPredicate(
        expression.startsWith('not.') ? `not.expires_at.${expression.slice(4)}` : `expires_at.${expression}`,
      ));
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), h.cap);
      let page = rows.slice(offset, offset + limit), count = rows.length;
      const fault = table === h.faultTable ? h.fault : '';
      if (fault === 'throw') throw new Error('Synthetic network failure');
      if (fault === 'error') return Response.json({ code: 'XX000', message: 'Synthetic read failure' }, { status: 500 });
      if (fault === 'drift' && offset > 0) count++;
      if (fault === 'overflow') count = 20_001;
      if (fault === 'undercount') count = 1;
      if (fault === 'early-empty' && offset > 0) page = [];
      if (fault === 'duplicate' && offset > 0) page = [{ ...rows[0] }];
      if (page.length && fault === 'identity') page[0] = { ...page[0], id: null };
      if (page.length && fault === 'family') page[0] = { ...page[0], family_id: 'another-family' };
      if (page.length && fault === 'name') page[0] = { ...page[0], name: null };
      if (page.length && fault === 'shape') page[0] = { ...page[0], ...(table === 'meals' ? { meal_type: 'not-a-meal-type' }
        : table === 'family_recipes' ? { allergy_flags: { invalid: true } } : { expires_at: '2026-02-30' }) };
      return Response.json(page, { headers: fault === 'count' ? {} : {
        'content-range': page.length ? `${offset}-${offset + page.length - 1}/${count}` : `*/${count}`,
      } });
    } },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('actual SDK complete meal planning inputs before ranking', () => {
  it.each(['meals', 'family_recipes'] as const)('includes and globally ranks late-page %s', async table => {
    h.rows[table] = [dish('a', 'Zebra first'), dish('b', 'Zebra second'), dish('c', 'Aardvark favorite'),
      { ...dish('private', 'Other family private dish'), family_id: 'another-family' }];
    expect((await POST(request())).status).toBe(200);
    expect(prompt()).toContain('Aardvark favorite');
    expect(at(prompt(), 'Aardvark favorite')).toBeLessThan(at(prompt(), 'Zebra first'));
    expect(prompt()).not.toContain('Other family private dish');
    expect(h.urls.filter(url => url.pathname.endsWith(`/${table}`)).map(url => Number(url.searchParams.get('offset') ?? 0))).toEqual([0, 2]);
  });
  it('sorts all dated pantry pages before choosing the most urgent twelve', async () => {
    h.rows.pantry_items = [pantry('a', 'Long shelf life', '2099-01-01'), pantry('b', 'Another future item', '2099-01-01'),
      pantry('c', 'Urgent spinach'), { ...pantry('other', 'Private pantry'), family_id: 'another-family' },
      pantry('undated', 'No expiry', null as unknown as string)];
    expect((await POST(request())).status).toBe(200);
    expect(prompt()).toContain('Urgent spinach'); expect(prompt()).not.toContain('Long shelf life');
    expect(prompt()).not.toContain('Private pantry'); expect(prompt()).not.toContain('No expiry');
    expect(h.urls.filter(url => url.pathname.endsWith('/pantry_items')).map(url => Number(url.searchParams.get('offset') ?? 0))).toEqual([0, 2]);
  });
  it('keeps the deliberate sixty-dish shortlist after global ranking rather than server order', async () => {
    h.rows.meals = Array.from({ length: 65 }, (_, index) => dish(String(index).padStart(3, '0'), `Zebra ${index.toString().padStart(3, '0')}`));
    h.rows.meals.push(dish('999', 'Aardvark last page'));
    expect((await POST(request())).status).toBe(200);
    expect(prompt()).toContain('Aardvark last page'); expect(prompt()).toContain('Zebra 058'); expect(prompt()).not.toContain('Zebra 059');
    expect(prompt().split('\n').filter(line => line.startsWith('- meal:'))).toHaveLength(60);
  });
  it('keeps the deliberate twelve pantry choices after global urgency sorting', async () => {
    h.rows.pantry_items = Array.from({ length: 13 }, (_, index) => pantry(String(index).padStart(3, '0'), `Ordinary ${index}`, today()));
    h.rows.pantry_items.push(pantry('999', 'Most urgent last page', '2000-01-01'));
    expect((await POST(request())).status).toBe(200);
    expect(prompt()).toContain('Most urgent last page'); expect(prompt()).toContain('Ordinary 10'); expect(prompt()).not.toContain('Ordinary 11');
  });
  it('accepts exact empty sets and historical nullable recipe flags', async () => {
    h.rows.family_recipes = [{ ...dish('nullable', 'Historical recipe'), allergy_flags: null }];
    expect((await POST(request())).status).toBe(200); expect(prompt()).toContain('Historical recipe');
  });
  it('does not read pantry when the user disables expiring ingredients', async () => {
    h.faultTable = 'pantry_items'; h.fault = 'error';
    expect((await POST(request({ useExpiring: false }))).status).toBe(200);
    expect(h.urls.some(url => url.pathname.endsWith('/pantry_items'))).toBe(false);
  });
  it('accepts a complete library exactly at the safety ceiling', async () => {
    h.cap = 1000;
    h.rows.meals = Array.from({ length: 20_000 }, (_, index) => dish(String(index).padStart(5, '0')));
    expect((await POST(request())).status).toBe(200);
    expect(h.urls.filter(url => url.pathname.endsWith('/meals'))).toHaveLength(20);
  });
  describe.each(tables)('%s failure refuses provider and writes', table => {
    it.each(['count', 'drift', 'overflow', 'undercount', 'early-empty', 'duplicate', 'identity', 'family', 'name', 'shape', 'error', 'throw'])(
      '%s', async fault => {
        h.rows[table] = ['a', 'b', 'c'].map(id => table === 'pantry_items' ? pantry(id) : dish(id));
        h.faultTable = table; h.fault = fault;
        const before = structuredClone(h.rows);
        expect((await POST(request({ write: true }))).status).toBe(503);
        expect(h.complete).not.toHaveBeenCalled(); expect(h.rows).toEqual(before);
      },
    );
  });
});
