// "Add milk" with Milk already unbought adds nothing, from chat or a speaker.
//
// The chat assistant's add_grocery_item (which shadows the registry's
// groceries.addItems, so it IS the chat path) and the voice bridge's spoken
// capture both wrote grocery_items with a raw insert: no check against the open
// lines, no aisle. Every other writer goes through the grocery service, whose
// whole point is that "Bubaly adding milk skips it" — so on these two surfaces
// a request the family repeated, or an item already on the list, became a
// second line.
//
// Both paths are driven for real against an in-memory database.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { answerAssistant, type AssistantLink } from '@/lib/assistant/service';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';

function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    grocery_lists: { is_archived: false, archived_at: null },
    grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
  } });
  db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries', created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('grocery_items', [{ id: 'milk', family_id: FAMILY, list_id: 'list-1', name: 'Milk', created_by: 'user-1' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true }]);
  return db;
}
const names = (db: ReturnType<typeof household>) => db.table('grocery_items').map((row) => row.name);

describe('the chat assistant\'s add_grocery_item', () => {
  const ctx: AssistantCtx = {
    familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent',
    members: [{ id: 'member-1', display_name: 'Dana' }], tz: 'America/New_York',
  };
  const tool = (db: ReturnType<typeof household>) => buildAssistantTools(db, ctx).find((t) => t.name === 'add_grocery_item')!;

  it('skips an item already open on the list and says so', async () => {
    const db = household();

    const result = await tool(db).execute({ item: 'milk' });

    expect(result).toMatchObject({ ok: true, summary: 'milk is already on the grocery list.' });
    expect(names(db)).toEqual(['Milk']);
  });

  it('adds a new item once, filed by aisle', async () => {
    const db = household();

    await tool(db).execute({ item: 'Eggs', quantity: '12' });
    await tool(db).execute({ item: 'eggs' });

    expect(names(db)).toEqual(['Milk', 'Eggs']);
    const eggs = db.table('grocery_items').find((row) => row.name === 'Eggs');
    expect(eggs).toMatchObject({ quantity: '12', created_by: 'user-1' });
    expect(eggs?.category).toBeTruthy();
  });
});

describe('the voice bridge\'s spoken capture', () => {
  const NOW = new Date('2026-09-18T12:00:00Z');
  const link: AssistantLink = {
    id: 'link-1', family_id: FAMILY, user_id: 'user-1', provider: 'alexa', scopes: ['ask', 'capture'], timezone: 'America/New_York',
  };
  const say = (db: ReturnType<typeof household>, utterance: string) =>
    answerAssistant(db, link, classifyAssistantUtterance(utterance, NOW, link.timezone), NOW);

  it('does not write a second Milk, and adds what is new — once, even when said twice', async () => {
    const db = household();

    const reply = await say(db, 'add milk, eggs and eggs to the shopping list');
    await say(db, 'add eggs to the shopping list');

    expect(reply.outcome).toBe('captured');
    expect(names(db)).toEqual(['Milk', 'eggs']);
    expect(db.table('grocery_items').find((row) => row.name === 'eggs')?.category).toBeTruthy();
  });
});
