import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { getAIConfig } from '@/lib/ai/settings';
import { MAX_FLYER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';
import {
  annotateAllergens, boundedNames, buildPantryChefPrompt, normalizeAllergies, normalizePlanDate, readPantryRecipes,
} from '@/lib/meals/pantry-chef';
import { applySubstitutions, parseConstraintText } from '@/lib/meals/substitutions';
import { addItems } from '@/lib/services/groceries';
import { foodProfile, setSlot } from '@/lib/services/meals';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { accessDeniedResponse, assertAIAccess } from '@/lib/server/ai-access';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';

/**
 * Fridge Chef is part of Smart Kitchen (its only entry point is the kitchen
 * dashboard), so it carries that feature's gate. Without it a Free or
 * trial-expired family could POST photos here directly and each one ran a paid
 * vision-model call outside the Free plan's monthly AI allowance.
 */
const FRIDGE_CHEF_FEATURE_HREF = '/dashboard/kitchen';
const FRIDGE_CHEF_FEATURE_KEY = 'smart-kitchen';

// Fridge Chef — snap a photo of the fridge/pantry, get allergy-aware dinner
// ideas, and push the missing ingredients straight to the shared grocery list.
// Phase 1 (photo → recipes) uses the configured OpenAI vision model; Phase 2
// (add to grocery) writes the chosen recipe's "need" items under the caller's
// RLS session.
export const runtime = 'nodejs';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const now = new Date();
    const familyId = ctx.active.familyId;
    const userId = ctx.user.id;
    const supabase = await createServer();

    const refused = await refuseUnlessEntitled(supabase, familyId, [FRIDGE_CHEF_FEATURE_HREF]);
    if (refused) return refused;

    const limited = await enforceAIRateLimit(supabase, `ai-pantry-chef:${userId}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: t('pantryChef.tooManyFridgeScansPlease') },
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

    // Phases 2 and 3 change the household's list and week. A guest sees the
    // household and changes nothing in it — the manual meal writes refuse one,
    // and so does this route, before anything is written.
    if ((body.addToPlan || Array.isArray(body.addToGrocery)) && ctx.active.role === 'guest') {
      return NextResponse.json({ error: t('actionRefusal.notAllowed') }, { status: 403 });
    }

    // ── Phase 3: plan a suggested recipe for dinner ──────────────────────────
    if (body.addToPlan && typeof body.addToPlan === 'object') {
      const plan = body.addToPlan;
      const title = typeof plan.title === 'string' ? plan.title.trim().slice(0, 200) : '';
      if (!title) return NextResponse.json({ error: t('pantryChef.recipeTitleIsRequired') }, { status: 400 });
      let planDate: string;
      try {
        const timezone = ctx.active.family.timezone;
        if (typeof timezone !== 'string') throw new RangeError('The household timezone is unavailable.');
        planDate = normalizePlanDate(plan.planDate, timezone, now);
      } catch (error) {
        console.error('[ai/pantry-chef] family dinner date unavailable', error);
        return NextResponse.json({ error: t('pantryChef.fridgeChefIsUnavailableRight') }, { status: 503 });
      }
      // Bounded like the meal service's own ingredients: an over-long name here
      // was stored on the dish and then refused by addItems every time the
      // week's plan was sent to the grocery list, for as long as it stayed.
      const ingredients = boundedNames([...(Array.isArray(plan.have) ? plan.have : []), ...(Array.isArray(plan.need) ? plan.need : [])], 50)
        .map((name) => ({ name, quantity: null, unit: null }));
      const steps = typeof plan.steps === 'string' ? plan.steps.slice(0, 2000).trim() : '';

      // Through the meal service, like the meals page and the assistant. The two
      // raw inserts this replaces put a SECOND dinner into a slot that already
      // held one — no unique (family, date, type) key stops it — and the meals
      // page then refused the whole week ("We couldn't load all meal choices")
      // on every retry. `setSlot` replaces what the slot held, reuses an
      // identical dish rather than cloning it, and removes a dish it created
      // when the plan write then fails, where the old meals insert stayed
      // behind and every retry added another copy.
      const planned = await setSlot(scopeFromUserContext(ctx, supabase), {
        date: planDate, mealType: 'dinner', mealName: title, ingredients,
        ...(steps ? { notes: steps } : {}),
      });
      if (!planned.ok) {
        console.error('[ai/pantry-chef] meal plan write failed', { code: planned.code });
        return NextResponse.json({ error: t('pantryChef.couldNotAddThatRecipe') }, { status: 500 });
      }
      return NextResponse.json({ planned: true, planDate, replaced: planned.data.replaced });
    }

    // ── Phase 2: add the chosen recipe's missing ingredients to grocery ──────
    if (Array.isArray(body.addToGrocery)) {
      const names = boundedNames(body.addToGrocery, 40);
      if (names.length === 0) return NextResponse.json({ added: 0 });

      // The household's allergies, fail closed — the same swap the meal plan's
      // shopping list gets (addFromMealPlan). A recipe the model let peanut
      // butter into, or one the family chose despite its "May contain" badge,
      // otherwise put the peanut butter itself on the list.
      const scope = scopeFromUserContext(ctx, supabase);
      const profile = await foodProfile(scope);
      if (!profile.ok) {
        console.error('[ai/pantry-chef] allergy read failed', { code: profile.code });
        return NextResponse.json({ error: t('pantryChef.fridgeChefIsUnavailableRight') }, { status: 503 });
      }
      const safe = applySubstitutions(names.map((name) => ({ name })), {
        allergies: profile.data.household.allergies.flatMap((note) => parseConstraintText(note)),
      });
      const swapped = safe.substitutions.map((s) => ({ from: s.from, to: s.to }));
      if (safe.items.length === 0) return NextResponse.json({ added: 0, skipped: 0, swapped });

      // Through the grocery service, like every other writer: the family's
      // default list found or created as ONE operation (0443, DATA-007), items
      // already open on it skipped instead of added twice, the aisle filled in,
      // and the service's own name bounds applied. The raw insert this replaces
      // did none of that, so a second tap doubled the list.
      const result = await addItems(scope, { items: safe.items.map((item) => ({ name: item.name })) });
      if (!result.ok) {
        console.error('[ai/pantry-chef] grocery add failed', { code: result.code });
        return NextResponse.json({ error: t('pantryChef.couldNotAddThoseItems') }, { status: 500 });
      }
      return NextResponse.json({
        added: result.data.added.length, skipped: result.data.skipped.length,
        ...(swapped.length ? { swapped } : {}),
      });
    }

    // ── Phase 1: photo → allergy-aware recipe suggestions ────────────────────
    const data = body.data ?? '';
    const mediaType = body.mediaType ?? '';
    if (!data) return NextResponse.json({ error: t('pantryChef.noPhotoReceived') }, { status: 400 });
    if (!IMAGE_TYPES.includes(mediaType)) return NextResponse.json({ error: t('pantryChef.uploadAPhotoJpgPng') }, { status: 400 });
    if (data.length > 8_000_000) return NextResponse.json({ error: t('pantryChef.photoIsTooLarge5') }, { status: 400 });

    // A model call: it counts against the family's monthly AI allowance and is
    // recorded as an ai_requests row like every other one.
    const access = await assertAIAccess(ctx, { db: supabase, now, featureKey: FRIDGE_CHEF_FEATURE_KEY, label: t('pantryChef.fridgeChef') });
    if (!access.ok) return accessDeniedResponse(access, t);

    // Read the family's allergies with the service client so the safety filter
    // works for every member (medical_profiles is manager-gated to clients); the
    // raw profiles are never returned — only the normalised terms drive the
    // prompt + the allergenConflict flag.
    const service = createServiceClient();
    const { data: profiles, error: profilesError } = await service
      .from('medical_profiles')
      .select('allergies')
      .eq('family_id', familyId);
    // `?? []` on THIS read is not a degradation, it is the safety filter
    // switching itself off. `allergies` is both what `buildPantryChefPrompt`
    // tells the model to avoid and what `annotateAllergens` flags the returned
    // recipes against, so an empty list means the photo is answered with no
    // allergy constraint and no allergen warning — and the response says
    // `allergiesConsidered: 0`, which is exactly what a family with none on
    // file sees. A household whose child has a peanut allergy would have been
    // shown peanut recipes, unflagged, and told nothing had gone wrong.
    if (profilesError) {
      console.error('[ai/pantry-chef] allergy read failed', profilesError);
      return NextResponse.json({ error: t('pantryChef.fridgeChefIsUnavailableRight') }, { status: 503 });
    }
    const allergies = normalizeAllergies(...(profiles ?? []).map((p) => p.allergies as string | null));


    const aiConfig = await getAIConfig(service);
    const apiKey = aiConfig.openaiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: t('pantryChef.fridgeChefNeedsAnOpenai') }, { status: 503 });
    }
    const model = aiConfig.model && /^(gpt-|o\d|chatgpt-)/i.test(aiConfig.model) ? aiConfig.model : 'gpt-4o';

    const prompt = buildPantryChefPrompt(allergies, now, ctx.active.family.timezone || 'UTC');
    return await withAiRequest(scopeFromUserContext(ctx, supabase), { feature: 'kitchen.fridge_chef', text: t('pantryChef.fridgeChefPhoto') }, async (obs) => {
      const aiRes = await fetchWithDeadline('https://api.openai.com/v1/chat/completions', {
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
        obs.failed(new Error(`OpenAI error ${aiRes.status}`));
        return NextResponse.json({ error: t('pantryChef.couldNotReadThatPhoto') }, { status: 502 });
      }
      const aiJson = await readBoundedResponseJson<{ choices?: Array<{ message?: { content?: string } }> }>(aiRes, 1024 * 1024);
      obs.used(model);
      // A reply with no content, prose, a refusal or an array cut off at the
      // token limit is not "no food in the photo". It answered 200 with no
      // recipes, the screen said "No food spotted", and the request was
      // recorded as completed. Only a JSON `[]` from the model is that answer.
      const parsed = readPantryRecipes(aiJson.choices?.[0]?.message?.content ?? '');
      if (!parsed) {
        obs.failed(new Error('The Fridge Chef reply did not parse.'));
        return NextResponse.json({ error: t('pantryChef.couldNotReadThatPhoto') }, { status: 502 });
      }
      const recipes = annotateAllergens(parsed, allergies);

      return NextResponse.json({ recipes, allergiesConsidered: allergies.length });
    });
  } catch (error) {
    console.error('[ai/pantry-chef] request failed', error);
    return NextResponse.json({ error: t('pantryChef.fridgeChefIsUnavailableRight') }, { status: 500 });
  }
}
