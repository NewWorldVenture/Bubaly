import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeShoppingLists, buildShoppingPrompt, parseShoppingResponse } from '@/lib/shopping/shopping-ai';
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
      .eq('is_archived', false);

    const listIds = (lists ?? []).map((l) => l.id);
    if (listIds.length === 0) {
      return NextResponse.json({ error: 'No shopping lists to analyze' }, { status: 400 });
    }

    const { data: items } = await supabase
      .from('grocery_items')
      .select('name, category, is_checked')
      .in('list_id', listIds)
      .limit(300);

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No shopping items to analyze' }, { status: 400 });
    }

    const analysis = analyzeShoppingLists(listIds.length, items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildShoppingPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseShoppingResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Shopping AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze shopping lists' }, { status: 500 });
  }
}
