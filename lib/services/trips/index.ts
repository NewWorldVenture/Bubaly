// Trips: the vacation planner's tables (0070: `vacations` + `vacation_*`)
// behind one service, so "prepare our Florida trip" can find the trip, build
// a plan, pack for everyone, score readiness, put it on the calendar and
// find what the trip collides with — through the same code the /vacations
// module and its AI route use.
//
// WHAT COMES FROM A MODEL AND WHAT DOES NOT. Only `buildPlan` asks a model,
// and it does so through `lib/ai/structured.ts` with a strict schema — never
// by scraping JSON out of prose the way the legacy route did. Packing lists,
// readiness scores, conflicts and calendar entries are all rule-based over
// the trip's own rows (`lib/vacations/*`), so they are the same every time
// and cost nothing.
//
// ROLLBACK. `buildPlan` writes to four tables. There is no transaction across
// PostgREST calls, so it records every id it creates and deletes them in
// reverse order if a later insert fails — the family sees either a whole plan
// or no plan, never half an itinerary with no budget.
//
// UNITS. Vacation tables store cents (`budget_cents`, `cost_cents`), unlike
// the finance tables. Public inputs take dollars because that is what a
// person says; the conversion happens once, here.
import 'server-only';
import { z } from 'zod';
import { structured } from '@/lib/ai/structured';
import type { AIProvider } from '@/lib/ai/provider';
import type { Tables, VacBudgetCategory, VacDayPart, VacItemKind, VacationKind, VacationStatus } from '@/lib/database.types';
import { summarizeBudget, type BudgetSummary } from '@/lib/vacations/budget';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';
import { dateRange, tripNights } from '@/lib/vacations/dates';
import { suggestPacking } from '@/lib/vacations/packing';
import { computeReadiness as scoreReadiness, type ReadinessResult } from '@/lib/vacations/readiness';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { createEvent, searchEvents, type CalendarEvent } from '../calendar';
import { getMembers, type FamilyMember } from '../family';
import { withIdempotency } from '../idempotency';
import { listEventsBetween, listHomeworkDue, type HomeworkRow, type SchoolEventRow } from '../school';
import { dayKeyInTz, scopeNow, zonedDayBoundsMs, zonedTimeMs } from '../scope';
import { listPracticesBetween, type SportsEventRow } from '../sports';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type VacationRow = Tables<'vacations'>;
export type VacationMemberRow = Tables<'vacation_members'>;
export type PackingListRow = Tables<'vacation_packing_lists'>;
export type PackingItemRow = Tables<'vacation_packing_items'>;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const KINDS: VacationKind[] = ['road_trip', 'flight', 'cruise', 'theme_park', 'international', 'domestic', 'staycation', 'camping', 'other'];
const LIVE_STATUSES: VacationStatus[] = ['planning', 'booked', 'active'];
const BUDGET_CATEGORIES = ['flights', 'lodging', 'transportation', 'activities', 'food', 'shopping', 'insurance', 'fees', 'misc'] as const;
const DAY_PARTS = ['morning', 'afternoon', 'evening', 'all_day'] as const;
const ITEM_KINDS = ['activity', 'meal', 'travel', 'reservation', 'free_time', 'note', 'reminder'] as const;
/** Passports must usually be valid this long past the return date. */
const PASSPORT_VALIDITY_DAYS = 183;

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}

// ── snapshot ──────────────────────────────────────────────────────────────────

export type TripSnapshot = {
  trip: VacationRow;
  travelers: VacationMemberRow[];
  lodging: Tables<'vacation_lodging'>[];
  flights: Tables<'vacation_flights'>[];
  transport: Tables<'vacation_transportation'>[];
  activities: Tables<'vacation_activities'>[];
  reservations: Tables<'vacation_reservations'>[];
  budgets: Tables<'vacation_budgets'>[];
  expenses: Tables<'vacation_expenses'>[];
  packingLists: PackingListRow[];
  packingItems: PackingItemRow[];
  documents: Tables<'vacation_documents'>[];
  emergencyContacts: Tables<'vacation_emergency_contacts'>[];
  days: Tables<'vacation_itinerary_days'>[];
  items: Tables<'vacation_itinerary_items'>[];
  weather: Tables<'vacation_weather_snapshots'>[];
  nights: number;
  hasChildren: boolean;
  budgetSummary: BudgetSummary;
};

/** Everything known about one trip, family-scoped on every table. */
export async function getTrip(scope: ServiceScope, vacationId: string): Promise<ServiceResult<TripSnapshot>> {
  if (!vacationId?.trim()) return fail('Which trip?', { code: SERVICE_CODES.invalidInput });
  const { data: trip, error } = await scope.db
    .from('vacations')
    .select('*')
    .eq('id', vacationId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:trips] trip read failed', error);
    return fail(describeDbError(error, 'Could not load that trip.'), { code: SERVICE_CODES.db });
  }
  if (!trip) return fail('That trip could not be found.', { code: SERVICE_CODES.notFound });

  const results = await Promise.all([
    scope.db.from('vacation_members').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_lodging').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_flights').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_transportation').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_activities').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_reservations').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_budgets').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_expenses').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_packing_lists').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_packing_items').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_documents').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_emergency_contacts').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_itinerary_days').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_itinerary_items').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
    scope.db.from('vacation_weather_snapshots').select('*').eq('family_id', scope.familyId).eq('vacation_id', vacationId).limit(1000),
  ]);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    // A readiness score or a packing list built on a partial read would be
    // confidently wrong, so a single failed table fails the whole snapshot.
    console.error('[service:trips] trip detail read failed', failed.error);
    return fail(describeDbError(failed.error, 'Trip details are temporarily unavailable.'), { code: SERVICE_CODES.db });
  }
  const [members, lodging, flights, transport, activities, reservations, budgets, expenses, packingLists, packingItems, documents, emergency, days, items, weather] = results;
  const travelers = members.data ?? [];
  return ok({
    trip,
    travelers,
    lodging: lodging.data ?? [],
    flights: flights.data ?? [],
    transport: transport.data ?? [],
    activities: activities.data ?? [],
    reservations: reservations.data ?? [],
    budgets: budgets.data ?? [],
    expenses: expenses.data ?? [],
    packingLists: packingLists.data ?? [],
    packingItems: packingItems.data ?? [],
    documents: documents.data ?? [],
    emergencyContacts: emergency.data ?? [],
    days: days.data ?? [],
    items: items.data ?? [],
    weather: weather.data ?? [],
    nights: tripNights(trip.start_date, trip.end_date) ?? 0,
    hasChildren: travelers.some((t) => t.role === 'child'),
    budgetSummary: summarizeBudget(budgets.data ?? [], expenses.data ?? []),
  });
}

/** Trips that are not over, soonest first. */
export async function listTrips(scope: ServiceScope, input: { includeFinished?: boolean; limit?: number } = {}): Promise<ServiceResult<VacationRow[]>> {
  let query = scope.db
    .from('vacations')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('start_date', { ascending: true, nullsFirst: false })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  if (!input.includeFinished) query = query.in('status', LIVE_STATUSES);
  const { data, error } = await query;
  if (error) {
    console.error('[service:trips] trips read failed', error);
    return fail(describeDbError(error, 'Could not load your trips.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

// ── find or create ────────────────────────────────────────────────────────────

export type FindOrCreateVacationInput = {
  title?: string | null;
  destination?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  kind?: VacationKind | null;
  isInternational?: boolean | null;
  /** Whole-trip budget in dollars. */
  budget?: number | null;
  description?: string | null;
};

function datesOverlap(a: { start_date: string | null; end_date: string | null }, start: string | null, end: string | null): boolean {
  if (!a.start_date || !start) return true; // undated on either side cannot be ruled out
  const aEnd = a.end_date ?? a.start_date;
  const bEnd = end ?? start;
  return a.start_date <= bEnd && start <= aEnd;
}

/**
 * The live trip a request is about, or a new one. "Our Florida trip" matches
 * an existing planning/booked trip whose destination or title contains the
 * words and whose dates do not contradict the request; otherwise a trip is
 * created with a sensible title. Creating is idempotent on (title, start).
 */
export async function findOrCreateVacation(scope: ServiceScope, input: FindOrCreateVacationInput): Promise<ServiceResult<{ vacation: VacationRow; created: boolean }>> {
  const destination = input.destination?.trim() || null;
  const title = input.title?.trim() || (destination ? `Trip to ${destination}` : null);
  if (!title) return fail('A trip needs a title or a destination.', { code: SERVICE_CODES.invalidInput });
  for (const [label, value] of [['start', input.startDate], ['end', input.endDate]] as const) {
    if (value && !DAY_KEY.test(value)) return fail(`The ${label} date must be YYYY-MM-DD.`, { code: SERVICE_CODES.invalidInput });
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    return fail('A trip cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.kind && !KINDS.includes(input.kind)) return fail('That trip type is not one Bubaly knows.', { code: SERVICE_CODES.invalidInput });

  const needles = [destination, input.title?.trim() || null].filter((s): s is string => Boolean(s));
  const live = await listTrips(scope);
  if (!live.ok) return live;
  const match = live.data.find((trip) => {
    const hay = `${trip.title} ${trip.destination ?? ''}`.toLowerCase();
    const named = needles.some((n) => hay.includes(n.toLowerCase()));
    return named && datesOverlap(trip, input.startDate ?? null, input.endDate ?? null);
  });
  if (match) return ok({ vacation: match, created: false });

  return withIdempotency<{ vacation: VacationRow; created: boolean }>(
    scope,
    {
      operation: 'trips.findOrCreateVacation',
      input: { title, startDate: input.startDate ?? null },
      find: async () => {
        let query = scope.db.from('vacations').select('*').eq('family_id', scope.familyId).ilike('title', escapeLike(title)).limit(1);
        query = input.startDate ? query.eq('start_date', input.startDate) : query.is('start_date', null);
        const { data, error } = await query.maybeSingle();
        if (error) {
          console.error('[service:trips] duplicate probe failed', error);
          return fail(describeDbError(error, 'Could not check for an existing trip.'), { code: SERVICE_CODES.db });
        }
        return ok(data ? { vacation: data, created: false } : null);
      },
    },
    async () => {
      const isInternational = input.isInternational ?? input.kind === 'international';
      const { data, error } = await scope.db
        .from('vacations')
        .insert({
          family_id: scope.familyId,
          title,
          destination,
          start_date: input.startDate ?? null,
          end_date: input.endDate ?? null,
          kind: input.kind ?? (isInternational ? 'international' : 'domestic'),
          is_international: isInternational,
          budget_cents: input.budget != null && Number.isFinite(input.budget) ? Math.max(0, Math.round(input.budget * 100)) : null,
          description: input.description?.trim() || null,
          timezone: scope.tz,
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:trips] trip insert failed', error);
        return fail(describeDbError(error, 'Could not create that trip.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, { agent: 'trips', title: `Started planning ${data.title}`, href: `/dashboard/vacations/${data.id}` });
      return ok({ vacation: data, created: true });
    },
  );
}

// ── plan builder ──────────────────────────────────────────────────────────────

const PlanSchema = z.object({
  activities: z.array(z.object({
    name: z.string(),
    category: z.string().nullable(),
    location: z.string().nullable(),
    family_friendly: z.boolean(),
    /** Whole US dollars; null when unknown. */
    cost_usd: z.number().nullable(),
  })),
  itinerary: z.array(z.object({
    /** 1-based day of the trip. */
    day: z.number().int(),
    day_part: z.enum(DAY_PARTS),
    title: z.string(),
    kind: z.enum(ITEM_KINDS),
  })),
  budget: z.array(z.object({ category: z.enum(BUDGET_CATEGORIES), planned_usd: z.number() })),
});
export type VacationPlan = z.infer<typeof PlanSchema>;

const PLAN_SYSTEM = [
  'You are an expert family travel agent producing a realistic, family-friendly plan for the trip described.',
  'Activities: up to 20, real kinds of places for the destination (do not invent specific business names you are not sure exist).',
  'Itinerary: one entry per day part, within the trip\'s day count, balancing activities with downtime for children.',
  'Budget: planned whole US dollars per category. Only use the data given; never invent traveler details.',
].join(' ');

export type BuildPlanInput = {
  /** Free-text preferences from the family, e.g. "beach days, one museum". */
  prompt?: string | null;
  /** Rebuild even when the trip already has itinerary items. */
  force?: boolean;
  /** Injected in tests and by the executor. */
  provider?: AIProvider;
};

export type BuildPlanResult = {
  built: boolean;
  reason: string | null;
  added: { activities: number; items: number; budget: number; packing: number };
};

/**
 * Ask a model for a plan and persist it: activities, itinerary days/items,
 * budget lines and (when the trip has none) a master packing list.
 *
 * A trip that already has itinerary items is left alone unless `force` — a
 * retried step or a second "plan it" must not stack a second itinerary on
 * top of the first.
 */
export async function buildPlan(scope: ServiceScope, vacationId: string, input: BuildPlanInput = {}): Promise<ServiceResult<BuildPlanResult>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const { trip, travelers, hasChildren, nights, days, budgets, activities, items } = snapshot.data;
  if (!input.force && (items.length > 0 || activities.length > 0)) {
    return ok({ built: false, reason: `${trip.title} already has a plan; ask to rebuild it if you want a fresh one.`, added: { activities: 0, items: 0, budget: 0, packing: 0 } });
  }

  const user = [
    `Trip: ${trip.title}.`,
    `Destination: ${trip.destination ?? 'unspecified'}.`,
    `Type: ${trip.kind}. Nights: ${nights}.`,
    `Travelers: ${travelers.length || 'unknown'}${hasChildren ? ' (includes children)' : ''}.`,
    `Budget: ${trip.budget_cents ? `$${Math.round(trip.budget_cents / 100)}` : 'flexible'}.`,
    input.prompt?.trim() ? `Preferences: ${input.prompt.trim().slice(0, 600)}` : '',
  ].filter(Boolean).join(' ');

  const planned = await structured<VacationPlan>({
    schema: PlanSchema,
    schemaName: 'vacation_plan',
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: user }],
    task: 'plan',
    maxTokens: 2500,
    provider: input.provider,
    requestId: scope.requestId ?? null,
    meter: scope.requestId ? { db: scope.db, familyId: scope.familyId, runId: scope.runId ?? null, stepId: scope.stepId ?? null } : null,
  });
  if (!planned.ok) {
    console.error('[service:trips] plan generation failed', planned.code, planned.error);
    return fail(`Bubaly could not draft a plan right now: ${planned.error}`, { code: planned.code, retryable: planned.code !== 'refusal' && planned.code !== 'schema' });
  }
  const plan = planned.data;

  // ── persist with rollback ──
  const created = { activities: [] as string[], days: [] as string[], items: [] as string[], budgets: [] as string[] };
  const changedBudgets = new Map<VacBudgetCategory, { id: string; planned_cents: number; notes: string | null }>();
  const rollback = async () => {
    const remove = async (table: 'vacation_itinerary_items' | 'vacation_itinerary_days' | 'vacation_activities' | 'vacation_budgets', ids: string[]) => {
      if (!ids.length) return;
      const { error } = await scope.db.from(table).delete().eq('family_id', scope.familyId).eq('vacation_id', vacationId).in('id', ids);
      if (error) console.error(`[service:trips] rollback of ${table} failed`, error);
    };
    await remove('vacation_itinerary_items', created.items);
    await remove('vacation_itinerary_days', created.days);
    await remove('vacation_activities', created.activities);
    await remove('vacation_budgets', created.budgets);
    for (const [, previous] of changedBudgets) {
      const { error } = await scope.db.from('vacation_budgets').update({ planned_cents: previous.planned_cents, notes: previous.notes }).eq('id', previous.id).eq('family_id', scope.familyId);
      if (error) console.error('[service:trips] rollback of a budget line failed', error);
    }
  };
  const failAndRollback = async (message: string, error: unknown) => {
    console.error('[service:trips] plan persistence failed', error);
    await rollback();
    return fail(describeDbError(error, message), { code: SERVICE_CODES.db });
  };

  const added = { activities: 0, items: 0, budget: 0, packing: 0 };

  if (plan.activities.length) {
    const rows = plan.activities.slice(0, 30).map((a) => ({
      family_id: scope.familyId, vacation_id: vacationId,
      name: a.name.slice(0, 200), category: a.category, location: a.location, family_friendly: a.family_friendly,
      cost_cents: a.cost_usd != null && a.cost_usd > 0 ? Math.round(a.cost_usd * 100) : null,
      created_by: scope.userId,
    }));
    const { data, error } = await scope.db.from('vacation_activities').insert(rows).select('id');
    if (data) created.activities.push(...data.map((r) => r.id));
    if (error || !data || data.length !== rows.length) return failAndRollback('Could not save the activities in the plan.', error ?? new Error('activity insert incomplete'));
    added.activities = rows.length;
  }

  if (plan.itinerary.length && trip.start_date && trip.end_date) {
    const range = dateRange(trip.start_date, trip.end_date);
    const dayIdByDate = new Map(days.map((d) => [d.day_date, d.id]));
    const missing = range.filter((d) => !dayIdByDate.has(d)).map((d) => ({ family_id: scope.familyId, vacation_id: vacationId, day_date: d, created_by: scope.userId }));
    if (missing.length) {
      const { data, error } = await scope.db.from('vacation_itinerary_days').insert(missing).select('id, day_date');
      if (data) created.days.push(...data.map((r) => r.id));
      if (error || !data || data.length !== missing.length) return failAndRollback('Could not save the itinerary days.', error ?? new Error('day insert incomplete'));
      for (const d of data) dayIdByDate.set(d.day_date, d.id);
    }
    const dayIds = range.map((d) => dayIdByDate.get(d)).filter((id): id is string => Boolean(id));
    const rows = plan.itinerary.slice(0, 60).map((entry) => ({
      family_id: scope.familyId, vacation_id: vacationId,
      day_id: dayIds[Math.max(0, Math.min(dayIds.length - 1, entry.day - 1))] ?? null,
      day_part: entry.day_part as VacDayPart,
      kind: entry.kind as VacItemKind,
      title: entry.title.slice(0, 200),
      created_by: scope.userId,
    })).filter((r) => r.day_id);
    if (rows.length) {
      const { data, error } = await scope.db.from('vacation_itinerary_items').insert(rows).select('id');
      if (data) created.items.push(...data.map((r) => r.id));
      if (error || !data || data.length !== rows.length) return failAndRollback('Could not save the itinerary.', error ?? new Error('item insert incomplete'));
      added.items = rows.length;
    }
  }

  if (plan.budget.length) {
    const existing = new Map(budgets.map((b) => [b.category, b]));
    const rows = [...new Map(plan.budget.map((b) => [b.category, {
      family_id: scope.familyId, vacation_id: vacationId,
      category: b.category as VacBudgetCategory, planned_cents: Math.max(0, Math.round(b.planned_usd * 100)),
      created_by: scope.userId,
    }])).values()];
    const { data, error } = await scope.db.from('vacation_budgets').upsert(rows, { onConflict: 'vacation_id,category' }).select('id, category');
    for (const row of data ?? []) {
      const previous = existing.get(row.category);
      if (previous) changedBudgets.set(row.category, { id: previous.id, planned_cents: previous.planned_cents, notes: previous.notes });
      else created.budgets.push(row.id);
    }
    if (error || !data || data.length !== rows.length) return failAndRollback('Could not save the budget.', error ?? new Error('budget upsert incomplete'));
    added.budget = rows.length;
  }

  if (snapshot.data.packingItems.length === 0) {
    const packed = await generatePackingList(scope, vacationId, { perTraveler: false });
    // Packing is rule-based and cheap to redo; a failure here does not undo
    // the plan the family asked for, it is reported and retried on its own.
    if (packed.ok) added.packing = packed.data.lists.reduce((s, l) => s + l.added, 0);
    else console.error('[service:trips] packing after plan build failed', packed.error);
  }

  await recordActivitySafely(scope, {
    agent: 'trips',
    title: `Drafted a plan for ${trip.title}: ${added.activities} activities, ${added.items} itinerary entries, ${added.budget} budget lines`,
    href: `/dashboard/vacations/${trip.id}`,
  });
  return ok({ built: true, reason: null, added });
}

// ── packing ───────────────────────────────────────────────────────────────────

export type PackingInput = {
  /** One traveler's list; omit for every traveler (or the master list when the trip has no travelers). */
  memberId?: string | null;
  /** Default true: one list per traveler. False builds only the shared master list. */
  perTraveler?: boolean;
};

export type PackingListResult = {
  listId: string;
  memberId: string | null;
  name: string;
  added: number;
  skipped: number;
  items: { name: string; category: string; quantity: number }[];
};

function weatherHints(weather: TripSnapshot['weather']): { maxTempC: number | null; minTempC: number | null; rainy: boolean } {
  const highs = weather.map((w) => w.temp_high_c).filter((v): v is number => v != null);
  const lows = weather.map((w) => w.temp_low_c).filter((v): v is number => v != null);
  return {
    maxTempC: highs.length ? Math.max(...highs) : null,
    minTempC: lows.length ? Math.min(...lows) : null,
    rainy: weather.some((w) => (w.precip_prob ?? 0) >= 50),
  };
}

/**
 * Build packing lists from the trip's kind, length, weather snapshots and
 * activities — per traveler, so a five-year-old's list does not say
 * "deodorant" and a parent's does not say "coloring books". Items already on
 * a list are skipped, which is what makes a re-run safe.
 */
export async function generatePackingList(scope: ServiceScope, vacationId: string, input: PackingInput = {}): Promise<ServiceResult<{ lists: PackingListResult[] }>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const { trip, travelers, nights, activities, weather, packingLists, packingItems } = snapshot.data;
  const members = await getMembers(scope);
  if (!members.ok) return members;
  const memberById = new Map(members.data.map((m) => [m.id, m]));
  const hints = weatherHints(weather);
  const anyChildren = travelers.some((t) => t.role === 'child' || (t.member_id && (memberById.get(t.member_id)?.age ?? 99) < 13));
  const anyBaby = travelers.some((t) => t.member_id && (memberById.get(t.member_id)?.age ?? 99) < 3);

  type Target = { memberId: string | null; name: string; member: FamilyMember | null };
  let targets: Target[];
  const perTraveler = input.perTraveler ?? true;
  if (input.memberId) {
    const member = memberById.get(input.memberId) ?? null;
    if (!member) return fail('That family member could not be found.', { code: SERVICE_CODES.notFound });
    targets = [{ memberId: member.id, name: `${member.displayName}'s list`, member }];
  } else if (perTraveler && travelers.some((t) => t.member_id)) {
    targets = travelers
      .filter((t) => t.member_id && memberById.has(t.member_id))
      .map((t) => { const member = memberById.get(t.member_id!)!; return { memberId: member.id, name: `${member.displayName}'s list`, member }; });
  } else {
    targets = [{ memberId: null, name: 'Master list', member: null }];
  }

  const results: PackingListResult[] = [];
  for (const target of targets) {
    let list = packingLists.find((l) => (target.memberId ? l.member_id === target.memberId : l.is_master || l.member_id === null)) ?? null;
    if (!list) {
      const { data, error } = await scope.db
        .from('vacation_packing_lists')
        .insert({ family_id: scope.familyId, vacation_id: vacationId, name: target.name, member_id: target.memberId, is_master: target.memberId === null, created_by: scope.userId })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:trips] packing list insert failed', error);
        return fail(describeDbError(error, 'Could not create the packing list.'), { code: SERVICE_CODES.db });
      }
      list = data;
      packingLists.push(data);
    }

    const age = target.member?.age ?? null;
    const isChild = age !== null && age < 13;
    const suggestions = suggestPacking({
      kind: trip.kind,
      nights: Math.max(nights, 1),
      isInternational: trip.is_international,
      hasChildren: target.memberId ? isChild : anyChildren,
      hasBaby: target.memberId ? (age !== null && age < 3) : anyBaby,
      maxTempC: hints.maxTempC,
      minTempC: hints.minTempC,
      rainy: hints.rainy,
      activities: activities.map((a) => a.name),
    })
      // Per-person lists drop the family-level extras a child would not carry.
      .filter((s) => !(target.memberId && isChild && /deodorant|formula|stroller|monitor|currency|adapter/i.test(s.name)));

    const listId = list.id;
    const existing = new Set(packingItems.filter((i) => i.list_id === listId).map((i) => i.name.toLowerCase()));
    const fresh = suggestions.filter((s) => !existing.has(s.name.toLowerCase()));
    if (fresh.length) {
      const rows = fresh.map((s) => ({ family_id: scope.familyId, vacation_id: vacationId, list_id: listId, name: s.name, category: s.category, quantity: s.quantity, ai_suggested: true, created_by: scope.userId }));
      const { data, error } = await scope.db.from('vacation_packing_items').insert(rows).select('*');
      if (error) {
        console.error('[service:trips] packing items insert failed', error);
        return fail(describeDbError(error, 'Could not add the packing items.'), { code: SERVICE_CODES.db });
      }
      packingItems.push(...(data ?? []));
    }
    results.push({
      listId,
      memberId: target.memberId,
      name: list.name,
      added: fresh.length,
      skipped: suggestions.length - fresh.length,
      items: fresh.map((s) => ({ name: s.name, category: s.category, quantity: s.quantity })),
    });
  }

  const total = results.reduce((s, r) => s + r.added, 0);
  if (total > 0) {
    await recordActivitySafely(scope, {
      agent: 'trips',
      title: `Packed ${total} items across ${results.length} ${results.length === 1 ? 'list' : 'lists'} for ${trip.title}`,
      href: `/dashboard/vacations/${trip.id}`,
    });
  }
  return ok({ lists: results });
}

// ── readiness and documents ───────────────────────────────────────────────────

export type DocumentRisk = {
  kind: 'missing_passport' | 'passport_expiring' | 'document_expiring' | 'no_documents';
  memberId: string | null;
  title: string;
  detail: string;
  severity: 1 | 2 | 3;
};

/**
 * What is wrong with the trip's paperwork: a traveler on an international
 * trip with no passport on file, a passport that expires within six months
 * of the return, any travel document that expires before the trip ends.
 * Pure over a snapshot; exported for tests and for `computeReadiness`.
 */
export function documentRisksFor(snapshot: TripSnapshot, members: FamilyMember[]): DocumentRisk[] {
  const { trip, travelers, documents } = snapshot;
  const risks: DocumentRisk[] = [];
  const end = trip.end_date ?? trip.start_date;
  const nameOf = (id: string | null) => (id ? members.find((m) => m.id === id)?.displayName ?? 'A traveler' : 'A traveler');

  if (trip.is_international) {
    const passportBy = new Map(documents.filter((d) => d.kind === 'passport' && d.member_id).map((d) => [d.member_id!, d]));
    const travelerIds = travelers.map((t) => t.member_id).filter((id): id is string => Boolean(id));
    for (const id of travelerIds) {
      const passport = passportBy.get(id);
      if (!passport) {
        risks.push({ kind: 'missing_passport', memberId: id, title: `${nameOf(id)} has no passport on file`, detail: 'Add or upload the passport so the trip can be checked against its expiry.', severity: 3 });
        continue;
      }
      if (passport.expires_on && end) {
        const needed = new Date(Date.parse(`${end}T00:00:00Z`) + PASSPORT_VALIDITY_DAYS * DAY_MS).toISOString().slice(0, 10);
        if (passport.expires_on < needed) {
          risks.push({ kind: 'passport_expiring', memberId: id, title: `${nameOf(id)}'s passport expires ${passport.expires_on}`, detail: `Many countries require six months' validity past ${end}; renew it before travelling.`, severity: passport.expires_on < end ? 3 : 2 });
        }
      }
    }
    if (travelerIds.length === 0 && passportBy.size === 0) {
      risks.push({ kind: 'no_documents', memberId: null, title: 'No passports on file for this international trip', detail: 'Add the travelers and their passports.', severity: 2 });
    }
  }
  for (const doc of documents) {
    if (doc.kind === 'passport' || !doc.expires_on || !end) continue;
    if (doc.expires_on < end) {
      risks.push({ kind: 'document_expiring', memberId: doc.member_id, title: `${doc.title} expires ${doc.expires_on}`, detail: 'It runs out before the trip ends.', severity: 2 });
    }
  }
  return risks.sort((a, b) => b.severity - a.severity);
}

export async function documentsRisk(scope: ServiceScope, vacationId: string): Promise<ServiceResult<DocumentRisk[]>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const members = await getMembers(scope);
  if (!members.ok) return members;
  return ok(documentRisksFor(snapshot.data, members.data));
}

export type TripReadiness = ReadinessResult & {
  tripId: string;
  title: string;
  daysUntil: number | null;
  documentRisks: DocumentRisk[];
  itineraryConflicts: number;
  budget: { plannedCents: number; spentCents: number; over: boolean };
};

/** The 0–100 readiness score over the live snapshot, plus the paperwork risks and budget state the card shows. */
export async function computeReadiness(scope: ServiceScope, vacationId: string): Promise<ServiceResult<TripReadiness>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const s = snapshot.data;
  const members = await getMembers(scope);
  if (!members.ok) return members;

  const tripDays = s.trip.start_date && s.trip.end_date ? dateRange(s.trip.start_date, s.trip.end_date).length : 0;
  const dayIds = new Set(s.items.map((i) => i.day_id).filter(Boolean));
  const result = scoreReadiness({
    hasDates: Boolean(s.trip.start_date && s.trip.end_date),
    membersCount: s.travelers.length || members.data.length,
    lodgingTotal: s.lodging.length, lodgingBooked: s.lodging.filter((l) => l.booked).length,
    transportTotal: s.flights.length + s.transport.length, transportBooked: s.flights.filter((f) => f.booked).length + s.transport.filter((t) => t.booked).length,
    activitiesTotal: s.activities.length, activitiesBooked: s.activities.filter((a) => a.booked).length,
    reservationsTotal: s.reservations.length, reservationsBooked: s.reservations.filter((r) => r.booked).length,
    packingTotal: s.packingItems.length, packingPacked: s.packingItems.filter((p) => p.packed).length,
    documentsCount: s.documents.length,
    emergencyContactsCount: s.emergencyContacts.length,
    budgetPlannedCents: s.budgetSummary.planned_cents,
    itineraryDays: dayIds.size,
    tripDays,
    isInternational: s.trip.is_international,
  });

  const dayById = new Map(s.days.map((d) => [d.id, d]));
  const conflicts = detectConflicts(s.items.map((it): ItemLike => ({
    id: it.id, day_id: it.day_id, day_date: it.day_id ? dayById.get(it.day_id)?.day_date ?? null : null,
    kind: it.kind, day_part: it.day_part, title: it.title, start_time: it.start_time, end_time: it.end_time,
  })), { hasYoungChildren: s.hasChildren });

  const today = dayKeyInTz(scopeNow(scope), scope.tz);
  const daysUntil = s.trip.start_date ? Math.round((Date.parse(`${s.trip.start_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null;

  return ok({
    ...result,
    tripId: s.trip.id,
    title: s.trip.title,
    daysUntil,
    documentRisks: documentRisksFor(s, members.data),
    itineraryConflicts: conflicts.length,
    budget: { plannedCents: s.budgetSummary.planned_cents, spentCents: s.budgetSummary.spent_cents, over: s.budgetSummary.over },
  });
}

// ── calendar ──────────────────────────────────────────────────────────────────

export type SyncToCalendarResult = {
  created: { id: string; title: string; startsAt: string }[];
  skipped: string[];
};

/**
 * Put the trip on the family calendar: one all-day span for the trip itself,
 * one event per flight, one per timed reservation. An event with the same
 * title at the same instant is skipped, so syncing twice adds nothing.
 */
export async function syncToCalendar(scope: ServiceScope, vacationId: string): Promise<ServiceResult<SyncToCalendarResult>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const { trip, flights, reservations } = snapshot.data;
  if (!trip.start_date) return fail(`${trip.title} has no dates yet, so there is nothing to put on the calendar.`, { code: SERVICE_CODES.invalidInput });
  const tz = trip.timezone || scope.tz;
  const endDate = trip.end_date ?? trip.start_date;

  type Candidate = { title: string; startsAt: string; endsAt: string | null; allDay: boolean; category: 'holiday' | 'other'; location: string | null; description: string | null };
  const candidates: Candidate[] = [{
    title: trip.title,
    startsAt: new Date(zonedTimeMs(trip.start_date, 0, 0, tz)).toISOString(),
    endsAt: new Date(zonedDayBoundsMs(endDate, tz).end - 1).toISOString(),
    allDay: true,
    category: 'holiday',
    location: trip.destination,
    description: `Trip: ${trip.title}`,
  }];
  for (const f of flights) {
    if (!f.depart_at) continue;
    const route = [f.depart_airport, f.arrive_airport].filter(Boolean).join(' → ');
    candidates.push({
      title: `Flight ${[f.airline, f.flight_number].filter(Boolean).join(' ')}${route ? ` ${route}` : ''}`.replace(/\s+/g, ' ').trim(),
      startsAt: new Date(Date.parse(f.depart_at)).toISOString(),
      endsAt: f.arrive_at ? new Date(Date.parse(f.arrive_at)).toISOString() : null,
      allDay: false,
      category: 'other',
      location: f.depart_airport,
      description: f.confirmation_code ? `Confirmation ${f.confirmation_code}` : null,
    });
  }
  for (const r of reservations) {
    if (!r.reserved_at) continue;
    candidates.push({
      title: r.name,
      startsAt: new Date(Date.parse(r.reserved_at)).toISOString(),
      endsAt: null,
      allDay: false,
      category: 'other',
      location: r.location,
      description: r.confirmation_code ? `Confirmation ${r.confirmation_code}` : null,
    });
  }

  const existing = await searchEvents(scope, {
    from: new Date(zonedTimeMs(trip.start_date, 0, 0, tz) - 30 * DAY_MS).toISOString(),
    to: new Date(zonedDayBoundsMs(endDate, tz).end + DAY_MS).toISOString(),
    limit: 200,
  });
  if (!existing.ok) return existing;
  const present = new Set(existing.data.map((e) => `${e.title.toLowerCase()}|${Date.parse(e.starts_at)}`));

  const created: SyncToCalendarResult['created'] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    if (present.has(`${c.title.toLowerCase()}|${Date.parse(c.startsAt)}`)) { skipped.push(c.title); continue; }
    const res = await createEvent(scope, { title: c.title, startsAt: c.startsAt, endsAt: c.endsAt, allDay: c.allDay, category: c.category, location: c.location, description: c.description });
    if (!res.ok) return res;
    created.push({ id: res.data.id, title: res.data.title, startsAt: res.data.starts_at });
  }
  return ok({ created, skipped });
}

// ── conflicts with the rest of life ───────────────────────────────────────────

export type CommitmentConflicts = {
  window: { from: string; to: string };
  calendar: CalendarEvent[];
  school: SchoolEventRow[];
  sports: SportsEventRow[];
  homework: HomeworkRow[];
  bills: Tables<'bills'>[];
  total: number;
};

/** Everything already committed during the trip's dates — the things a family has to move, skip or pay early. */
export async function commitmentConflicts(scope: ServiceScope, vacationId: string): Promise<ServiceResult<CommitmentConflicts>> {
  const snapshot = await getTrip(scope, vacationId);
  if (!snapshot.ok) return snapshot;
  const { trip } = snapshot.data;
  if (!trip.start_date) return fail(`${trip.title} has no dates yet, so conflicts cannot be checked.`, { code: SERVICE_CODES.invalidInput });
  const tz = trip.timezone || scope.tz;
  const endDate = trip.end_date ?? trip.start_date;
  const from = new Date(zonedTimeMs(trip.start_date, 0, 0, tz)).toISOString();
  const to = new Date(zonedDayBoundsMs(endDate, tz).end - 1).toISOString();

  const [calendar, school, sports, homework, bills] = await Promise.all([
    searchEvents(scope, { from, to, limit: 200 }),
    listEventsBetween(scope, { from, to }),
    listPracticesBetween(scope, { from, to }),
    listHomeworkDue(scope, { from, to }),
    scope.db.from('bills').select('*').eq('family_id', scope.familyId).neq('status', 'paid').gte('due_date', trip.start_date).lte('due_date', endDate).order('due_date', { ascending: true }).limit(100),
  ]);
  if (!calendar.ok) return calendar;
  if (!school.ok) return school;
  if (!sports.ok) return sports;
  if (!homework.ok) return homework;
  if (bills.error) {
    console.error('[service:trips] bills read failed', bills.error);
    return fail(describeDbError(bills.error, 'Could not check bills due during the trip.'), { code: SERVICE_CODES.db });
  }

  // The trip's own calendar entries (from `syncToCalendar`) are not conflicts.
  const ownTitles = new Set([trip.title.toLowerCase()]);
  const calendarRows = calendar.data.filter((e) => !(ownTitles.has(e.title.toLowerCase()) && e.all_day) && !/^flight /i.test(e.title));
  const billRows = bills.data ?? [];
  return ok({
    window: { from, to },
    calendar: calendarRows,
    school: school.data,
    sports: sports.data,
    homework: homework.data,
    bills: billRows,
    total: calendarRows.length + school.data.length + sports.data.length + homework.data.length + billRows.length,
  });
}
