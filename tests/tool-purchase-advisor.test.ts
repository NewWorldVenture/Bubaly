import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { toolsForIntent } from '@/lib/ai/planner/prompts';
import { classifyIntentFast } from '@/lib/ai/context/intents';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, values?: Record<string, string | number>) =>
    (SOURCE_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] === undefined ? match : String(values[name])) };
});

const tool = getTool('finances.advisePurchase')!;
function fixture(role: ServiceScope['role'] = 'parent') {
  const db = createInMemorySupabase();
  db.seed('inventory_items', [{
    id: 'our-drill', family_id: 'ours', name: 'Cordless drill', category: 'tools', location_id: null,
    quantity: 1, value_cents: null, brand: 'Bosch', model: '18V', serial_number: null, tags: [],
    status: 'in_place', lent_to: null, lent_on: null, warranty_until: null,
  }, {
    id: 'their-drill', family_id: 'theirs', name: 'Secret drill', category: 'tools', location_id: null,
    quantity: 1, value_cents: null, brand: null, model: null, serial_number: null, tags: [],
    status: 'in_place', lent_to: null, lent_on: null, warranty_until: null,
  }]);
  db.seed('budgets', [{ id: 'budget', family_id: 'ours', category: 'tools', period: 'monthly', amount: 100 }]);
  db.seed('transactions', [{ id: 'spent', family_id: 'ours', category: 'tools', type: 'expense', amount: 89, date: '2026-09-03' }]);
  db.seed('family_ai_settings', [{ family_id: 'ours', memory_enabled: true }]);
  const scope: ServiceScope = { db: db as unknown as ServiceScope['db'], familyId: 'ours', userId: 'auth', memberId: 'member', role, actorKind: 'ai', tz: 'UTC', now: new Date('2026-09-09T12:00:00Z') };
  return { db, scope };
}
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('Ask purchase advice', () => {
  it('classifies the question, constructs a real read, and returns owned evidence from that household', async () => {
    const ask = 'Should we buy another cordless drill?';
    const classification = classifyIntentFast(ask)!;
    expect(classification.intent).toBe('purchase_advice');
    expect(toolsForIntent(classification.intent, listTools()).map((t) => t.name)).toContain(tool.name);
    expect(tool).toMatchObject({ readOnly: true, domain: 'finances', capability: 'view' });
    const input = tool.input.parse({ text: classification.entities.item });
    const result = await tool.execute(fixture().scope, input);
    if (!result.ok) throw new Error(result.error);
    expect(tool.output.safeParse(result.data).success).toBe(true);
    expect(result.data).toMatchObject({ reason: 'owned_duplicate', affordability: 'unknown', evidence: [{ id: 'our-drill', name: 'Cordless drill' }] });
    expect(JSON.stringify(result.data)).not.toContain('Secret drill');
    expect(result.data).toMatchObject({ answer: expect.stringContaining('Cordless drill') });
    expect(tool.summarize(input, result.data)).not.toContain('Cordless drill');
  });

  it('uses the same recorded budget to report tight or over budget, without buying anything', async () => {
    const { db, scope } = fixture();
    const before = structuredClone(db.table('transactions'));
    for (const [priceDollars, affordability] of [[5, 'tight'], [20, 'conflict']] as const) {
      const result = await tool.execute(scope, { text: 'drill', priceDollars, budgetCategory: 'tools' });
      expect(result).toMatchObject({ ok: true, data: { affordability } });
    }
    expect(db.table('transactions')).toEqual(before);
  });

  it('does not query finances for a child, and does not disclose an owned gift purchase', async () => {
    const { db, scope } = fixture('child');
    db.seed('wishlist_items', [{ id: 'gift', family_id: 'ours', member_id: 'member', title: 'drill', price: 40, is_purchased: true }]);
    const from = db.from.bind(db);
    const visited: string[] = [];
    vi.spyOn(db, 'from').mockImplementation((table) => { visited.push(table); return from(table); });
    const result = await tool.execute(scope, { text: 'drill', priceDollars: 10 });
    expect(result).toMatchObject({ ok: true, data: { affordability: 'restricted', budgetRestricted: true } });
    expect(visited).not.toContain('budgets');
    expect(visited).not.toContain('transactions');
    expect(JSON.stringify(result)).not.toContain('[already bought]');
  });

  it('does not load remembered facts when the family switches memory off', async () => {
    const { db, scope } = fixture();
    db.replace('family_ai_settings', [{ family_id: 'ours', memory_enabled: false }]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'family_facts') throw new Error('Memory must not be queried');
      return from(table);
    });
    expect(await tool.execute(scope, { text: 'drill' })).toMatchObject({ ok: true, data: { memoryRestricted: true } });
  });

  it('finds owned items and older preferences beyond the former source caps', async () => {
    const { db, scope } = fixture();
    db.seed('inventory_items', Array.from({ length: 401 }, (_, index) => ({
      ...db.table('inventory_items')[0], id: `aaa-${String(index).padStart(4, '0')}`, name: 'Book', brand: null, model: null,
    })));
    db.seed('family_facts', Array.from({ length: 501 }, (_, index) => ({
      id: `fact-${String(index).padStart(4, '0')}`, family_id: 'ours', category: 'preference', label: 'Dessert', value: 'Chocolate',
      is_pinned: false, updated_at: '2026-09-01T00:00:00Z', expires_at: null,
    })));
    db.seed('family_facts', [{ id: 'old-drill-preference', family_id: 'ours', category: 'preference', label: 'Drill preference',
      value: 'Reuse Bosch batteries', is_pinned: false, updated_at: '2020-01-01T00:00:00Z', expires_at: null }]);
    const result = await tool.execute(scope, { text: 'drill', priceDollars: 5, budgetCategory: 'tools' });
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({ reason: 'owned_duplicate', answer: expect.stringContaining('Cordless drill') });
    expect(result.data).toMatchObject({ answer: expect.stringContaining('Reuse Bosch batteries') });
    expect(result.data).toMatchObject({ answer: expect.stringContaining('$6.00 left after this') });
    expect(tool.summarize({ text: 'drill' }, result.data)).not.toMatch(/Bosch|\$6|Drill preference/);
  });

  it('does not turn a failed later source page into a complete check', async () => {
    const { db, scope } = fixture();
    db.seed('inventory_items', Array.from({ length: 401 }, (_, index) => ({
      ...db.table('inventory_items')[0], id: `aaa-${String(index).padStart(4, '0')}`, name: 'Book', brand: null, model: null,
    })));
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      if (table === 'inventory_items') {
        const range = query.range.bind(query);
        vi.spyOn(query, 'range').mockImplementation((start, end) => {
          if (start > 0) throw new Error('second page unavailable');
          return range(start, end);
        });
      }
      return query;
    });
    expect(await tool.execute(scope, { text: 'drill' })).toMatchObject({ ok: false, code: 'db', retryable: true });
  });

  it('includes late expenses beyond the finance cap before assessing affordability', async () => {
    const { db, scope } = fixture();
    db.replace('budgets', [{ id: 'annual', family_id: 'ours', category: 'tools', period: 'yearly', amount: 100 }]);
    db.replace('transactions', Array.from({ length: 5001 }, (_, index) => ({
      id: `expense-${String(index).padStart(5, '0')}`, family_id: 'ours', category: 'tools', type: 'expense', amount: 0, date: '2026-09-03',
    })));
    db.seed('transactions', [{ id: 'old-expense', family_id: 'ours', category: 'tools', type: 'expense', amount: 99, date: '2026-01-01' }]);
    expect(await tool.execute(scope, { text: 'sander', priceDollars: 5, budgetCategory: 'tools' }))
      .toMatchObject({ ok: true, data: { affordability: 'conflict', reason: 'over_budget' } });
  });

  it('returns a retryable error for a thrown read rather than a reassuring verdict', async () => {
    const { db, scope } = fixture();
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'inventory_items') throw new Error('network unavailable');
      return from(table);
    });
    expect(await tool.execute(scope, { text: 'drill' })).toMatchObject({ ok: false, code: 'db', retryable: true });
    expect(console.error).toHaveBeenCalledWith('[purchase-advisor] household read failed', expect.any(Error));
  });
});
