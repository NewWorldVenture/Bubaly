import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeHomework, buildHomeworkPrompt, parseHomeworkResponse } from '@/lib/homework/homework-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: assignments } = await supabase
      .from('homework_assignments')
      .select('title, subject, status, due_at')
      .eq('family_id', familyId)
      .limit(100);

    if (!assignments || assignments.length === 0) {
      return NextResponse.json({ error: 'No homework to analyze' }, { status: 400 });
    }

    const analysis = analyzeHomework(assignments);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildHomeworkPrompt(assignments);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseHomeworkResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Homework AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze homework' }, { status: 500 });
  }
}
