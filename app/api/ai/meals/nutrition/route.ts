import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { coerceNutrition, parseModelJSON, type Nutrition } from '@/lib/meals/nutrition';
import { weekDates } from '@/lib/meals/planner';
import type { NutritionSubject } from '@/lib/database.types';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUBJECTS: NutritionSubject[] = ['recipe', 'meal', 'week'];

interface IngredientLike { name?: string; quantity?: string; unit?: string }
function ingredientLines(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((i: IngredientLike) => `${i.quantity ?? ''} ${i.unit ?? ''} ${i.name ?? ''}`.trim())
    .filter(Boolean)
    .join('; ');
}

const SYSTEM =
  'You are a registered-dietitian-grade nutrition estimator. Estimate nutrition from the dish/ingredients given. ' +
  'Be realistic; when ingredients are sparse, estimate from a typical preparation. ' +
  'Respond with ONLY a JSON object (no prose, no markdown) of this exact shape, numbers only: ' +
  '{ "calories": int, "protein_g": num, "carbs_g": num, "fat_g": num, "fiber_g": num, "sugar_g": num, "sodium_mg": num, "summary": "one practical sentence" }';

/**
 * AI Nutrition Analysis for a recipe, a single meal, or a whole planned week.
 * Results are cached per (family, subject_type, subject_id) in meal_nutrition so
 * unchanged content never re-bills the model — pass `refresh: true` to recompute.
 */
export async function POST(req: Request) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('nutrition.unauthorized') }, { status: 401 }); }
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: t('nutrition.aiIsNotConfiguredOpenai') }, { status: 503 });
  }

  const familyId = ctx.active.familyId;
  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('nutrition.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const subjectType = String(body.subjectType ?? '') as NutritionSubject;
  const subjectId = String(body.subjectId ?? '').slice(0, 64);
  const refresh = body.refresh === true;
  if (!SUBJECTS.includes(subjectType) || !subjectId) {
    return NextResponse.json({ error: t('nutrition.subjecttypeRecipeMealWeekAnd') }, { status: 400 });
  }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-meals-nutrition:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: t('nutrition.tooManyNutritionRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  // Cache hit -------------------------------------------------------------
  if (!refresh) {
    const { data: cached } = await supabase.from('meal_nutrition').select('*')
      .eq('family_id', familyId).eq('subject_type', subjectType).eq('subject_id', subjectId).maybeSingle();
    if (cached) return NextResponse.json({ nutrition: cached, cached: true });
  }

  // Build the prompt for the subject --------------------------------------
  let userMsg = '';
  let servings: number | null = null;
  let weekDetails: { label: string; date: string }[] | null = null;

  if (subjectType === 'recipe') {
    const { data: r } = await supabase.from('family_recipes')
      .select('name,servings,ingredients,category,allergy_flags').eq('id', subjectId).eq('family_id', familyId).maybeSingle();
    if (!r) return NextResponse.json({ error: t('nutrition.recipeNotFound') }, { status: 404 });
    servings = r.servings ?? 1;
    userMsg = `Dish: ${r.name} (${r.category}). Servings: ${servings}. Ingredients: ${ingredientLines(r.ingredients)}.\n` +
      `Report nutrition PER SERVING.`;
  } else if (subjectType === 'meal') {
    const { data: m } = await supabase.from('meals')
      .select('name,meal_type,ingredients,notes').eq('id', subjectId).eq('family_id', familyId).maybeSingle();
    if (!m) return NextResponse.json({ error: t('nutrition.mealNotFound') }, { status: 404 });
    servings = 1;
    userMsg = `Dish: ${m.name} (${m.meal_type}). Ingredients: ${ingredientLines(m.ingredients) || 'typical preparation'}.\n` +
      `Report nutrition for ONE serving.`;
  } else {
    // week: subjectId is the week-start date; analyze the planned meals.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(subjectId)) {
      return NextResponse.json({ error: t('nutrition.forAWeekSubjectidMust') }, { status: 400 });
    }
    const dates = weekDates(subjectId);
    const { data: plans } = await supabase.from('meal_plans')
      .select('plan_date,meal_type,meal_id').eq('family_id', familyId)
      .gte('plan_date', dates[0]).lte('plan_date', dates[6]);
    const mealIds = [...new Set((plans ?? []).map((p) => p.meal_id).filter((x): x is string => !!x))];
    const { data: mealRows } = mealIds.length
      ? await supabase.from('meals').select('id,name').in('id', mealIds)
      : { data: [] as { id: string; name: string }[] };
    const nameById = new Map((mealRows ?? []).map((m) => [m.id, m.name]));
    const lines = (plans ?? [])
      .map((p) => ({ label: nameById.get(p.meal_id ?? '') ?? 'meal', date: p.plan_date, meal_type: p.meal_type }))
      .filter((l) => l.label !== 'meal' || true);
    if (lines.length === 0) {
      return NextResponse.json({ error: t('nutrition.noPlannedMealsForThis') }, { status: 422 });
    }
    weekDetails = lines.map((l) => ({ label: l.label, date: l.date }));
    userMsg = `Estimate the AVERAGE PER DAY nutrition across this week's planned meals.\n` +
      lines.map((l) => `- ${l.date} ${l.meal_type}: ${l.label}`).join('\n') +
      `\nReport the average nutrition for ONE day.`;
  }

  // Ask the model ---------------------------------------------------------
  // The parse moved INSIDE the wrapper on purpose. A model that answers with
  // prose instead of JSON costs the same tokens and leaves the family with the
  // same "try again", but outside the wrapper it would settle the row
  // `completed` — the one shape of failure this route actually produces.
  let parsed: { nutrition: Nutrition; summary: string | null } | null;
  try {
    parsed = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'meals.nutrition', text: `Nutrition for a ${subjectType}` },
      async (obs) => {
        const completion = await (await resolveProvider()).complete({
          system: SYSTEM, messages: [{ role: 'user', content: userMsg }], tools: [], maxTokens: 600,
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const out = parseModelJSON(completion.text);
        if (!out || Object.keys(out).length === 0) {
          obs.failed(new Error('The nutrition estimate did not parse as JSON.'));
          return null;
        }
        return {
          nutrition: coerceNutrition(out),
          summary: typeof out.summary === 'string' ? out.summary.slice(0, 280) : null,
        };
      },
    );
  } catch (err) {
    console.error('Meal nutrition generation error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }

  if (!parsed) return NextResponse.json({ error: t('nutrition.couldNotReadTheNutrition') }, { status: 422 });
  const { nutrition: n, summary } = parsed;

  // Upsert the cache ------------------------------------------------------
  const row = {
    family_id: familyId, subject_type: subjectType, subject_id: subjectId, servings,
    calories: n.calories, protein_g: n.protein_g, carbs_g: n.carbs_g, fat_g: n.fat_g,
    fiber_g: n.fiber_g, sugar_g: n.sugar_g, sodium_mg: n.sodium_mg,
    summary, details: weekDetails ? { perMeal: weekDetails } : null, created_by: ctx.user.id,
  };
  const { data: saved, error } = await supabase.from('meal_nutrition')
    .upsert(row, { onConflict: 'family_id,subject_type,subject_id' })
    .select('*').single();
  if (error) {
    console.error('Meal nutrition write failed:', error);
    return NextResponse.json({ error: t('nutrition.couldNotSaveTheNutrition') }, { status: 500 });
  }

  return NextResponse.json({ nutrition: saved, cached: false });
}
