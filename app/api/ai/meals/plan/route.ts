import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import {
  buildCandidates, buildPlannerSystem, buildPlannerUser, parsePlan, refParts,
  PLAN_MEAL_TYPES, type PlannerRequest, type PlanAssignment,
} from '@/lib/meals/planner';
import { expiringSoon } from '@/lib/pantry/logic';
import type { MealType } from '@/lib/database.types';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI Meal Planner. Auto-fills a week of meal slots using the family's saved
 * meals + recipes, honoring dietary constraints and
 * preferring soon-to-expire pantry items (cuts waste). When `write` is true it
 * persists the result into meal_plans (creating meal rows for new/recipe dishes
 * and clearing the targeted slots first), so it's a true one-click planner.
 */
export async function POST(req: Request) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'AI is not configured (OpenAI API key missing).' }, { status: 503 });
  }

  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const weekStart = String(body.weekStart ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'A valid weekStart (YYYY-MM-DD) is required.' }, { status: 400 });
  }
  const mealTypes = (Array.isArray(body.mealTypes) ? body.mealTypes : ['dinner'])
    .filter((t: string): t is MealType => PLAN_MEAL_TYPES.includes(t as MealType));
  const dietary = (Array.isArray(body.dietary) ? body.dietary : []).map((s: unknown) => String(s)).slice(0, 12);
  const notes = String(body.notes ?? '').slice(0, 400).trim();
  const avoidRepeats = body.avoidRepeats !== false;
  const useExpiring = body.useExpiring !== false;
  const write = body.write === true;

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-meals-plan:${userId}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many meal-plan requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  // Candidate dishes ------------------------------------------------------
  const [{ data: meals }, { data: recipes }] = await Promise.all([
    supabase.from('meals').select('id,name,meal_type').eq('family_id', familyId),
    supabase.from('family_recipes').select('id,name,category,allergy_flags').eq('family_id', familyId),
  ]);

  const candidates = buildCandidates(meals ?? [], recipes ?? []);

  // Expiring pantry items to use up ---------------------------------------
  let expiring: string[] = [];
  if (useExpiring) {
    const { data: pantry } = await supabase.from('pantry_items')
      .select('name,expires_at').eq('family_id', familyId).not('expires_at', 'is', null);
    expiring = expiringSoon(pantry ?? [], 7).map((p) => p.name).slice(0, 12);
  }

  const request: PlannerRequest = {
    weekStart, mealTypes: mealTypes.length ? mealTypes : ['dinner'],
    candidates, dietary, expiring, avoidRepeats, notes,
  };

  // Ask the model ---------------------------------------------------------
  let text: string;
  try {
    const completion = await (await resolveProvider()).complete({
      system: buildPlannerSystem(),
      messages: [{ role: 'user', content: buildPlannerUser(request) }],
      tools: [], maxTokens: 2000,
    });
    text = completion.text;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 503 });
  }

  const assignments = parsePlan(text, request);
  if (assignments.length === 0) {
    return NextResponse.json({ error: 'The planner could not produce a plan. Try adding a few meals or recipes first.' }, { status: 422 });
  }

  if (!write) return NextResponse.json({ assignments, written: false });

  // Persist into meal_plans ----------------------------------------------
  // Resolve every assignment to a concrete meals.id (meal_plans.meal_id → meals).
  const mealByName = new Map<string, string>((meals ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  const recipeById = new Map<string, { name: string }>((recipes ?? []).map((r) => [r.id, { name: r.name }]));

  async function resolveMealId(a: PlanAssignment): Promise<string | null> {
    const parts = refParts(a.ref);
    if (parts?.table === 'meals') return parts.id;
    // recipe or new → mirror into a meals row (reuse by name to avoid dupes)
    const name = (parts?.table === 'recipes' ? recipeById.get(parts.id)?.name : a.name) || a.name;
    if (!name) return null;
    const existing = mealByName.get(name.toLowerCase());
    if (existing) return existing;
    const { data: created } = await supabase.from('meals')
      .insert({ family_id: familyId, name, meal_type: a.meal_type, created_by: userId })
      .select('id').single();
    if (created) mealByName.set(name.toLowerCase(), created.id);
    return created?.id ?? null;
  }

  const dates = [...new Set(assignments.map((a) => a.date))];
  // Clear the targeted slots so re-planning replaces rather than duplicates.
  await supabase.from('meal_plans').delete().eq('family_id', familyId)
    .in('plan_date', dates).in('meal_type', request.mealTypes);

  const rows: { family_id: string; meal_id: string; plan_date: string; meal_type: MealType; created_by: string }[] = [];
  for (const a of assignments) {
    const mealId = await resolveMealId(a);
    if (mealId) rows.push({ family_id: familyId, meal_id: mealId, plan_date: a.date, meal_type: a.meal_type, created_by: userId });
  }
  if (rows.length) {
    const { error } = await supabase.from('meal_plans').insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ assignments, written: true, count: rows.length });
}
