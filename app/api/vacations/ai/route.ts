import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { summarizeBudget } from '@/lib/vacations/budget';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';
import { forecastDaysWithin, tripWeatherAdvice, type WeatherDayLike } from '@/lib/vacations/weather';
import { suggestPacking } from '@/lib/vacations/packing';
import { tripNights, dateRange } from '@/lib/vacations/dates';
import { CONCIERGE_PLAN_MARKER, isConciergePlanRow, parseVacationAIOutput, type VacationAIPlan } from '@/lib/vacations/ai-output';
import { wroteNoRows } from '@/lib/supabase/errors';
import { escapeLike } from '@/lib/supabase/escape-like';

export const runtime = 'nodejs';

type Body = { action: 'concierge' | 'build' | 'recommendations'; vacationId: string; conversationId?: string; message?: string; prompt?: string; rebuild?: boolean };

const databaseUnavailable = (message: string) => NextResponse.json({ error: message }, { status: 503 });

function logDatabaseFailure(operation: string, error: unknown) {
  console.error(`[vacation-ai] ${operation} failed:`, error);
}

/** A row the build inserted, as its insert returned it: what the rollback fences on. */
type Written = { id: string; updated_at: string };

/**
 * `rows` by the `updated_at` they carry. One insert is one statement, so its
 * rows share one: a fenced delete is a call per insert, not one per row.
 */
function byStamp(rows: Written[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.updated_at, [...(grouped.get(row.updated_at) ?? []), row.id]);
  return grouped;
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('ai.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not.
  // Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/vacations']);
  if (refused) return refused;
  // No key: say so before any work, rather than let the provider's throw
  // reach the catch below as a generic failure.
  if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
  const limited = await enforceAIRateLimit(supabase, `ai-vacations:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: t('ai.tooManyTripAiRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('ai.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Body;
  const { action, vacationId } = body;
  if (!vacationId) return NextResponse.json({ error: t('ai.missingVacationid') }, { status: 400 });

  const familyId = ctx.active.familyId;
  const { data: trip, error: tripError } = await supabase.from('vacations').select('*').eq('id', vacationId).eq('family_id', familyId).maybeSingle();
  if (tripError) {
    logDatabaseFailure('trip context read', tripError);
    return databaseUnavailable(t('ai.tripDataIsTemporarilyUnavailable'));
  }
  if (!trip) return NextResponse.json({ error: t('ai.tripNotFound') }, { status: 404 });

  // Gather trip context (all RLS-scoped).
  const contextResults = await settleAll([
    supabase.from('vacation_members').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_lodging').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_flights').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_transportation').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_activities').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_reservations').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_budgets').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_expenses').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_packing_items').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_documents').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_emergency_contacts').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_itinerary_days').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_itinerary_items').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_weather_snapshots').select('*').eq('vacation_id', vacationId),
  ]);
  const contextError = contextResults.find((result) => result.error)?.error;
  if (contextError) {
    logDatabaseFailure('trip context read', contextError);
    return databaseUnavailable(t('ai.tripDataIsTemporarilyUnavailable'));
  }
  const [members, lodging, flights, transport, activities, reservations, budgets, expenses, packing, docs, emergency, days, items, weather] = contextResults;

  const m = members.data ?? [], a = activities.data ?? [], r = reservations.data ?? [];
  const hasChildren = m.some((x) => x.role === 'child');
  const nights = tripNights(trip.start_date, trip.end_date) ?? 0;

  // ---------- RECOMMENDATIONS (rule-based, reliable) ----------
  if (action === 'recommendations') {
    const recos: { kind: string; title: string; detail: string; severity: number }[] = [];
    if ((lodging.data ?? []).length === 0) recos.push({ kind: 'missing_reservation', title: 'No lodging booked', detail: 'Add where your family is staying.', severity: 3 });
    if ((flights.data ?? []).length === 0 && (transport.data ?? []).length === 0) recos.push({ kind: 'missing_reservation', title: 'No transportation', detail: 'Add flights or how you will get around.', severity: 2 });
    const unbookedRes = r.filter((x) => !x.booked).length;
    if (unbookedRes > 0) recos.push({ kind: 'missing_reservation', title: `${unbookedRes} reservation(s) not confirmed`, detail: 'Confirm dining and activity reservations.', severity: 1 });
    if (trip.is_international && (docs.data ?? []).filter((d) => d.kind === 'passport').length < m.length) recos.push({ kind: 'document_missing', title: 'Passports missing', detail: 'Upload a passport for each traveler.', severity: 3 });
    if ((emergency.data ?? []).length < 2) recos.push({ kind: 'suggestion', title: 'Add emergency contacts', detail: 'Store a doctor, insurance, and local emergency number.', severity: 1 });

    const budgetSummary = summarizeBudget(budgets.data ?? [], expenses.data ?? []);
    for (const over of budgetSummary.categories.filter((c) => c.over)) recos.push({ kind: 'budget_warning', title: `Over budget: ${over.category}`, detail: `Spent ${(over.spent_cents / 100).toFixed(0)} vs planned ${(over.planned_cents / 100).toFixed(0)}.`, severity: 2 });

    const dayById = new Map((days.data ?? []).map((d) => [d.id, d]));
    const conflicts = detectConflicts((items.data ?? []).map((it): ItemLike => ({ id: it.id, day_id: it.day_id, day_date: it.day_id ? dayById.get(it.day_id)?.day_date ?? null : null, kind: it.kind, day_part: it.day_part, title: it.title, start_time: it.start_time, end_time: it.end_time })), { hasYoungChildren: hasChildren });
    for (const c of conflicts.slice(0, 5)) recos.push({ kind: 'travel_conflict', title: c.title, detail: c.detail, severity: c.severity });

    // Only the days inside the trip: a snapshot cached for a week the family is
    // not away on — a trip that was beyond the forecast horizon, an older
    // location label — is not the trip's weather and must not become an advisory.
    for (const w of tripWeatherAdvice(forecastDaysWithin((weather.data ?? []) as WeatherDayLike[], trip.start_date, trip.end_date))) recos.push({ kind: 'weather_warning', title: 'Weather advisory', detail: w.text, severity: w.severity });

    // Replace prior rule-sourced open recommendations — INSERT FIRST, then
    // delete the old rows by id. Deleting first and inserting second meant a
    // failed insert left the family with nothing where their recommendations
    // had been. Zero prior rows is the ordinary first run. Audit C1-S9-63.
    const { data: prior, error: priorError } = await supabase.from('vacation_ai_recommendations').select('id').eq('family_id', familyId).eq('vacation_id', vacationId).eq('source', 'rules').eq('status', 'open');
    if (priorError) {
      logDatabaseFailure('recommendation read', priorError);
      return databaseUnavailable(t('ai.recommendationsAreTemporarilyUnavailable'));
    }
    if (recos.length) {
      const { error: insertError } = await supabase.from('vacation_ai_recommendations').insert(recos.map((x) => ({ family_id: familyId, vacation_id: vacationId, kind: x.kind as never, title: x.title, detail: x.detail, severity: x.severity, source: 'rules', created_by: ctx!.user.id })));
      if (insertError) {
        logDatabaseFailure('recommendation write', insertError);
        return databaseUnavailable(t('ai.recommendationsAreTemporarilyUnavailable'));
      }
    }
    const priorIds = (prior ?? []).map((row) => row.id);
    if (priorIds.length) {
      // The prior set goes only after the new one landed, and only the rows
      // read above — the ERROR gates the response; the row count does not,
      // since a row another request already replaced is not a failure here.
      // Audit C1-S9-63.
      const { error: deleteError } = await supabase.from('vacation_ai_recommendations').delete().eq('family_id', familyId).eq('vacation_id', vacationId).eq('source', 'rules').eq('status', 'open').in('id', priorIds);
      if (deleteError) {
        logDatabaseFailure('recommendation cleanup', deleteError);
        return databaseUnavailable(t('ai.recommendationsAreTemporarilyUnavailable'));
      }
    }
    return NextResponse.json({ count: recos.length });
  }

  // ---------- BUILD (AI vacation builder) ----------
  if (action === 'build') {
    // A trip that already has a plan is left alone unless the caller says
    // "rebuild" — the same rule `lib/services/trips buildPlan` applies. A lost
    // response followed by a retry, or two tabs, used to stack a second full
    // itinerary on the first and overwrite the family's edited budget lines.
    //
    // This read is only the early answer, before a model is paid for. It is
    // NOT what keeps two requests apart: both can pass it while neither has
    // written. The claim below, taken after generation, is.
    const hasPlan = (items.data ?? []).length > 0 || a.length > 0;
    // `replaces` tells the client which question to ask. A rebuild removes only
    // the rows the builder stamped (see below); a plan written by hand, by the
    // assistant before it stamped its rows, or by this route before the stamp
    // existed has nothing a rebuild can take away — so "Replace it?" would be a
    // promise the route cannot keep, and the client asks "add alongside?" instead.
    const replaces = a.some((row) => isConciergePlanRow(row) && !row.booked)
      || (items.data ?? []).some((row) => isConciergePlanRow(row) && !row.booked);
    if (hasPlan && body.rebuild !== true) return NextResponse.json({ error: t('ai.tripAlreadyHasAPlan'), code: 'has_plan', replaces }, { status: 409 });
    const range = trip.start_date && trip.end_date ? dateRange(trip.start_date, trip.end_date) : [];
    const system = `You are an expert family travel agent. Produce a realistic, family-friendly plan as STRICT JSON only (no prose, no markdown). Schema:
{"activities":[{"name":string,"category":string,"location":string,"family_friendly":boolean,"cost":number}],
"itinerary":[{"day":number,"day_part":"morning"|"afternoon"|"evening","title":string,"kind":"activity"|"meal"|"travel"|"reservation"|"free_time"}],
"budget":[{"category":"flights"|"lodging"|"transportation"|"activities"|"food"|"shopping"|"insurance"|"fees"|"misc","planned":number}]}
Costs/planned are whole US dollars. Keep itinerary day numbers between 1 and ${range.length}; if there are no dated days, return an empty itinerary. Use at most 30 activities, 60 itinerary items, and 9 budget entries. These are suggestions and cost estimates, not verified prices, availability, or bookings. Balance activities with downtime for kids.`;
    const user = `Trip: ${trip.title}. Destination: ${trip.destination ?? 'unspecified'}. Type: ${trip.kind}. Nights: ${nights}. Travelers: ${m.length} (${hasChildren ? 'includes children' : 'adults'}). Budget: ${trip.budget_cents ? `$${trip.budget_cents / 100}` : 'flexible'}. ${body.prompt ? `Preferences: ${body.prompt}` : ''}`;

    let plan: VacationAIPlan;
    try {
      const built = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'vacations.build', text: 'Build a vacation plan' },
        async (obs) => {
          const provider = await resolveProvider();
          const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 2000 });
          obs.used(provider.model, completion.usage);
          const validated = parseVacationAIOutput(completion.text, range.length);
          if (!validated) obs.failed(new Error('The trip plan did not validate against the requested day count.'));
          return validated;
        },
      );
      if (!built) return NextResponse.json({ error: t('ai.aiBuilderReturnedAnInvalid') }, { status: 502 });
      plan = built;
    } catch (err) {
      console.error('Vacation build error:', err);
      return NextResponse.json({ error: t('ai.aiBuilderIsTemporarilyUnavailable') }, { status: 502 });
    }

    // THE CLAIM. Generation takes seconds, and everything read above is that
    // old. A compare-and-set on the trip row's `updated_at` as it was read
    // before generation (the 0070 trigger moves it on every update) is the
    // one write two requests cannot both win: Postgres re-checks the WHERE
    // against the row the first one left, so a second tab's build or rebuild,
    // started from the same read, matches nothing and writes nothing. It also
    // refuses a plan drafted for dates someone changed meanwhile. Zero rows is
    // the losing side of the race, not a failure to save — answered as a 409.
    // What it cannot fence without SQL is a request that READ the trip after
    // another's claim while that other was still writing; the re-read below
    // closes that to the other's write phase, which a model call outlasts.
    // The column written is the title AS READ: under the fence it is unchanged
    // by definition, and the write exists for the trigger's new `updated_at`
    // (the generated Update type leaves `updated_at` to that trigger).
    const { data: claimed, error: claimError } = await supabase.from('vacations')
      .update({ title: trip.title })
      .eq('id', vacationId).eq('family_id', familyId).eq('updated_at', trip.updated_at)
      .select('id');
    if (claimError) {
      logDatabaseFailure('build claim', claimError);
      return databaseUnavailable(t('ai.tripDataIsTemporarilyUnavailable'));
    }
    if (wroteNoRows(claimed)) return NextResponse.json({ error: t('ai.tripChangedWhileBuilding'), code: 'trip_changed' }, { status: 409 });

    // What the trip holds NOW, after the claim — not only what it held before
    // the model was called. A first build that finds a plan here was
    // overtaken; a rebuild takes its candidates from here (see `replaceable`).
    const fresh = await settleAll([
      supabase.from('vacation_activities').select('id, booked, notes, updated_at').eq('family_id', familyId).eq('vacation_id', vacationId),
      supabase.from('vacation_itinerary_items').select('id, booked, notes, updated_at').eq('family_id', familyId).eq('vacation_id', vacationId),
    ]);
    const freshError = fresh.find((result) => result.error)?.error;
    if (freshError) {
      logDatabaseFailure('build plan re-read', freshError);
      return databaseUnavailable(t('ai.tripDataIsTemporarilyUnavailable'));
    }
    const [freshActivities, freshItems] = [fresh[0].data ?? [], fresh[1].data ?? []];
    if (body.rebuild !== true && (freshActivities.length > 0 || freshItems.length > 0)) {
      const overtakenReplaces = [...freshActivities, ...freshItems].some((row) => isConciergePlanRow(row) && !row.booked);
      return NextResponse.json({ error: t('ai.tripAlreadyHasAPlan'), code: 'has_plan', replaces: overtakenReplaces }, { status: 409 });
    }

    let added = { activities: 0, items: 0, budget: 0, packing: 0 };
    const createdActivities: Written[] = [];
    const createdDays: Written[] = [];
    const createdItems: Written[] = [];
    const createdBudgets: Written[] = [];
    const changedBudgetCategories: NonNullable<typeof budgets.data>[number]['category'][] = [];
    const createdPackingItems: Written[] = [];
    let createdPackingList: Written | null = null;
    // An explicit rebuild REPLACES the last build, as the confirm copy
    // (tripConcierge.rebuildExistingPlan) promises: the rows the builder wrote
    // are the ones carrying its marker in `notes`, and only those go. A row a
    // parent added by hand never carries it; a row a parent has booked since is
    // a commitment, not a suggestion, and stays. Budgets are upserted per
    // category and days are reused per date, so neither stacks.
    //
    // Each candidate carries the `updated_at` it had when the family asked —
    // the read before the model was called — so a suggestion someone booked,
    // un-stamped or edited in another tab during generation no longer matches
    // its delete and is kept. A stamped row that appeared only since (another
    // builder's, from the narrow window the claim leaves) is replaced as it now
    // stands, so two builds do not stack.
    const replaceable = (fresh: { id: string; booked: boolean; notes: string | null; updated_at: string }[], askedOn: { id: string; updated_at: string }[]) => {
      const stampAsked = new Map(askedOn.map((row) => [row.id, row.updated_at]));
      return fresh.filter((row) => isConciergePlanRow(row) && !row.booked).map((row) => ({ id: row.id, updated_at: stampAsked.get(row.id) ?? row.updated_at }));
    };
    const priorActivities = body.rebuild === true ? replaceable(freshActivities, a) : [];
    const priorItems = body.rebuild === true ? replaceable(freshItems, items.data ?? []) : [];
    // The rows the replace actually deleted, as the database returned them at
    // that moment — what a rollback puts back. Never the pre-generation read.
    const removedActivities: NonNullable<typeof activities.data> = [];
    const removedItems: NonNullable<typeof items.data> = [];
    const originalBudgets = new Map((budgets.data ?? []).map((row) => [row.category, {
      id: row.id,
      planned_cents: row.planned_cents,
      notes: row.notes,
      created_by: row.created_by,
    }]));

    // A row as it was read, minus the two columns the database stamps itself
    // (the Insert type refuses them), so it goes back under its own id.
    const asInsert = <T extends { created_at: string; updated_at: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> =>
      Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'created_at' && column !== 'updated_at')) as Omit<T, 'created_at' | 'updated_at'>;

    // Every row here was minted by THIS request — but it became the family's
    // the moment its insert committed, and the writes after it are round trips
    // that take longer when one stalls before it errors. A parent who booked a
    // new suggestion, or pencilled a time onto one, in that window made it
    // theirs, and deleting it by id alone erased that. So the compensation is
    // FENCED like the rebuild's replace below: `updated_at` still the one the
    // insert returned (the 0070 trigger moves it on every edit), and a
    // suggestion still unbooked and still carrying exactly the builder's
    // marker. A short count is that fence keeping someone's row (or a row
    // already gone): part of the failed build stays in the trip, so it is
    // logged — not raised, as the caller is already answering with the build's
    // failure. Audit C1-S9-63.
    const removeRows = async (
      table: 'vacation_activities' | 'vacation_itinerary_days' | 'vacation_itinerary_items' | 'vacation_budgets' | 'vacation_packing_items' | 'vacation_packing_lists',
      rows: Written[],
    ) => {
      for (const [stamp, ids] of byStamp(rows)) {
        const { data: removed, error } = table === 'vacation_activities' || table === 'vacation_itinerary_items'
          ? await supabase.from(table).delete().eq('family_id', familyId).eq('vacation_id', vacationId).eq('updated_at', stamp)
            .eq('booked', false).eq('notes', CONCIERGE_PLAN_MARKER).in('id', ids).select('id')
          : await supabase.from(table).delete().eq('family_id', familyId).eq('vacation_id', vacationId).eq('updated_at', stamp).in('id', ids).select('id');
        if (error) logDatabaseFailure(`build rollback ${table}`, error);
        else if ((removed?.length ?? 0) !== ids.length) {
          logDatabaseFailure(`build rollback ${table}`, new Error(`removed ${removed?.length ?? 0} of ${ids.length}; the rest changed since this request wrote them and were kept`));
        }
      }
    };

    // A day this build created goes only while nothing sits on it:
    // `vacation_itinerary_items.day_id` is ON DELETE CASCADE (0070), so the
    // delete would take whatever is on the day with it — a dinner a parent
    // added by hand, a confirmation import, a new suggestion the fence above
    // kept because someone booked it. As in the disruption rollback, the read
    // and the delete are two calls, so an item placed between them is not
    // covered; that needs the NOT EXISTS delete as one statement (SQL).
    const removeEmptyDays = async (days: Written[]) => {
      if (!days.length) return;
      const { data: occupied, error } = await supabase.from('vacation_itinerary_items').select('day_id')
        .eq('family_id', familyId).eq('vacation_id', vacationId).in('day_id', days.map((day) => day.id));
      if (error) {
        logDatabaseFailure('build rollback vacation_itinerary_days (kept: could not check they were empty)', error);
        return;
      }
      const held = new Set((occupied ?? []).map((row) => row.day_id));
      if (held.size) console.warn(`[vacation-ai] build rollback kept ${held.size} new itinerary day(s) that hold items`);
      await removeRows('vacation_itinerary_days', days.filter((day) => !held.has(day.id)));
    };

    const rollbackBuild = async () => {
      await removeRows('vacation_packing_items', createdPackingItems);
      if (createdPackingList) await removeRows('vacation_packing_lists', [createdPackingList]);
      await removeRows('vacation_itinerary_items', createdItems);
      await removeEmptyDays(createdDays);
      await removeRows('vacation_activities', createdActivities);
      await removeRows('vacation_budgets', createdBudgets);
      // A rebuild removed the prior build's rows only after the new plan had
      // landed; failing after that puts back exactly the rows this request
      // removed, as the delete returned them — not the read from before the
      // model was called. Logged, as above; a restore that fails is a lost
      // suggestion, which is why the replace is fenced to unbooked, stamped,
      // unchanged rows in the first place. Audit C1-S9-63.
      if (removedItems.length) {
        const { data: restored, error } = await supabase.from('vacation_itinerary_items').insert(removedItems.map(asInsert)).select('id');
        if (error) logDatabaseFailure('build rollback vacation_itinerary_items restore', error);
        else if ((restored?.length ?? 0) !== removedItems.length) {
          logDatabaseFailure('build rollback vacation_itinerary_items restore', new Error(`restored ${restored?.length ?? 0} of ${removedItems.length}`));
        }
      }
      if (removedActivities.length) {
        const { data: restored, error } = await supabase.from('vacation_activities').insert(removedActivities.map(asInsert)).select('id');
        if (error) logDatabaseFailure('build rollback vacation_activities restore', error);
        else if ((restored?.length ?? 0) !== removedActivities.length) {
          logDatabaseFailure('build rollback vacation_activities restore', new Error(`restored ${restored?.length ?? 0} of ${removedActivities.length}`));
        }
      }
      for (const category of changedBudgetCategories) {
        const previous = originalBudgets.get(category);
        if (!previous) continue;
        // Restoring a row read before the build; zero rows is a failed restore,
        // leaving the build's planned amount in a budget the family never
        // accepted. Logged, as above. Audit C1-S9-63.
        const { data: restoredBudget, error } = await supabase.from('vacation_budgets')
          .update({ planned_cents: previous.planned_cents, notes: previous.notes })
          .eq('id', previous.id).eq('vacation_id', vacationId).select('id');
        if (error) logDatabaseFailure('build rollback vacation_budgets restore', error);
        else if (wroteNoRows(restoredBudget)) {
          logDatabaseFailure('build rollback vacation_budgets restore', new Error('no rows updated'));
        }
      }
    };

    const buildFailure = async (message: string, error?: unknown) => {
      if (error) logDatabaseFailure('build persistence', error);
      await rollbackBuild();
      return databaseUnavailable(message);
    };

    // activities
    if (plan.activities.length) {
      const rows = plan.activities.map((x) => ({ family_id: familyId, vacation_id: vacationId, name: x.name, category: x.category ?? null, location: x.location ?? null, family_friendly: x.family_friendly ?? true, cost_cents: x.cost == null ? null : Math.round(x.cost * 100), notes: CONCIERGE_PLAN_MARKER, created_by: ctx!.user.id }));
      const { data, error } = await supabase.from('vacation_activities').insert(rows).select('id, updated_at');
      if (data) createdActivities.push(...data);
      if (error || !data || data.length !== rows.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), error ?? new Error('Activity insert returned an incomplete result.'));
      added.activities = rows.length;
    }
    // itinerary — ensure days exist, map day number -> day_id
    if (plan.itinerary.length) {
      const existing = new Map((days.data ?? []).map((d) => [d.day_date, d.id]));
      const toCreate = range.filter((d) => !existing.has(d)).map((d) => ({ family_id: familyId, vacation_id: vacationId, day_date: d, created_by: ctx!.user.id }));
      if (toCreate.length) {
        const { data: created, error } = await supabase.from('vacation_itinerary_days').insert(toCreate).select('id, day_date, updated_at');
        if (created) createdDays.push(...created);
        if (error || !created || created.length !== toCreate.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), error ?? new Error('Itinerary day insert returned an incomplete result.'));
        for (const d of created) {
          existing.set(d.day_date, d.id);
        }
      }
      const dayIds = range.map((d) => existing.get(d)).filter(Boolean) as string[];
      if (dayIds.length !== range.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), new Error('Itinerary days could not be resolved.'));
      const rows = plan.itinerary.map((x) => ({
        family_id: familyId, vacation_id: vacationId,
        day_id: dayIds[x.day - 1],
        day_part: x.day_part,
        kind: x.kind,
        title: x.title, notes: CONCIERGE_PLAN_MARKER, created_by: ctx!.user.id,
      })).filter((x) => x.day_id);
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_itinerary_items').insert(rows).select('id, updated_at');
        if (data) createdItems.push(...data);
        if (error || !data || data.length !== rows.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), error ?? new Error('Itinerary item insert returned an incomplete result.'));
        added.items = rows.length;
      }
    }
    // budget
    if (plan.budget.length) {
      const rows = [...new Map(plan.budget.map((x) => [x.category, { family_id: familyId, vacation_id: vacationId, category: x.category, planned_cents: Math.round(x.planned * 100), created_by: ctx!.user.id }])).values()];
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_budgets').upsert(rows, { onConflict: 'vacation_id,category' }).select('id, category, updated_at');
        for (const row of data ?? []) {
          if (originalBudgets.has(row.category)) changedBudgetCategories.push(row.category);
          else createdBudgets.push(row);
        }
        if (error || !data || data.length !== rows.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), error ?? new Error('Budget upsert returned an incomplete result.'));
        added.budget = rows.length;
      }
    }
    // Rebuild: the prior build's rows go only now, with the whole new plan in —
    // INSERT FIRST, then delete by id, for the reason the recommendations
    // branch gives. Each delete is FENCED at write time, not just chosen by
    // id: still unbooked, still stamped, and `updated_at` exactly as it was
    // when the family asked (see `replaceable`; the 0070 trigger moves it on
    // every edit). A row another tab or parent booked, edited or un-stamped
    // during generation, or while the new plan was being written, no longer
    // matches and stays — with its tickets, which the activity delete would
    // otherwise cascade. One builder insert is one statement, so its rows
    // share one `updated_at` and this is a delete or two, not one per row.
    // The ERROR gates the response; a short count is that fence at work, not a
    // failure. Audit C1-S9-63.
    const replaceRows = async (
      table: 'vacation_activities' | 'vacation_itinerary_items',
      rows: { id: string; updated_at: string }[],
      into: Record<string, unknown>[],
    ): Promise<unknown | null> => {
      const byStamp = new Map<string, string[]>();
      for (const row of rows) byStamp.set(row.updated_at, [...(byStamp.get(row.updated_at) ?? []), row.id]);
      for (const [stamp, ids] of byStamp) {
        const { data: removed, error } = await supabase.from(table).delete()
          .eq('family_id', familyId).eq('vacation_id', vacationId).in('id', ids)
          .eq('booked', false).like('notes', `%${escapeLike(CONCIERGE_PLAN_MARKER)}%`).eq('updated_at', stamp)
          .select('*');
        if (error) return error;
        into.push(...(removed ?? []));
        if ((removed?.length ?? 0) !== ids.length) console.warn(`[vacation-ai] build replace ${table}: ${ids.length - (removed?.length ?? 0)} row(s) changed since the re-read and were kept`);
      }
      return null;
    };
    if (priorActivities.length) {
      const error = await replaceRows('vacation_activities', priorActivities, removedActivities);
      if (error) return buildFailure(t('ai.couldNotSaveTheGenerated'), error);
    }
    if (priorItems.length) {
      const error = await replaceRows('vacation_itinerary_items', priorItems, removedItems);
      if (error) return buildFailure(t('ai.couldNotSaveTheGenerated'), error);
    }
    // packing (rule-based, always solid)
    const master =(packing.data ?? []).length ? null : await supabase.from('vacation_packing_lists').insert({ family_id: familyId, vacation_id: vacationId, name: 'Master list', is_master: true, created_by: ctx!.user.id }).select('id, updated_at').single();
    const listId = master?.data?.id;
    if (master?.data) createdPackingList = master.data;
    if (master?.error) return buildFailure(t('ai.couldNotSaveTheGenerated'), master.error);
    if (listId) {
      const sugg = suggestPacking({ kind: trip.kind, nights: nights || 5, isInternational: trip.is_international, hasChildren, hasBaby: false, activities: a.map((x) => x.name) });
      const rows = sugg.map((s) => ({ family_id: familyId, vacation_id: vacationId, list_id: listId, name: s.name, category: s.category as never, quantity: s.quantity, ai_suggested: true, created_by: ctx!.user.id }));
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_packing_items').insert(rows).select('id, updated_at');
        if (data) createdPackingItems.push(...data);
        if (error || !data || data.length !== rows.length) return buildFailure(t('ai.couldNotSaveTheGenerated'), error ?? new Error('Packing insert returned an incomplete result.'));
        added.packing = rows.length;
      }
    }

    return NextResponse.json({ ok: true, added });
  }

  // ---------- CONCIERGE (chat) ----------
  if (action === 'concierge') {
    const message = body.message?.trim();
    if (!message) return NextResponse.json({ error: t('ai.emptyMessage') }, { status: 400 });

    // A FIRST message has no conversation yet, and it gets one only once the
    // model has answered (below). Creating it here, before the call, left a
    // conversation titled with the question behind every failed first message
    // — and the client, never handed its id, made another on each retry.
    let conversationId = body.conversationId ?? null;
    if (conversationId) {
      const { data: conversation, error } = await supabase.from('vacation_ai_conversations').select('id').eq('id', conversationId).eq('family_id', familyId).eq('vacation_id', vacationId).maybeSingle();
      if (error) {
        logDatabaseFailure('conversation ownership read', error);
        return databaseUnavailable(t('ai.tripConversationIsTemporarilyUnavailable'));
      }
      if (!conversation) return NextResponse.json({ error: t('ai.conversationNotFound') }, { status: 404 });
    }

    // The history is read BEFORE anything is written and the new message is
    // appended to it in memory: both rows are persisted only after the model
    // answered. Persisting the user row first left it in the conversation when
    // the provider failed, so a retry fed the model a duplicated question.
    let history: { role: string; content: string }[] = [];
    if (conversationId) {
      const { data, error: historyError } = await supabase.from('vacation_ai_messages').select('role, content').eq('family_id', familyId).eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(19);
      if (historyError) {
        logDatabaseFailure('conversation history read', historyError);
        return databaseUnavailable(t('ai.tripConversationIsTemporarilyUnavailable'));
      }
      history = data ?? [];
    }
    const turns = [...history.filter((h) => h.role === 'user' || h.role === 'assistant').map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })), { role: 'user' as const, content: message }];

    const budgetSummary = summarizeBudget(budgets.data ?? [], expenses.data ?? []);
    const context = `TRIP CONTEXT
Title: ${trip.title} | Destination: ${trip.destination ?? '—'} | Type: ${trip.kind} | Dates: ${trip.start_date ?? '?'} to ${trip.end_date ?? '?'} (${nights} nights)
Travelers: ${m.length}${hasChildren ? ' (with children)' : ''}
Lodging: ${(lodging.data ?? []).length} | Flights: ${(flights.data ?? []).length} | Ground transport: ${(transport.data ?? []).length}
Activities: ${a.length} | Reservations: ${r.length}
Budget planned: $${(budgetSummary.planned_cents / 100).toFixed(0)} | spent: $${(budgetSummary.spent_cents / 100).toFixed(0)}
Itinerary days planned: ${(days.data ?? []).length} | items: ${(items.data ?? []).length}`;

    const system = `You are Bubaly's friendly, expert family Vacation Concierge. Give concise, practical, family-aware advice for THIS trip using the context. Suggest specific activities, restaurants, packing, budgeting, and routing. When asked to build/plan, give a clear day-by-day outline. Keep replies focused and warm. Use the family's actual trip details.\n\n${context}`;

    let reply: string | null;
    try {
      reply = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'vacations.concierge', text: 'Vacation concierge reply' },
        async (obs) => {
          const provider = await resolveProvider();
          const completion = await provider.complete({ system, messages: turns, tools: [], maxTokens: 1000 });
          obs.used(provider.model, completion.usage);
          // No text is a failure, not an answer: a canned apology used to be
          // stored as the assistant's reply and returned as a 200, so the
          // family read a failure as an answer and the conversation kept it.
          if (!completion.text) obs.failed(new Error('The concierge returned no text.'));
          return completion.text || null;
        },
      );
    } catch (err) {
      console.error('Concierge error:', err);
      return NextResponse.json({ error: t('ai.aiIsTemporarilyUnavailable') }, { status: 502 });
    }
    if (!reply) return NextResponse.json({ error: t('ai.aiIsTemporarilyUnavailable') }, { status: 502 });

    if (!conversationId) {
      const { data: convo, error } = await supabase.from('vacation_ai_conversations').insert({ family_id: familyId, vacation_id: vacationId, title: message.slice(0, 60), created_by: ctx.user.id }).select('id').single();
      if (error || !convo) {
        console.error('Vacation AI conversation write failed:', error);
        return databaseUnavailable(t('ai.couldNotStartTheTrip'));
      }
      conversationId = convo.id;
    }

    const { error: userMessageError } = await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'user', content: message, created_by: ctx.user.id }).select('id').single();
    if (userMessageError) {
      logDatabaseFailure('user message write', userMessageError);
      return databaseUnavailable(t('ai.couldNotSaveYourMessage'));
    }
    const { error: assistantMessageError } = await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'assistant', content: reply, created_by: ctx.user.id }).select('id').single();
    if (assistantMessageError) {
      logDatabaseFailure('assistant message write', assistantMessageError);
      return databaseUnavailable(t('ai.couldNotSaveTheConcierge'));
    }
    return NextResponse.json({ conversationId, reply });
  }

  return NextResponse.json({ error: t('ai.unknownAction') }, { status: 400 });
}
