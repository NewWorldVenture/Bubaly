import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeSecurityEvents, buildSecurityPrompt, parseSecurityResponse } from '@/lib/home/security-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: events } = await supabase
      .from('home_security_events')
      .select('kind, severity, resolved, title')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(200);

    if (!events || events.length === 0) {
      return NextResponse.json({ error: 'No security events to analyze' }, { status: 400 });
    }

    const analysis = analyzeSecurityEvents(events);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildSecurityPrompt(events);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseSecurityResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Security AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze security events' }, { status: 500 });
  }
}
