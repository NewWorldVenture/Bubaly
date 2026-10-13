import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext, todayKeyFor } from '@/lib/services/scope';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import {
  buildCandidates, buildPlannerSystem, buildPlannerUser, parsePlan, refParts,
  PLAN_MEAL_TYPES, type PlannerRequest,
} from '@/lib/meals/planner';
import { foodProfile, isDayKey, parseIngredients, planWeek, type PlanEntryInput } from '@/lib/services/meals';
import { allergenConflict, parseConstraintText } from '@/lib/meals/substitutions';
import { scoreWeekNights } from '@/lib/meals/week-context';
import { readDisplayCalendarOccurrences } from '@/lib/calendar/display-occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { isValidTimezone } from '@/lib/time/zoned';
import { usableSoon } from '@/lib/pantry/logic';
import { readPlannerMeals, readPlannerRecipes, readPlannerPantry } from '@/lib/meals/planner-inputs';
import type { MealType } from '@/lib/database.types';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const databaseUnavailable = (message: string) => NextResponse.json({ error: message }, { status: 503 });

function logDatabaseFailure(operation: string, error: unknown) {
  console.error(`[ai-meals-plan] ${operation} failed:`, error);
}

/**
 * AI Meal Planner. Auto-fills a week of meal slots using the family's saved
 * meals + recipes, honoring dietary constraints, preferring soon-to-expire
 * pantry items (cuts waste) and planning around the nights the family's own
 * calendar says they will not be cooking. When `write` is true it
 * persists the result into meal_plans (creating meal rows for new/recipe dishes
 * and clearing the targeted slots first), so it's a true one-click planner.
 */
export async function POST(req: Request) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('plan.unauthorized') }, { status: 401 }); }
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: t('plan.aiIsNotConfiguredOpenai') }, { status: 503 });
  }

  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('plan.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const weekStart = String(body.weekStart ?? '').slice(0, 10);
  if (!isDayKey(weekStart)) {
    return NextResponse.json({ error: t('plan.aValidWeekstartYyyyMm') }, { status: 400 });
  }
  const mealTypes = (Array.isArray(body.mealTypes) ? body.mealTypes : ['dinner'])
    .filter((t: string): t is MealType => PLAN_MEAL_TYPES.includes(t as MealType));
  const dietary = (Array.isArray(body.dietary) ? body.dietary : []).map((s: unknown) => String(s)).slice(0, 12);
  const notes = String(body.notes ?? '').slice(0, 400).trim();
  const avoidRepeats = body.avoidRepeats !== false;
  const useExpiring = body.useExpiring !== false;
  const write = body.write === true;
  // A guest sees the household and changes nothing in it. The two manual
  // writes behind this page (planMealAction, removeMealPlanAction) refuse a
  // guest; this one replaced the family's planned week for them, and spent the
  // family's AI allowance doing it. Refused before the model is asked, so the
  // refusal costs nothing. A preview (write: false) changes nothing and stays
  // open to every role, like the page.
  if (write && ctx.active.role === 'guest') {
    return NextResponse.json({ error: t('actionRefusal.notAllowed') }, { status: 403 });
  }

  const supabase = await createServer();
  // The page in front of this is `requireFeature('/dashboard/meals')`; the
  // endpoint was not gated at all, so a trial-expired or closed family (or one
  // whose meals feature an admin switched off) still got paid model calls by
  // POSTing here. Same resolver as the page, before anything is spent.
  const refused = await refuseUnlessEntitled(supabase, familyId, ['/dashboard/meals']);
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-meals-plan:${userId}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('plan.tooManyMealPlanRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  // Candidate dishes ------------------------------------------------------
  const candidateResults = await settleAll([
    readPlannerMeals(supabase, familyId),
    readPlannerRecipes(supabase, familyId),
  ]);
  const candidateError = candidateResults.find((result) => result.error)?.error;
  if (candidateError) {
    logDatabaseFailure('candidate read', candidateError);
    return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
  }
  const [{ data: meals }, { data: recipes }] = candidateResults;

  // The household's recorded allergies, diets and dislikes. The Auto-plan box
  // starts empty, and `dietary` was the only constraint this route knew: a
  // family with a peanut allergy on its medical profile was planned — and,
  // with `write`, SAVED — a week with no allergy line in the prompt at all.
  // Fail closed: an allergy list that could not be read is not "none".
  const scope = scopeFromUserContext(ctx, supabase);
  const profile = await foodProfile(scope);
  if (!profile.ok) {
    logDatabaseFailure('food profile read', { code: profile.code });
    return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
  }
  const household = profile.data.household;
  const allergies = household.allergies.flatMap((note) => parseConstraintText(note));

  // A saved dish that runs into a recorded allergy is not offered to the model
  // at all; what it does offer, and every new dish it invents, is checked again
  // after it answers (below).
  const libraryText = new Map<string, string[]>([
    ...(meals ?? []).map((m): [string, string[]] => [`meal:${m.id}`, [m.name, ...parseIngredients(m.ingredients).map((i) => i.name)]]),
    ...(recipes ?? []).map((r): [string, string[]] => [`recipe:${r.id}`, [r.name, ...parseIngredients(r.ingredients).map((i) => i.name), ...(r.allergy_flags ?? [])]]),
  ]);
  const unsafeRef = (ref: string) => allergies.length > 0 && allergenConflict(libraryText.get(ref) ?? [], allergies) !== null;
  const candidates = buildCandidates(meals ?? [], recipes ?? []).filter((c) => !unsafeRef(c.ref));

  // Expiring pantry items to use up ---------------------------------------
  let expiring: string[] = [];
  if (useExpiring) {
    const { data: pantry, error: pantryError } = await readPlannerPantry(supabase, familyId);
    if (pantryError) {
      logDatabaseFailure('pantry read', pantryError);
      return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
    }
    // The family's day — see the chef route. A window computed from the
    // host's midnight planned meals around the wrong week's expirations.
    // Still-good items only: "use up these expiring pantry items" over food
    // already past its date wrote dishes built on it into the week, and those
    // items sorted first, crowding out what really is about to turn.
    expiring = usableSoon(pantry ?? [], 7, todayKeyFor(ctx)).map((p) => p.name).slice(0, 12);
  }

  // Busy nights ------------------------------------------------------------
  // Complete occurrence sets, including earlier recurring masters and ongoing
  // intervals. Enabled source reads use the coherent archive without fallback.
  if (!isValidTimezone(scope.tz)) return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
  const { data: weekEvents, error: weekEventsError } = await readDisplayCalendarOccurrences(
    supabase,familyId,briefingCalendarBounds(weekStart,scope.tz,0,7),scope.tz,{overlap:true},
  );
  if (weekEventsError) {
    // Fail closed. Planning "around" a calendar we could not read would put a
    // two-hour braise on the night of the away game and call it calendar-aware.
    logDatabaseFailure('calendar read', weekEventsError);
    return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
  }
  let weekContext;
  try {
    weekContext = scoreWeekNights(weekStart, weekEvents, { tz: scope.tz });
  } catch (error) {
    logDatabaseFailure('calendar interval projection',error);
    return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'));
  }

  // What the family typed, plus what it has recorded. The prompt fences every
  // value (buildPlannerUser), so a recorded fact reaches the model as data.
  const constraints = [...new Set([
    ...household.allergies.map((a) => `allergy: ${a}`),
    ...dietary,
    ...household.diet,
    ...household.dislikes.map((d) => `does not eat: ${d}`),
  ])].slice(0, 40);
  const request: PlannerRequest = {
    weekStart, mealTypes: mealTypes.length ? mealTypes : ['dinner'],
    candidates, dietary: constraints, expiring, busyNights: weekContext.busyNights, avoidRepeats, notes,
  };

  // Ask the model ---------------------------------------------------------
  let text: string;
  try {
    text = await withAiRequest(
      scope,
      { feature: 'meals.plan', text: 'Plan the week\u2019s meals' },
      async (obs) => {
        const completion = await (await resolveProvider()).complete({
          system: buildPlannerSystem(),
          messages: [{ role: 'user', content: buildPlannerUser(request) }],
          tools: [], maxTokens: 4500,
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text;
      },
    );
  } catch (err) {
    console.error('Meal plan generation error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }

  // Checked, not trusted: an assignment whose dish runs into a recorded
  // allergy — a new dish by its name or the ingredients the model wrote, a
  // saved one by its saved ingredients and flags, or a "new" dish that only
  // reuses a library dish's name — is left out of the plan, never written.
  // Names cover saved dishes AND recipes: a ref the screen above held back
  // comes back from parsePlan as a "new" dish of the same name.
  const libraryByName = new Map<string, string[]>();
  for (const [ref, name] of [
    ...(meals ?? []).map((m): [string, string] => [`meal:${m.id}`, m.name]),
    ...(recipes ?? []).map((r): [string, string] => [`recipe:${r.id}`, r.name]),
  ]) {
    const key = name.trim().toLowerCase();
    libraryByName.set(key, [...(libraryByName.get(key) ?? []), ref]);
  }
  const unsafe = (a: ReturnType<typeof parsePlan>[number]) => {
    if (allergies.length === 0) return false;
    if (a.ref) return unsafeRef(a.ref);
    if (allergenConflict([a.name, ...(a.ingredients ?? []).map((i) => i.name)], allergies)) return true;
    return !a.ingredients && (libraryByName.get(a.name.trim().toLowerCase()) ?? []).some(unsafeRef);
  };
  const parsed = parsePlan(text, request);
  const assignments = parsed.filter((a) => !unsafe(a));
  const leftOutForAllergies = parsed.length - assignments.length;
  if (assignments.length === 0) {
    // Every dish screened out for a recorded allergy is not "the planner could
    // not produce a plan": say which it was, so the family is not sent off to
    // add meals they already have.
    return NextResponse.json({ error: t(leftOutForAllergies > 0 ? 'plan.everyDishRanIntoAllergy' : 'plan.thePlannerCouldNotProduce') }, { status: 422 });
  }

  // `busyNights` rides along on both replies so the caller can say WHY a
  // Tuesday got a 20-minute dish, quoting the calendar rows it came from.
  if (!write) return NextResponse.json({ assignments, busyNights: weekContext.busyNights, written: false, leftOutForAllergies });

  // Use the same family-scoped write and verified receipt as the manual
  // planner. Recipe IDs are resolved server-side with their ingredients;
  // sparse assignments replace only their exact date/type pairs.
  const entries: PlanEntryInput[] = assignments.map((assignment) => {
    const source = refParts(assignment.ref);
    const slot = { date: assignment.date, mealType: assignment.meal_type };
    if (source?.table === 'meals') return { ...slot, mealId: source.id };
    if (source?.table === 'recipes') return { ...slot, recipeId: source.id };
    return { ...slot, mealName: assignment.name, ...(assignment.ingredients ? { ingredients: assignment.ingredients } : {}) };
  });
  try {
    const saved = await planWeek(scope, entries);
    if (!saved.ok) {
      logDatabaseFailure('meal plan write', { code: saved.code });
      return databaseUnavailable(t('plan.couldNotSaveTheMeal'));
    }
    return NextResponse.json({
      assignments, busyNights: weekContext.busyNights,
      written: true, count: saved.data.planned.length, slots: saved.data.planned, leftOutForAllergies,
    });
  } catch (error) {
    logDatabaseFailure('meal plan write', error);
    return databaseUnavailable(t('plan.couldNotSaveTheMeal'));
  }
}
