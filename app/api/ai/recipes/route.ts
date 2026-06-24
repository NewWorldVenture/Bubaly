import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeRecipes, buildRecipesPrompt, parseRecipesResponse } from '@/lib/recipes/recipes-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: recipes } = await supabase
      .from('family_recipes')
      .select('name, category, cuisine, difficulty, prep_time_mins, cook_time_mins, is_favorite')
      .eq('family_id', familyId)
      .limit(200);

    if (!recipes || recipes.length === 0) {
      return NextResponse.json({ error: 'No recipes to analyze' }, { status: 400 });
    }

    const analysis = analyzeRecipes(recipes);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRecipesPrompt(recipes);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRecipesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Recipes AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze recipes' }, { status: 500 });
  }
}
