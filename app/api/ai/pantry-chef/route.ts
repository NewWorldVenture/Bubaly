import { NextRequest, NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { getAIConfig } from '@/lib/ai/settings';
import { MAX_FLYER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';
import {
  annotateAllergens, buildPantryChefPrompt, normalizeAllergies, normalizePlanDate, parsePantryRecipes,
} from '@/lib/meals/pantry-chef';

// Fridge Chef — snap a photo of the fridge/pantry, get allergy-aware dinner
// ideas, and push the missing ingredients straight to the shared grocery list.
// Phase 1 (photo → recipes) uses the configured OpenAI vision model; Phase 2
// (add to grocery) writes the chosen recipe's "need" items under the caller's
// RLS session.
export const runtime = 'nodejs';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const userId = ctx.user.id;
    const supabase = await createServer();

    const limited = await enforceAIRateLimit(supabase, `ai-pantry-chef:${userId}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many fridge scans. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_FLYER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json(
      { error: boundedBody.reason === 'too_large' ? 'Photo is too large.' : 'Invalid request body' },
      { status: 400 },
    );
    const body = (boundedBody.value ?? {}) as {
      data?: string; mediaType?: string; addToGrocery?: string[];
      addToPlan?: { title?: string; steps?: string; have?: string[]; need?: string[]; planDate?: string };
    };

    // ── Phase 3: plan a suggested recipe for dinner ──────────────────────────
    if (body.addToPlan && typeof body.addToPlan === 'object') {
      const plan = body.addToPlan;
      const title = typeof plan.title === 'string' ? plan.title.trim().slice(0, 200) : '';
      if (!title) return NextResponse.json({ error: 'Recipe title is required.' }, { status: 400 });
      const planDate = normalizePlanDate(plan.planDate);
      const ingredients = [...(Array.isArray(plan.have) ? plan.have : []), ...(Array.isArray(plan.need) ? plan.need : [])]
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .slice(0, 50)
        .map((name) => ({ name: name.trim() }));

      const { data: meal, error: mealError } = await supabase.from('meals').insert({
        family_id: familyId, created_by: userId, name: title, meal_type: 'dinner',
        ingredients: ingredients as never,
        notes: typeof plan.steps === 'string' ? plan.steps.slice(0, 2000) : null,
      }).select('id').single();
      if (mealError || !meal?.id) {
        console.error('[ai/pantry-chef] meal create failed', mealError);
        return NextResponse.json({ error: 'Could not save that recipe.' }, { status: 500 });
      }
      const { error: planError } = await supabase.from('meal_plans').insert({
        family_id: familyId, created_by: userId, meal_id: meal.id,
        plan_date: planDate, meal_type: 'dinner',
      });
      if (planError) {
        console.error('[ai/pantry-chef] meal plan insert failed', planError);
        return NextResponse.json({ error: 'Could not add that recipe to your meal plan.' }, { status: 500 });
      }
      return NextResponse.json({ planned: true, planDate });
    }

    // ── Phase 2: add the chosen recipe's missing ingredients to grocery ──────
    if (Array.isArray(body.addToGrocery)) {
      const names = body.addToGrocery
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter((n) => n.length > 0)
        .slice(0, 40);
      if (names.length === 0) return NextResponse.json({ added: 0 });

      // Get (or create) the family's default grocery list, then append items.
      const { data: list, error: listError } = await supabase
        .from('grocery_lists')
        .select('id')
        .eq('family_id', familyId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (listError) {
        console.error('[ai/pantry-chef] grocery list read failed', listError);
        return NextResponse.json({ error: 'Could not open your grocery list.' }, { status: 500 });
      }
      let listId = list?.id;
      if (!listId) {
        const { data: created, error: createError } = await supabase
          .from('grocery_lists')
          .insert({ family_id: familyId, name: 'Groceries', created_by: userId })
          .select('id')
          .single();
        if (createError || !created) {
          console.error('[ai/pantry-chef] grocery list create failed', createError);
          return NextResponse.json({ error: 'Could not create your grocery list.' }, { status: 500 });
        }
        listId = created.id;
      }

      const rows = names.map((name) => ({ family_id: familyId, list_id: listId!, name, created_by: userId }));
      const { data: inserted, error: insertError } = await supabase.from('grocery_items').insert(rows).select('id');
      if (insertError) {
        console.error('[ai/pantry-chef] grocery insert failed', insertError);
        return NextResponse.json({ error: 'Could not add those items to your grocery list.' }, { status: 500 });
      }
      return NextResponse.json({ added: inserted?.length ?? 0 });
    }

    // ── Phase 1: photo → allergy-aware recipe suggestions ────────────────────
    const data = body.data ?? '';
    const mediaType = body.mediaType ?? '';
    if (!data) return NextResponse.json({ error: 'No photo received.' }, { status: 400 });
    if (!IMAGE_TYPES.includes(mediaType)) return NextResponse.json({ error: 'Upload a photo (JPG/PNG/WebP).' }, { status: 400 });
    if (data.length > 8_000_000) return NextResponse.json({ error: 'Photo is too large (≈5 MB max).' }, { status: 400 });

    // Read the family's allergies with the service client so the safety filter
    // works for every member (medical_profiles is manager-gated to clients); the
    // raw profiles are never returned — only the normalised terms drive the
    // prompt + the allergenConflict flag.
    const service = createServiceClient();
    const { data: profiles } = await service
      .from('medical_profiles')
      .select('allergies')
      .eq('family_id', familyId);
    const allergies = normalizeAllergies(...(profiles ?? []).map((p) => p.allergies as string | null));

    const aiConfig = await getAIConfig(service);
    const apiKey = aiConfig.openaiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Fridge Chef needs an OpenAI API key. Add one in Admin → AI Engine.' }, { status: 503 });
    }
    const model = aiConfig.model && /^(gpt-|o\d|chatgpt-)/i.test(aiConfig.model) ? aiConfig.model : 'gpt-4o';

    const prompt = buildPantryChefPrompt(allergies, new Date());
    const aiRes = await fetchExternal('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
          ],
        }],
      }),
    }, 60_000);
    if (!aiRes.ok) {
      const bounded = await readBoundedResponseText(aiRes, 64 * 1024);
      console.error('[ai/pantry-chef] OpenAI error', aiRes.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
      return NextResponse.json({ error: 'Could not read that photo. Try a clearer, well-lit shot of your fridge or pantry.' }, { status: 502 });
    }
    const aiJson = await readBoundedResponseJson<{ choices?: Array<{ message?: { content?: string } }> }>(aiRes, 1024 * 1024);
    const text = aiJson.choices?.[0]?.message?.content ?? '[]';
    const recipes = annotateAllergens(parsePantryRecipes(text), allergies);

    return NextResponse.json({ recipes, allergiesConsidered: allergies.length });
  } catch (error) {
    console.error('[ai/pantry-chef] request failed', error);
    return NextResponse.json({ error: 'Fridge Chef is unavailable right now. Please try again.' }, { status: 500 });
  }
}
