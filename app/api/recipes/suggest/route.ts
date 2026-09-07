import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { buildSuggestPrompt, parseSuggestions, type VaultRecipeLite } from '@/lib/recipes/suggest';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

// "What can we make tonight?" — AI picks from the family's saved vault only, so
// every suggestion is actually cookable. Optional free-text constraint.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('suggest.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-recipe-suggest:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: t('suggest.tooManyRecipeSuggestionsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('suggest.requestBodyIsTooLarge') }, { status: 400 });
  const { constraint } = (boundedBody.value ?? {}) as { constraint?: string };
  const { data: recipes } = await supabase
    .from('family_recipes')
    .select('id, name, cuisine, category, tags, ingredients, photo_url')
    .eq('family_id', ctx.active.familyId)
    .order('is_favorite', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(80);

  if (!recipes || recipes.length === 0) {
    return NextResponse.json({ picks: [], empty: true });
  }

  const lite: VaultRecipeLite[] = recipes.map((r) => ({
    id: r.id, name: r.name, cuisine: r.cuisine, category: r.category, tags: r.tags,
    ingredients: (r.ingredients as unknown as { name: string }[]) ?? [],
  }));

  let picks;
  try {
    const prompt = buildSuggestPrompt(lite, constraint);
    picks = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'recipes.suggest', text: 'Suggest recipes from the vault' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], tools: [], maxTokens: 600 });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = parseSuggestions(completion.text, recipes.map((r) => r.id));
        // `parseSuggestions` keeps only ids the family actually owns, so an
        // empty list means the model named nothing real. The route answers 200
        // with `picks: []` either way and the cook sees "no suggestions" — the
        // same thing a working model with nothing to offer would produce.
        if (parsed.length === 0) obs.failed(new Error('The model suggested no recipes from this vault.'));
        return parsed;
      },
    );
  } catch (err) {
    console.error('Recipe suggest error:', err);
    return NextResponse.json({ error: t('suggest.aiIsTemporarilyUnavailable') }, { status: 502 });
  }

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const results = picks.map((p) => {
    const r = byId.get(p.id)!;
    return { id: r.id, name: r.name, cuisine: r.cuisine, category: r.category, photoUrl: r.photo_url, reason: p.reason };
  });
  return NextResponse.json({ picks: results });
}
