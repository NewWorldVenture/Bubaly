import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzePantry, buildPantryPrompt, parsePantryResponse } from '@/lib/pantry/pantry-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: items } = await supabase
      .from('pantry_items')
      .select('name, category, location, quantity, expires_at, low_threshold')
      .eq('family_id', familyId)
      .limit(200);

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No pantry items to analyze' }, { status: 400 });
    }

    const analysis = analyzePantry(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildPantryPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parsePantryResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Pantry AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze pantry' }, { status: 500 });
  }
}
