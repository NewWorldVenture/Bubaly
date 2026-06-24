import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeScreenTime, buildScreenTimePrompt, parseScreenTimeResponse } from '@/lib/screen-time/screen-time-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: entries } = await supabase
      .from('screen_time_entries')
      .select('entry_date, minutes, category, device')
      .eq('family_id', familyId)
      .order('entry_date', { ascending: false })
      .limit(200);

    if (!entries || entries.length === 0) {
      return NextResponse.json({ error: 'No screen time entries to analyze' }, { status: 400 });
    }

    const analysis = analyzeScreenTime(entries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildScreenTimePrompt(entries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseScreenTimeResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Screen time AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze screen time' }, { status: 500 });
  }
}
