// The Food slice of the assistant's context renders the household's allergies
// as "ALLERGIES (never serve): …" and each member's as "allergic to …". Both
// went through `joinNatural` at its default cap of eight, so a household with
// a ninth allergen had it folded into "(+1 more)": the assistant planning
// dinner was never told what it was. A household-level allergy fact (one with
// no member on it) appears ONLY in that union line, so nothing else in the
// prompt carried it either.
//
// This runs the real slice over the real `foodProfile`, on an in-memory
// database: the allergy and diet lists are rendered whole, and the lists that
// are merely tastes (likes, dislikes) keep their cap.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { extractFencedBlocks } from '@/lib/ai/safety/untrusted';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('server-only', () => ({}));

const { foodSlice } = await import('@/lib/ai/context/slices/food');

const FAMILY = 'fam-food-1';
const HOUSEHOLD_ALLERGENS = ['peanuts', 'almonds', 'cashews', 'walnuts', 'eggs', 'milk', 'wheat', 'soy', 'sesame', 'shrimp', 'salmon', 'kiwi'];
const KID_ALLERGENS = ['latex fruit', 'mango', 'banana', 'avocado', 'chestnut', 'papaya', 'fig', 'melon', 'tomato', 'celery'];
const DIETS = ['vegetarian', 'kosher', 'halal', 'gluten free', 'dairy-free', 'nut-free', 'keto', 'paleo', 'low-carb', 'pescatarian'];
const DISLIKES = ['olives', 'mushrooms', 'beets', 'liver', 'anchovy paste', 'okra', 'turnips', 'capers', 'fennel', 'radishes'];

function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    rpc: {
      family_allergies: (args) => (args.p_family_id === FAMILY
        ? [{ member_id: 'member-kid', allergies: KID_ALLERGENS.join(', ') }]
        : []),
    },
  });
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'auth-parent', display_name: 'Dana', role: 'parent', is_active: true, color: null, avatar_url: null, birthday: null },
    { id: 'member-kid', family_id: FAMILY, user_id: 'auth-kid', display_name: 'Rae', role: 'child', is_active: true, color: null, avatar_url: null, birthday: null },
  ]);
  db.seed('family_facts', [
    // Household-level: no member on the row, so only the union line can carry them.
    ...HOUSEHOLD_ALLERGENS.map((value, i) => ({ id: `fact-a-${String(i).padStart(2, '0')}`, family_id: FAMILY, member_id: null, category: 'preference', label: 'Allergy', value })),
    ...DIETS.map((value, i) => ({ id: `fact-d-${String(i).padStart(2, '0')}`, family_id: FAMILY, member_id: 'member-parent', category: 'preference', label: 'Diet', value })),
    ...DISLIKES.map((value, i) => ({ id: `fact-x-${String(i).padStart(2, '0')}`, family_id: FAMILY, member_id: 'member-parent', category: 'preference', label: "Doesn't eat", value })),
  ]);
  return db;
}

async function lines(): Promise<string[]> {
  const db = household();
  const scope: ServiceScope = {
    db, familyId: FAMILY, userId: 'auth-parent', memberId: 'member-parent', role: 'parent',
    actorKind: 'member', tz: 'UTC', now: new Date('2026-09-16T12:00:00Z'),
  };
  const loaded = await foodSlice.load(scope, {
    now: new Date('2026-09-16T12:00:00Z'), tz: 'UTC', todayKey: '2026-09-16',
    weekFromIso: '2026-09-16T00:00:00.000Z', weekToIso: '2026-09-23T00:00:00.000Z',
    viewer: { role: 'parent', memberId: 'member-parent', canManage: true },
    members: [], pageContext: null,
  });
  if (!loaded.ok) throw new Error(`food slice failed: ${loaded.error}`);
  return loaded.data.lines;
}

const fenced = (line: string, label: string) => extractFencedBlocks(line).filter((b) => b.label === label).map((b) => b.text);
const one = (all: string[], starts: string) => {
  const hit = all.filter((line) => line.startsWith(starts));
  expect(hit, `one line starting ${JSON.stringify(starts)}`).toHaveLength(1);
  return hit[0];
};

describe('the Food slice tells the assistant every allergy the household records', () => {
  it('names all twenty-two household allergens on the never-serve line, with nothing folded into "more"', async () => {
    const line = one(await lines(), '- ALLERGIES (never serve): ');
    expect(fenced(line, 'ALLERGY')).toEqual([...KID_ALLERGENS, ...HOUSEHOLD_ALLERGENS]);
    expect(line).not.toMatch(/\(\+\d+ more\)/);
  });

  it("names all ten of a member's own allergens on their line", async () => {
    const line = one(await lines(), '- Rae: ');
    expect(fenced(line, 'ALLERGY')).toEqual(KID_ALLERGENS);
    expect(line).not.toMatch(/\(\+\d+ more\)/);
  });

  it('renders the diet lists whole too: a diet is a rule for the cook, not a taste', async () => {
    const all = await lines();
    expect(fenced(one(all, '- Diet: '), 'DIET')).toEqual(DIETS);
    expect(fenced(one(all, '- Dana: '), 'DIET')).toEqual(DIETS);
  });

  it('still caps the lists that are only tastes, so one long list cannot eat the budget', async () => {
    const line = one(await lines(), '- Dana: ');
    expect(fenced(line, 'DISLIKE')).toEqual(DISLIKES.slice(0, 8));
    expect(line).toContain('(+2 more)');
  });
});
