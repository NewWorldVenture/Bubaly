import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeBinder, buildBinderPrompt, parseBinderResponse } from '@/lib/home/binder-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: entries } = await supabase
      .from('household_info')
      .select('category, label, is_sensitive')
      .eq('family_id', familyId)
      .limit(200);

    if (!entries || entries.length === 0) {
      return NextResponse.json({ error: 'No binder entries to analyze' }, { status: 400 });
    }

    const analysis = analyzeBinder(entries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildBinderPrompt(entries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseBinderResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Binder AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze binder' }, { status: 500 });
  }
}
