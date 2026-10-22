// Fridge Chef's "Plan for dinner" puts ONE dinner on tonight.
//
// Phase 3 of /api/ai/pantry-chef inserted a new `meals` row and then a raw
// `meal_plans` dinner row. Nothing replaced what tonight already held and no
// unique (family, date, type) key stops a second row, so a family with dinner
// planned — or one that tapped "Plan for dinner" on two cards from one scan —
// got two dinners in one slot, the route said `planned: true`, and the meals
// page's week read refused that week on every load ("We couldn't load all meal
// choices"), Retry included. When the plan insert failed, the dish stayed in
// the library, and each retry added another copy.
//
// The route is driven for real against an in-memory database, and the week is
// read back with the meals page's own reader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { readMealWeek } from '@/lib/meals/collection-reads';
import { mealWeekDays } from '@/lib/meals/week';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const TODAY = '2026-09-14';

// `servers`: the client each next request is handed, in order, so two racing
// requests can each see the database as their own writer; otherwise `db`.
const h = vi.hoisted(() => ({ db: null as unknown, servers: [] as unknown[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.servers.shift() ?? h.db, createServiceClient: () => { throw new Error('the photo phase is not under test'); } }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Smart Kitchen gate is covered by tests/fridge-chef-is-a-kitchen-feature.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));

import { POST } from '@/app/api/ai/pantry-chef/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let fault: (table: string, calls: FaultCall[]) => { message: string } | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  base = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { recipe_url: null, image_url: null, meal_type: 'dinner', notes: null, ingredients: [] },
    meal_plans: { idempotency_key: null },
  } });
  fault = () => null;
  h.db = withFaults(base, (table, calls) => fault(table, calls));
  h.servers = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const plan = (title: string, steps = 'Simmer everything.') => POST(new NextRequest('https://fixture.invalid/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ addToPlan: { title, steps, have: ['carrots'], need: ['stock'] } }),
}));
const tonight = () => base.table('meal_plans').filter((row) => row.plan_date === TODAY && row.meal_type === 'dinner');
const week = () => readMealWeek(base as unknown as SupabaseClient<Database>, FAMILY, mealWeekDays('2026-09-14'));

describe('Plan for dinner replaces tonight\'s dinner', () => {
  it('a dinner already planned is replaced, not joined, and the meals page still reads the week', async () => {
    base.seed('meals', [{ id: 'tacos', family_id: FAMILY, name: 'Tacos', ingredients: [{ name: 'tortillas', qty: null, unit: null }] }]);
    base.seed('meal_plans', [{ id: 'planned', family_id: FAMILY, meal_id: 'tacos', plan_date: TODAY, meal_type: 'dinner', created_by: 'user-one' }]);

    const response = await plan('Vegetable soup');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ planned: true, planDate: TODAY, replaced: true });
    expect(tonight()).toHaveLength(1);
    const soup = base.table('meals').find((meal) => meal.name === 'Vegetable soup');
    expect(tonight()[0].meal_id).toBe(soup?.id);
    // The recipe's method rides along on the dish, as it always did.
    expect(soup?.notes).toBe('Simmer everything.');

    const read = await week();
    expect(read.error).toBeNull();
    expect(read.data?.map((row) => row.meal?.name)).toEqual(['Vegetable soup']);
  });

  it('two cards planned from one scan leave one dinner, the second', async () => {
    expect((await plan('Vegetable soup')).status).toBe(200);
    const second = await plan('Carrot curry');

    expect(await second.json()).toMatchObject({ planned: true, replaced: true });
    expect(tonight()).toHaveLength(1);
    expect(base.table('meals').find((meal) => meal.id === tonight()[0].meal_id)?.name).toBe('Carrot curry');
    expect((await week()).error).toBeNull();
  });

  it('a plan write that fails leaves no dish behind, so retries do not pile up copies', async () => {
    fault = (table, calls) => (table === 'meal_plans' && calls.some((call) => call.method === 'insert') ? { message: 'Fixture insert refused' } : null);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await plan('Vegetable soup');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'pantryChef.couldNotAddThatRecipe' });
    }

    expect(base.table('meals')).toEqual([]);
    expect(base.table('meal_plans')).toEqual([]);
  });

  it('planning the same recipe again reuses its dish rather than cloning it', async () => {
    await plan('Vegetable soup');
    await plan('Vegetable soup');

    expect(base.table('meals').filter((meal) => meal.name === 'Vegetable soup')).toHaveLength(1);
    expect(tonight()).toHaveLength(1);
  });
});

// ── Two taps at once ──────────────────────────────────────────────────────────
//
// AUD-1041-SLOT-RESTORE. Two "Plan for dinner" taps both read tonight's Tacos.
// A cleared it; B's clear found nothing, so B failed and rolled back — and its
// rollback read an empty slot (A had cleared it and not yet written), waited,
// and put Tacos back AFTER A had written and verified its curry and answered
// "planned". Tonight then held two dinners and the meals page refused the
// week. There is still no unique (family, date, type) index to refuse the
// second row (held owner SQL); these cases pin what the service does without
// it, each interleaving held step by step on the requests themselves.

type Step = { op: 'select' | 'insert' | 'delete'; n: number };
type Reply = { data: unknown; error: unknown; count: number | null; status: number; statusText: string };
type Hooks = {
  /** Runs before this writer's nth meal_plans request of that kind is answered; a reply it returns is answered instead. */
  before?: (step: Step) => unknown;
  /** Runs once that request has been answered, before the writer sees the answer. */
  after?: (step: Step) => unknown;
};

/** The database as one writer sees it: its meal_plans requests held at the hooks, everything else untouched. */
function writer(hooks: Hooks = {}) {
  const counts = { select: 0, insert: 0, delete: 0 };
  return new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== 'from') return typeof value === 'function' ? value.bind(target) : value;
      return (table: string) => {
        const builder = target.from(table) as unknown as Record<string, unknown> & PromiseLike<Reply>;
        if (table !== 'meal_plans') return builder;
        let op: Step['op'] = 'select';
        for (const method of ['insert', 'delete'] as const) {
          const original = builder[method] as (...args: unknown[]) => unknown;
          builder[method] = (...args: unknown[]) => { op = method; return original.apply(builder, args); };
        }
        const answer = builder.then.bind(builder);
        builder.then = ((resolve, reject) => (async () => {
          const step = { op, n: ++counts[op] };
          const replaced = (await hooks.before?.(step)) as Reply | undefined;
          const reply = replaced ?? await new Promise<Reply>((done) => { void answer(done); });
          await hooks.after?.(step);
          return reply;
        })().then(resolve, reject)) as PromiseLike<Reply>['then'];
        return builder;
      };
    },
  });
}

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open: () => open(), opened };
}

const refused: Reply = {
  data: null, count: null, status: 400, statusText: 'Bad Request',
  error: { code: 'XX000', message: 'Fixture insert refused', details: null, hint: null },
};
const tacosTonight = () => {
  base.seed('meals', [{ id: 'tacos', family_id: FAMILY, name: 'Tacos', ingredients: [{ name: 'tortillas', qty: null, unit: null }] }]);
  base.seed('meal_plans', [{ id: 'planned', family_id: FAMILY, meal_id: 'tacos', plan_date: TODAY, meal_type: 'dinner', created_by: 'user-one' }]);
};
const dishTonight = () => tonight().map((row) => base.table('meals').find((meal) => meal.id === row.meal_id)?.name);
const weekDishes = async () => {
  const read = await week();
  expect(read.error).toBeNull();
  return read.data?.map((row) => row.meal?.name);
};

describe('two "Plan for dinner" taps that race leave one dinner', () => {
  it('a tap whose clear found tonight\'s dinner already gone does not put it back beside the new one', async () => {
    tacosTonight();
    const aAtClear = gate(), aCleared = gate(), bRead = gate(), bReread = gate();
    let aDone: Promise<Response> = new Promise(() => {});
    const a = writer({
      before: async ({ op, n }) => {
        // Both have read the Tacos before either clears.
        if (op === 'delete' && n === 1) { aAtClear.open(); await bRead.opened; }
        // A checks its cleared slot only once B's rollback has looked at it too.
        if (op === 'select' && n === 2) await bReread.opened;
      },
      after: ({ op, n }) => { if (op === 'delete' && n === 1) aCleared.open(); },
    });
    const b = writer({
      before: async ({ op, n }) => {
        // B clears after A did, so its clear removes nothing and it rolls back.
        if (op === 'delete' && n === 1) await aCleared.opened;
        // Whatever B's rollback writes lands only after A has answered.
        if (op === 'insert' && n === 1) await aDone;
      },
      after: ({ op, n }) => {
        if (op === 'select' && n === 1) bRead.open();
        if (op === 'select' && n === 2) bReread.open();
      },
    });

    h.servers.push(a);
    aDone = plan('Carrot curry');
    await aAtClear.opened;
    h.servers.push(b);
    const bDone = plan('Lentil stew');
    void bDone.finally(() => bReread.open());
    const [first, second] = await Promise.all([aDone, bDone]);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ planned: true, planDate: TODAY, replaced: true });
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual({ error: 'pantryChef.couldNotAddThatRecipe' });
    // The meals page reads the week — it refuses one with two dinners tonight.
    expect(await weekDishes()).toEqual(['Carrot curry']);
    expect(dishTonight()).toEqual(['Carrot curry']);
    // And the failed tap's own new dish is not left behind in the library.
    expect(base.table('meals').map((meal) => meal.name).sort()).toEqual(['Carrot curry', 'Tacos']);
  });

  it('control: the same two taps one after the other — the second replaces the first', async () => {
    tacosTonight();
    h.servers.push(writer(), writer());

    const first = await plan('Carrot curry');
    const second = await plan('Lentil stew');

    expect(await first.json()).toEqual({ planned: true, planDate: TODAY, replaced: true });
    expect(await second.json()).toEqual({ planned: true, planDate: TODAY, replaced: true });
    expect(dishTonight()).toEqual(['Lentil stew']);
    expect(await weekDishes()).toEqual(['Lentil stew']);
  });

  it('a rollback that finds its slot filled after it looked withdraws what it put back', async () => {
    tacosTonight();
    let other: Response | null = null;
    // B clears the Tacos itself, its own write is refused, and it rolls back;
    // a whole second tap runs between the rollback's look at the slot and its
    // write.
    h.servers.push(writer({
      before: async ({ op, n }) => {
        if (op === 'insert' && n === 1) return refused;
        if (op === 'insert' && n === 2) other = await plan('Carrot curry');
        return undefined;
      },
    }));

    const failed = await plan('Lentil stew');

    expect(failed.status).toBe(500);
    expect(other).not.toBeNull();
    expect(other!.status).toBe(200);
    expect(await other!.json()).toEqual({ planned: true, planDate: TODAY, replaced: false });
    expect(dishTonight()).toEqual(['Carrot curry']);
    expect(await weekDishes()).toEqual(['Carrot curry']);
  });

  it('a plan does not answer "planned" while its last read shows a second dinner beside its own', async () => {
    tacosTonight();
    const aAtReceipt = gate(), bRestored = gate();
    let aDone: Promise<Response> = new Promise(() => {});
    // A's fourth meal_plans read is the receipt it answers from; it is held
    // until B's rollback has written the Tacos back.
    const a = writer({
      before: async ({ op, n }) => { if (op === 'select' && n === 4) { aAtReceipt.open(); await bRestored.opened; } },
    });
    h.servers.push(writer({
      before: async ({ op, n }) => {
        if (op === 'insert' && n === 1) return refused;
        if (op === 'insert' && n === 2) { h.servers.push(a); aDone = plan('Carrot curry'); await aAtReceipt.opened; }
        return undefined;
      },
      // B reads back what it restored only after A has answered.
      after: async ({ op, n }) => { if (op === 'insert' && n === 2) { bRestored.open(); await aDone; } },
    }));

    const failed = await plan('Lentil stew');
    const unconfirmed = await aDone;

    expect(failed.status).toBe(500);
    expect(unconfirmed.status).toBe(500);
    // A's dinner was not withdrawn by A; B's restored Tacos were, by B.
    expect(dishTonight()).toEqual(['Carrot curry']);
    expect(await weekDishes()).toEqual(['Carrot curry']);
  });
});
