import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeGroceryList, buildGroceryPrompt, parseGroceryResponse } from '@/lib/grocery/grocery-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();

    const { data: lists } = await supabase
      .from('grocery_lists')
      .select('id')
      .eq('family_id', familyId)
      .eq('is_archived', false)
      .order('created_at')
      .limit(1);

    const listId = lists?.[0]?.id;
    if (!listId) {
      return NextResponse.json({ error: 'No active grocery list' }, { status: 400 });
    }

    const { data: items } = await supabase
      .from('grocery_items')
      .select('name, category, is_checked')
      .eq('list_id', listId)
      .limit(200);

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No grocery items to analyze' }, { status: 400 });
    }

    const analysis = analyzeGroceryList(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildGroceryPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseGroceryResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Grocery AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze grocery list' }, { status: 500 });
  }
}
