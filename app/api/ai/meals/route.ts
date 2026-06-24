import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeMeals, buildMealsPrompt, parseMealsResponse } from '@/lib/meals/meals-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: meals } = await supabase
      .from('meals')
      .select('name, meal_type, notes')
      .eq('family_id', familyId)
      .limit(200);

    if (!meals || meals.length === 0) {
      return NextResponse.json({ error: 'No meals to analyze' }, { status: 400 });
    }

    const analysis = analyzeMeals(meals);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildMealsPrompt(meals);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseMealsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Meals AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze meals' }, { status: 500 });
  }
}
