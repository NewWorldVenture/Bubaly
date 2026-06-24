import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeCare, buildCarePrompt, parseCareResponse } from '@/lib/care/care-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: entries } = await supabase
      .from('care_log')
      .select('log_type, occurred_at, wellbeing, note')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(200);

    if (!entries || entries.length === 0) {
      return NextResponse.json({ error: 'No care entries to analyze' }, { status: 400 });
    }

    const analysis = analyzeCare(entries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildCarePrompt(entries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseCareResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Care AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze care log' }, { status: 500 });
  }
}
