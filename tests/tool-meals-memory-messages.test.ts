// Contract and behaviour tests for the meals, memory and messages tools.
//
// The registry-wide invariants (domain, risk, idempotency guards, strict JSON
// schema) are asserted in tests/tool-registry.test.ts over every tool; these
// tests pin what is specific to this batch: the legacy names keep resolving,
// the risk tiers match the §12 lists, the memory tool refuses medical and
// account facts before a query runs, and each execute maps its legacy input
// shape onto the service correctly. Tool `execute` functions are called
// directly with a fake database — the trust gate and ledger are the
// executor's concern and are covered in tests/tool-execute.test.ts.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { toolInputSchema } from '@/lib/ai/tools/legacy-adapter';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter, in: filter,
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: 'America/New_York', now: NOW, ...extra,
  };
}

/** Parse through the tool's own schema first, exactly as the executor does. */
async function run(tool: ToolDefinition, scope: ServiceScope, raw: unknown) {
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid input for ${tool.name}: ${parsed.error.message}`);
  const res = await tool.execute(scope, parsed.data);
  if (res.ok) {
    const out = tool.output.safeParse(res.data);
    if (!out.success) throw new Error(`invalid output for ${tool.name}: ${out.error.message}`);
  }
  return res;
}

const MEMBERS = [
  { id: 'member-1', family_id: 'fam-1', user_id: 'auth-user-1', display_name: 'Dana', role: 'parent', birthday: null, is_active: true, color: null, avatar_url: null },
  { id: 'member-2', family_id: 'fam-1', user_id: null, display_name: 'Tom', role: 'child', birthday: null, is_active: true, color: null, avatar_url: null },
];

describe('registration', () => {
  it('resolves the legacy names this batch inherits', () => {
    const expected: Record<string, string> = {
      create_meal_plan_entry: 'meals.setSlot',
      get_meal_plan: 'meals.getMealPlan',
      create_announcement: 'messages.createAnnouncement',
      send_family_message: 'messages.sendFamilyMessage',
      remember_fact: 'memory.remember',
      recall_facts: 'memory.recall',
      forget_fact: 'memory.forget',
      add_groceries_from_meal_plan: 'groceries.addFromMealPlan',
    };
    for (const [alias, canonical] of Object.entries(expected)) {
      expect(getTool(alias)?.name, alias).toBe(canonical);
    }
  });

  it('carries the §12 risk tiers and trust domains', () => {
    const expectMeta = (name: string, meta: Partial<Pick<ToolDefinition, 'domain' | 'risk' | 'readOnly' | 'capability'>>) => {
      expect(getTool(name), name).toMatchObject(meta);
    };
    expectMeta('meals.getMealPlan', { domain: 'meal_planning', risk: 'low', readOnly: true, capability: 'view' });
    expectMeta('meals.foodProfile', { domain: 'meal_planning', risk: 'low', readOnly: true });
    expectMeta('meals.setSlot', { domain: 'meal_planning', risk: 'low', readOnly: false, capability: 'create' });
    expectMeta('meals.planWeek', { domain: 'meal_planning', risk: 'medium', readOnly: false, capability: 'create' });
    expectMeta('groceries.addFromMealPlan', { domain: 'shopping', risk: 'low', readOnly: false });
    expectMeta('memory.remember', { risk: 'low', readOnly: false, capability: 'create' });
    expectMeta('memory.recall', { risk: 'low', readOnly: true });
    expectMeta('memory.forget', { risk: 'medium', readOnly: false, capability: 'delete' });
    expectMeta('messages.sendFamilyMessage', { domain: 'messaging', risk: 'medium', readOnly: false });
    expectMeta('messages.createAnnouncement', { domain: 'messaging', risk: 'medium', readOnly: false });
  });

  it('explains every medium-risk write on its approval card', () => {
    for (const name of ['meals.planWeek', 'memory.forget', 'messages.sendFamilyMessage', 'messages.createAnnouncement']) {
      const tool = getTool(name)!;
      const consequences = tool.consequences?.({ entries: [{ date: '2026-09-07' }], content: 'hi', title: 'x' });
      expect(Array.isArray(consequences) && consequences.length > 0, name).toBe(true);
    }
  });

  it('lists the meal-planning tools together for the planner', () => {
    expect(listTools({ domains: ['meal_planning'] }).map((t) => t.name).sort()).toEqual([
      'meals.foodProfile', 'meals.getMealPlan', 'meals.listRecipes', 'meals.planWeek', 'meals.setSlot',
    ]);
  });

  it('expresses every new tool input as strict JSON Schema', () => {
    for (const name of ['meals.setSlot', 'meals.planWeek', 'groceries.addFromMealPlan', 'memory.remember', 'memory.recall', 'memory.forget', 'messages.sendFamilyMessage', 'messages.createAnnouncement', 'meals.foodProfile', 'meals.listRecipes', 'meals.getMealPlan']) {
      const schema = toolInputSchema(getTool(name)!);
      expect(schema?.additionalProperties, name).toBe(false);
    }
  });
});

describe('meals.setSlot', () => {
  it('accepts the legacy create_meal_plan_entry shape and plans the slot', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    const tool = getTool('create_meal_plan_entry')!;
    const res = await run(tool, scopeWith(db), { meal_name: 'Tacos', plan_date: '2026-09-07', meal_type: 'dinner' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ id: db.table('meal_plans')[0].id, date: '2026-09-07', meal_type: 'dinner', name: 'Tacos', replaced: false });
      expect(tool.summarize({ meal_name: 'Tacos', plan_date: '2026-09-07' }, res.data)).toBe('Planned Tacos for dinner on Mon, Sep 7');
    }
    expect(db.table('meal_plans')).toEqual([
      expect.objectContaining({ family_id: 'fam-1', meal_id: db.table('meals')[0].id, plan_date: '2026-09-07', meal_type: 'dinner', created_by: 'auth-user-1' }),
    ]);
  });

  it('refuses a slot without a dish or date before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const tool = getTool('meals.setSlot')!;
    expect(await run(tool, scopeWith(db), { date: '2026-09-07' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await run(tool, scopeWith(db), { meal_name: 'Tacos' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('keys duplicates on date, meal type and dish', () => {
    const tool = getTool('meals.setSlot')!;
    const scope = scopeWith(makeDb(() => ({ data: null, error: null })).db);
    expect(tool.idempotencyFrom?.({ plan_date: '2026-09-07', meal_name: 'Tacos' }, scope)).toBe('meals.setSlot:2026-09-07:dinner:tacos');
    expect(tool.idempotencyFrom?.({ date: '2026-09-07', meal_type: 'lunch', meal_id: 'meal-1' }, scope)).toBe('meals.setSlot:2026-09-07:lunch:meal-1');
  });
});

describe('meals.planWeek', () => {
  it('names the days it will replace on the approval card', () => {
    const tool = getTool('meals.planWeek')!;
    const consequences = tool.consequences!({
      entries: [{ date: '2026-09-07', meal_name: 'Tacos' }, { date: '2026-09-08', meal_type: 'dinner', meal_id: 'meal-2' }],
    });
    expect(consequences[0]).toContain('2 days');
    expect(consequences[0]).toContain('Mon, Sep 7');
    expect(consequences[1]).toContain('new dishes');
  });

  it('summarises a planned week in a sentence a person reads', () => {
    const tool = getTool('meals.planWeek')!;
    const summary = tool.summarize({}, {
      planned: [
        { id: 'p1', date: '2026-09-07', meal_type: 'dinner', meal_id: 'm1', name: 'Tacos' },
        { id: 'p2', date: '2026-09-08', meal_type: 'dinner', meal_id: 'm2', name: 'Curry' },
      ],
      replaced: 0, created_meals: 1,
    });
    expect(summary).toBe('Planned 2 meals for Mon, Sep 7 – Tue, Sep 8 — Tacos, Curry');
  });
});

describe('groceries.addFromMealPlan', () => {
  it('expands week_start into a seven-day window and adds what is not in the pantry', async () => {
    let saved: Record<string, unknown>[] = [];
    const { db, calls } = makeDb((call) => {
      switch (call.table) {
        case 'meal_plans':
          return { data: [{ meal_id: 'meal-1', plan_date: '2026-09-08' }], error: null };
        case 'meals':
          return { data: [{ id: 'meal-1', name: 'Tacos', ingredients: [{ name: 'tortillas', qty: '8' }, { name: 'onion', qty: '1' }] }], error: null };
        case 'pantry_items':
          return { data: [{ name: 'Onions', quantity: 3 }], error: null };
        case 'grocery_lists':
          return { data: { id: 'list-1' }, error: null };
        case 'grocery_items':
          if (call.kind === 'insert') saved = (call.payload as Record<string, unknown>[]).map((r, i) => ({ ...r, id: `item-${i}`, is_checked: false }));
          return { data: saved, error: null };
        default:
          return { data: null, error: null };
      }
    });
    const tool = getTool('groceries.addFromMealPlan')!;
    const res = await run(tool, scopeWith(db), { week_start: '2026-09-07' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      list_id: 'list-1', in_pantry: ['onion'], skipped: [],
      added: [{ id: 'item-0', name: 'tortillas', quantity: '8', category: 'Bakery' }],
      meals: [{ id: 'meal-1', name: 'Tacos', date: '2026-09-08' }],
    });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', 'gte:plan_date': '2026-09-07', 'lte:plan_date': '2026-09-13' });
    expect(calls.find((c) => c.table === 'grocery_items' && c.kind === 'insert')?.payload).toMatchObject([{ source_meal_id: 'meal-1' }]);
    expect(tool.summarize({}, res.data)).toBe('Added 1 item to the shopping list for 1 planned meal (1 in the pantry)');
  });

  it('is honest when nothing is planned', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }));
    const res = await run(getTool('groceries.addFromMealPlan')!, scopeWith(db), { from: '2026-09-07', to: '2026-09-13' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('memory.remember', () => {
  it('refuses medical and account facts before any query, and says where they belong', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const tool = getTool('memory.remember')!;
    const byCategory = await run(tool, scopeWith(db), { key: 'Allergy', content: 'peanuts', category: 'preference', member: 'Tom' });
    expect(byCategory).toMatchObject({ ok: false, code: 'denied' });
    if (!byCategory.ok) expect(byCategory.error).toContain('health profile');
    const byWords = await run(tool, scopeWith(db), { key: 'Bank', content: 'account number 12345' });
    expect(byWords).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('resolves a member name and stores an explicit preference as a confirmed fact', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_members') return { data: MEMBERS, error: null };
      if (call.table === 'family_facts' && call.kind === 'insert') {
        return { data: { ...(call.payload as Record<string, unknown>), id: 'fact-1', created_at: '', updated_at: '' }, error: null };
      }
      if (call.table === 'agent_activity') return { data: { id: 'activity-1' }, error: null };
      return { data: null, error: null };
    });
    const tool = getTool('memory.remember')!;
    // `asked_for` is the model reporting what happened in the turn — the person
    // said "remember that". That, and only that, is the confirmed lane.
    const res = await run(tool, scopeWith(db), { key: "Doesn't eat", content: 'mushrooms', member: 'tom', asked_for: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ kind: 'fact', id: 'fact-1', member_id: 'member-2', confirmed: true, updated: false });
      expect(tool.summarize({}, res.data)).toBe("Remembered: Doesn't eat — mushrooms");
    }
    expect(calls.find((c) => c.kind === 'insert')?.payload).toMatchObject({ category: 'preference', member_id: 'member-2', created_by: 'auth-user-1' });
  });

  it('sends an AI inference to the inbox rather than confirmed memory', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_playbook_suggestions' && call.kind === 'insert') {
        return { data: { ...(call.payload as Record<string, unknown>), id: 'sug-1', fact_id: null, created_at: '', updated_at: '' }, error: null };
      }
      return { data: null, error: null };
    });
    const tool = getTool('memory.remember')!;
    // Nothing said the person asked for this, so it is Bubaly's own reading of
    // the conversation. The model used to be able to call it a fact.
    const res = await run(tool, scopeWith(db), { key: 'Go-to dinner', content: 'Taco night', confidence: 65 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ kind: 'suggestion', confirmed: false });
      expect(tool.summarize({}, res.data)).toContain('waiting for someone to confirm');
    }
    expect(calls.some((c) => c.table === 'family_facts')).toBe(false);
  });

  it('will not let the model call its own inference a fact', async () => {
    // The lane used to be `input.source ?? 'user'`: the model's word for
    // whether what it worked out was something a person said, defaulting to
    // "a person said so". A stray `source: 'user'` in the arguments is now
    // simply not a field the tool has.
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_playbook_suggestions' && call.kind === 'insert') {
        return { data: { ...(call.payload as Record<string, unknown>), id: 'sug-2', fact_id: null, created_at: '', updated_at: '' }, error: null };
      }
      return { data: null, error: null };
    });
    const res = await run(getTool('memory.remember')!, scopeWith(db), {
      key: 'Bedtime', content: '8pm', source: 'user', asked_for: false,
    });
    expect(res).toMatchObject({ ok: true, data: { kind: 'suggestion', confirmed: false } });
    expect(calls.some((c) => c.table === 'family_facts' && c.kind === 'insert')).toBe(false);
  });

  it('fails loudly for a name nobody in the family answers to', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'family_members' ? { data: MEMBERS, error: null } : { data: null, error: null }));
    const res = await run(getTool('memory.remember')!, scopeWith(db), { key: 'Shoe size', content: 'US 3', member: 'Zed' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });
});

describe('memory.recall', () => {
  it('returns confirmed facts with a from_person flag read from the source column', async () => {
    // 0265. `from_person` used to be `!notes.startsWith('Learned by Bubaly')`,
    // so the third row here — Bubaly's, with a note a person has since edited
    // — reported as the family's own. `f4` proves the converse: a person's
    // fact whose note happens to open with that sentence is still theirs.
    const { db } = makeDb(() => ({
      data: [
        { id: 'f1', family_id: 'fam-1', member_id: null, category: 'preference', label: 'Diet', value: 'vegetarian', notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null, created_by: 'u', created_at: '', updated_at: '' },
        { id: 'f2', family_id: 'fam-1', member_id: null, category: 'preference', label: 'Go-to dinner', value: 'Tacos', notes: 'Learned by Bubaly — planned 5 times', is_pinned: false, source: 'ai_conversation', confidence: 80, expires_at: null, created_by: 'u', created_at: '', updated_at: '' },
        { id: 'f3', family_id: 'fam-1', member_id: null, category: 'preference', label: 'Snack', value: 'Apples', notes: 'Actually she prefers pears now', is_pinned: false, source: 'ai_inferred', confidence: 55, expires_at: null, created_by: 'u', created_at: '', updated_at: '' },
        { id: 'f4', family_id: 'fam-1', member_id: null, category: 'sizes', label: 'Shoe size', value: 'US 2', notes: 'Learned by Bubaly? No — I measured it myself', is_pinned: false, source: 'user', confidence: null, expires_at: null, created_by: 'u', created_at: '', updated_at: '' },
        // Expired: a coat size that ran out yesterday must not steer a plan.
        { id: 'f5', family_id: 'fam-1', member_id: null, category: 'sizes', label: 'Coat size', value: 'Age 8', notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: '2026-09-04T00:00:00.000Z', created_by: 'u', created_at: '', updated_at: '' },
      ],
      error: null,
    }));
    const tool = getTool('memory.recall')!;
    const res = await run(tool, scopeWith(db), {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ facts: [
        { id: 'f1', category: 'preference', label: 'Diet', value: 'vegetarian', member_id: null, pinned: false, from_person: true, expires_at: null },
        { id: 'f2', category: 'preference', label: 'Go-to dinner', value: 'Tacos', member_id: null, pinned: false, from_person: false, expires_at: null },
        { id: 'f3', category: 'preference', label: 'Snack', value: 'Apples', member_id: null, pinned: false, from_person: false, expires_at: null },
        { id: 'f4', category: 'sizes', label: 'Shoe size', value: 'US 2', member_id: null, pinned: false, from_person: true, expires_at: null },
      ] });
      expect(tool.summarize({}, res.data)).toBe('Recalled 4 facts');
    }
  });
});

describe('messages tools', () => {
  it('accepts the legacy create_announcement shape and reports both author columns were set', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'agent_activity') return { data: { id: 'activity-1' }, error: null };
      return call.kind === 'insert'
        ? { data: { ...(call.payload as Record<string, unknown>), id: 'ann-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString() }, error: null }
        : { data: null, error: null };
    });
    const tool = getTool('create_announcement')!;
    const res = await run(tool, scopeWith(db), { title: 'Grandma visits Sunday', body: 'Lunch at 1', pinned: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ id: 'ann-1', title: 'Grandma visits Sunday', body: 'Lunch at 1', pinned: true });
      expect(tool.summarize({}, res.data)).toBe('Posted the announcement "Grandma visits Sunday" and pinned it');
    }
    expect(calls.find((c) => c.kind === 'insert')?.payload).toMatchObject({ author_id: 'auth-user-1', author_member_id: 'member-1', is_pinned: true });
    expect(tool.consequences!({ title: 'Grandma visits Sunday', pinned: true })).toHaveLength(2);
  });

  it('sends to the family chat under either spelling of the text argument', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_conversations') return { data: { id: 'conv-1' }, error: null };
      if (call.table === 'family_members') return { data: MEMBERS[0], error: null };
      if (call.table === 'family_messages' && call.kind === 'insert') {
        return { data: { ...(call.payload as Record<string, unknown>), id: 'msg-1', sender_avatar: null, attachment_url: null, attachment_name: null, attachment_mime: null, reactions: {}, read_by: [], is_pinned: false, deleted_at: null, created_at: NOW.toISOString() }, error: null };
      }
      if (call.table === 'agent_activity') return { data: { id: 'activity-1' }, error: null };
      return { data: null, error: null };
    });
    const tool = getTool('messages.sendFamilyMessage')!;
    const res = await run(tool, scopeWith(db), { message: 'Dinner at 6!' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ id: 'msg-1', conversation_id: 'conv-1', content: 'Dinner at 6!', sender_name: 'Dana' });
      expect(tool.summarize({}, res.data)).toBe('Sent to the family chat: "Dinner at 6!"');
    }
    expect(calls.find((c) => c.table === 'family_messages' && c.kind === 'insert')?.payload).toMatchObject({ sender_id: 'auth-user-1', sender_name: 'Dana' });
    expect(tool.consequences!({ message: 'Dinner at 6!' })[0]).toContain('Dinner at 6!');
  });

  it('asks for the text when neither spelling is present, without a query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await run(getTool('messages.sendFamilyMessage')!, scopeWith(db), {})).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});
