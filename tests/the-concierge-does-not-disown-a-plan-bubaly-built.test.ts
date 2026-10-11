// L-trips-1 (trips audit #18, follow-up round 2).
//
// The trip concierge's "Auto-build trip" button, driven end to end: the real
// component asks the real /api/vacations/ai route (over an in-memory database
// that applies real filters), shows the question the 409 picks, and on a yes
// asks for the rebuild. What is asserted is the sentence a parent reads and
// what is left on the trip after they answer it.
//
// When the route could not replace anything (`replaces: false`) the question
// said "This trip already has a plan that Bubaly did not build, so it cannot be
// replaced" — in every catalogue. The plans that reach that question are,
// mostly, plans Bubaly DID build:
//
//   • a plan this route or the assistant's `trips.buildPlan` wrote before the
//     builder stamped its rows (no stamp, so nothing for a rebuild to take);
//   • a stamped plan whose every suggestion the family has since booked.
//
// So the old false "Replace it?" promise had become a false statement about
// where the plan came from, in the same dialog. The question now states the
// rule (Bubaly replaces only its own unbooked suggestions; booked items, things
// added by hand and plans from an earlier version of Bubaly are kept) instead
// of guessing at the plan's origin.
//
// And the "Replace it with a fresh one?" question had the smaller form of the
// same fault: a trip holding an older unstamped plan beside a stamped one gets
// `replaces: true`, and a confirmed rebuild keeps the older plan. That question
// now says what goes and what stays, and the test confirms it and checks both.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { ServiceScope } from '@/lib/services/types';
import { CONCIERGE_PLAN_MARKER } from '@/lib/vacations/ai-output';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const state = vi.hoisted(() => ({
  db: null as unknown,
  complete: vi.fn(),
  locale: 'en-US' as string,
  slots: [] as unknown[],
  cursor: 0,
  questions: [] as string[],
  answer: false,
  success: vi.fn(),
  error: vi.fn(),
}));

// The route's world: the signed-in parent, the database, the model.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'family-1', role: 'parent', family: { name: 'Family One', timezone: 'America/Chicago' }, member: { id: 'member-1' } },
})) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => entitledServiceClient() }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  resolveProvider: async () => ({ complete: state.complete, model: 'test-model' }),
  isAIConfigured: async () => true,
}));
vi.mock('@/lib/vacations/packing', () => ({ suggestPacking: () => [{ name: 'Socks', category: 'clothes', quantity: 2 }] }));

// The component's world: a hook-slot harness (this suite has no DOM), the
// family's catalogue through production's own lookup, and a toast.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [state.slots[index], (value: unknown) => {
      state.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(state.slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = { current: initial };
    return state.slots[index] as { current: unknown };
  },
  // The conversation history load and the scroll are not what this is about.
  useEffect: () => {},
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1' }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('The browser client is not used by the build button'); } }));
vi.mock('@/components/vacations/trip-confirmation-import', () => ({ TripConfirmationImport: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ loading: _loading, variant: _variant, size: _size, ...props }: Record<string, unknown>) => createElement('button', props),
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale as LocaleCode), key, params),
  };
});

import { TripConcierge } from '@/components/vacations/trip-concierge';
import { POST } from '@/app/api/vacations/ai/route';
import { buildPlan } from '@/lib/services/trips';
import { getMessages } from '@/lib/i18n/messages';

const FAMILY = 'family-1';
const TRIP = 'trip-1';
const READ_AT = '2026-09-01T09:00:00.000000+00:00';
const BUILT_AT = '2026-09-01T10:00:00.123456+00:00';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;

const ADD_ALONGSIDE = "Nothing in this trip's current plan can be replaced automatically: Bubaly only replaces its own unbooked suggestions, and keeps booked items, anything added by hand and plans made by an earlier version of Bubaly. Add a fresh plan alongside it? Edited budget lines will be overwritten.";
const REPLACE = "This trip already has a plan. Replace Bubaly's unbooked suggestions with a fresh plan? Booked items, anything added by hand and plans made by an earlier version of Bubaly are kept. Edited budget lines will be overwritten.";

/** The sentence each catalogue used to say: the plan was not Bubaly's. */
const DISOWNS: Record<(typeof LOCALES)[number], RegExp> = {
  'en-US': /Bubaly did not build/,
  'de-DE': /den Bubaly nicht erstellt/,
  'es-ES': /Bubaly no creó/,
  'fr-FR': /Bubaly n’a pas créé/,
  'it-IT': /Bubaly non ha creato/,
  'nl-NL': /Bubaly niet heeft gemaakt/,
  'pt-PT': /o Bubaly não criou/,
};
/** And the whole-plan promise the replace question made, which an older plan beside a stamped one broke. */
const WHOLE_PLAN: Record<(typeof LOCALES)[number], RegExp> = {
  'en-US': /Replace it with a fresh one\?/,
  'de-DE': /Durch einen neuen ersetzen\?/,
  'es-ES': /¿Sustituirlo por uno nuevo\?/,
  'fr-FR': /Le remplacer par un nouveau \?/,
  'it-IT': /Sostituirlo con uno nuovo\?/,
  'nl-NL': /Vervangen door een nieuw plan\?/,
  'pt-PT': /Substituí-lo por um novo\?/,
};
/** What both questions now tell every family: a plan from an earlier Bubaly stays. */
const EARLIER_BUBALY_KEPT: Record<(typeof LOCALES)[number], string> = {
  'en-US': 'plans made by an earlier version of Bubaly',
  'de-DE': 'Pläne aus einer früheren Version von Bubaly',
  'es-ES': 'los planes creados por una versión anterior de Bubaly',
  'fr-FR': 'les plans créés par une version antérieure de Bubaly',
  'it-IT': 'i piani creati da una versione precedente di Bubaly',
  'nl-NL': 'plannen van een eerdere versie van Bubaly',
  'pt-PT': 'os planos criados por uma versão anterior do Bubaly',
};

const planNamed = (name: string) => JSON.stringify({
  activities: [{ name, cost: 0 }],
  itinerary: [{ day: 1, title: `${name} morning` }, { day: 2, title: `${name} afternoon` }],
  budget: [{ category: 'food', planned: 25 }],
});

/** The 0070 `set_updated_at` trigger, which the rebuild's write-time fence reads. */
let tick = 0;
function seeded() {
  const db = createInMemorySupabase({ defaults: {
    vacation_activities: { booked: false, notes: null },
    vacation_itinerary_items: { booked: false, notes: null, sort_order: 0, member_ids: [] },
  } });
  db.seed('vacations', [{
    id: TRIP, family_id: FAMILY, title: 'Family break', destination: 'Boston', kind: 'domestic', status: 'planning',
    start_date: '2026-10-01', end_date: '2026-10-03', timezone: 'America/New_York', is_international: false,
    budget_cents: null, currency: 'USD', updated_at: READ_AT,
  }]);
  db.seed('vacation_itinerary_days', ['2026-10-01', '2026-10-02', '2026-10-03'].map((day, i) => ({
    id: `day-${i + 1}`, family_id: FAMILY, vacation_id: TRIP, day_date: day,
  })));
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    if (name.startsWith('vacation')) {
      const update = builder.update.bind(builder);
      builder.update = ((patch: Row) => update({ ...patch, updated_at: `2026-10-11T00:00:${String(++tick).padStart(2, '0')}.000000+00:00` })) as never;
    }
    return builder;
  }) as typeof db.from);
  state.db = db;
  return db;
}

/** A plan an earlier Bubaly wrote — this route or `trips.buildPlan` before either stamped its rows. */
function earlierBubalyPlan(db: InMemorySupabase) {
  db.seed('vacation_activities', [
    { id: 'act-old-1', family_id: FAMILY, vacation_id: TRIP, name: 'Aquarium', booked: false, notes: null, created_by: 'user-1', updated_at: BUILT_AT },
  ]);
  db.seed('vacation_itinerary_items', [
    { id: 'item-old-1', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Aquarium', booked: false, notes: null, created_by: 'user-1', updated_at: BUILT_AT },
    { id: 'item-old-2', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-2', kind: 'meal', day_part: 'evening', title: 'Lobster dinner', booked: false, notes: null, created_by: 'user-1', updated_at: BUILT_AT },
  ]);
}

/** The assistant's planner, for real, stamping its rows as this deploy does. */
async function assistantPlan(db: InMemorySupabase) {
  const provider = {
    id: 'fake', model: 'fake',
    structuredCompletion: async () => ({ text: JSON.stringify({
      activities: [{ name: 'Fenway tour', category: 'tour', location: null, family_friendly: true, cost_usd: 30 }],
      itinerary: [{ day: 1, day_part: 'morning', title: 'Fenway tour', kind: 'activity' }],
      budget: [],
    }), refusal: null, usage: null }),
  } as unknown as AIProvider;
  const scope: ServiceScope = {
    db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/Chicago',
  };
  expect(await buildPlan(scope, TRIP, { provider })).toMatchObject({ ok: true, data: { built: true } });
}

const rows = (db: InMemorySupabase, table: string) => db.table(table) as Row[];
const ids = (db: InMemorySupabase, table: string) => rows(db, table).map((r) => String(r.id));

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

/**
 * Press "Auto-build trip" on the family's screen, answer the question with
 * `answer`, and wait for the button to settle. Returns the question shown.
 */
async function pressAutoBuild(answer: boolean): Promise<string> {
  state.answer = answer;
  state.questions = [];
  state.success.mockClear();
  state.error.mockClear();
  state.cursor = 0;
  const screen = TripConcierge({ vacationId: TRIP }) as ReactNode;
  const label = getMessages(state.locale as LocaleCode)['tripConcierge.autoBuildTrip'];
  const button = nodes(screen).find((node) => typeof node.props.onClick === 'function' && text(node).trim() === label);
  if (!button) throw new Error(`No "${label}" button on the concierge`);
  (button.props.onClick as () => void)();
  await vi.waitFor(() => expect(state.questions).toHaveLength(1));
  if (answer) await vi.waitFor(() => expect(state.success.mock.calls.length + state.error.mock.calls.length).toBe(1));
  return state.questions[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  state.complete.mockReset();
  state.complete.mockResolvedValue({ text: planNamed('Park') });
  state.slots = [];
  state.cursor = 0;
  state.locale = 'en-US';
  tick = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('confirm', (question: string) => { state.questions.push(question); return state.answer; });
  // The component's only request goes to the real route; anything else is a leak.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url !== '/api/vacations/ai') throw new Error(`Network is forbidden in this test (${url})`);
    return POST(new NextRequest('http://localhost/api/vacations/ai', init as ConstructorParameters<typeof NextRequest>[1]));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the "add alongside" question does not say Bubaly did not build the plan', () => {
  it('a plan an earlier Bubaly built: the question states the rule, and a yes keeps that plan beside the new one', async () => {
    const db = seeded();
    earlierBubalyPlan(db);

    expect(await pressAutoBuild(true)).toBe(ADD_ALONGSIDE);
    expect(state.success).toHaveBeenCalledTimes(1);
    // What the question said would stay, stayed; the new plan is beside it.
    expect(ids(db, 'vacation_activities')).toContain('act-old-1');
    expect(ids(db, 'vacation_itinerary_items')).toEqual(expect.arrayContaining(['item-old-1', 'item-old-2']));
    expect(rows(db, 'vacation_activities').map((r) => r.name)).toEqual(['Aquarium', 'Park']);
  });

  it('a plan the assistant built whose suggestions have all been booked: the same question, and the bookings stay', async () => {
    const db = seeded();
    await assistantPlan(db);
    for (const table of ['vacation_activities', 'vacation_itinerary_items']) {
      for (const row of rows(db, table)) {
        const { error } = await db.from(table).update({ booked: true }).eq('id', String(row.id)).eq('family_id', FAMILY).select('id');
        expect(error).toBeNull();
      }
    }

    expect(await pressAutoBuild(true)).toBe(ADD_ALONGSIDE);
    expect(rows(db, 'vacation_activities').filter((r) => r.name === 'Fenway tour')).toEqual([expect.objectContaining({ booked: true, notes: CONCIERGE_PLAN_MARKER })]);
    expect(rows(db, 'vacation_itinerary_items').filter((r) => r.title === 'Fenway tour')).toEqual([expect.objectContaining({ booked: true })]);
  });

  it.each(LOCALES)('%s: neither question disowns the plan or promises to replace all of it, and both say an earlier Bubaly plan stays', async (locale) => {
    state.locale = locale;

    // replaces: false — only a plan an earlier Bubaly built.
    const onlyOld = seeded();
    earlierBubalyPlan(onlyOld);
    const alongside = await pressAutoBuild(false);
    expect(alongside).toBe(getMessages(locale)['tripConcierge.addAlongsideExistingPlan']);

    // replaces: true — the assistant's stamped plan beside that older one
    // (the planner refuses a trip that already has a plan, so it goes first).
    const mixed = seeded();
    await assistantPlan(mixed);
    earlierBubalyPlan(mixed);
    const replace = await pressAutoBuild(false);
    expect(replace).toBe(getMessages(locale)['tripConcierge.rebuildExistingPlan']);

    for (const question of [alongside, replace]) {
      expect(question).not.toMatch(DISOWNS[locale]);
      expect(question).not.toMatch(WHOLE_PLAN[locale]);
      expect(question).toContain(EARLIER_BUBALY_KEPT[locale]);
    }
    // A "no" writes nothing at all.
    expect(rows(onlyOld, 'vacation_activities').map((r) => r.name)).toEqual(['Aquarium']);
    expect(rows(mixed, 'vacation_activities').map((r) => r.name).sort()).toEqual(['Aquarium', 'Fenway tour']);
  });
});

describe('the "replace" question says what goes and what stays', () => {
  it('an earlier plan beside a stamped one: a yes replaces the stamped suggestions and keeps the earlier plan, as asked', async () => {
    const db = seeded();
    await assistantPlan(db);
    earlierBubalyPlan(db);

    expect(await pressAutoBuild(true)).toBe(REPLACE);
    expect(state.success).toHaveBeenCalledTimes(1);
    // The stamped, unbooked suggestions went…
    expect(rows(db, 'vacation_activities').map((r) => r.name)).not.toContain('Fenway tour');
    expect(rows(db, 'vacation_itinerary_items').map((r) => r.title)).not.toContain('Fenway tour');
    // …and the earlier Bubaly plan stayed, which is what the question said.
    expect(ids(db, 'vacation_activities')).toContain('act-old-1');
    expect(ids(db, 'vacation_itinerary_items')).toEqual(expect.arrayContaining(['item-old-1', 'item-old-2']));
    expect(rows(db, 'vacation_activities').map((r) => r.name).sort()).toEqual(['Aquarium', 'Park']);
  });
});
