import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeCollege, buildCollegePrompt, parseCollegeResponse } from '@/lib/college/college-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: apps } = await supabase
      .from('college_applications')
      .select('school_name, program, status, deadline, tuition, financial_aid')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('deadline')
      .limit(100);

    const { data: scholarships } = await supabase
      .from('scholarships')
      .select('name, provider, amount, status, deadline')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('deadline')
      .limit(100);

    if ((!apps || apps.length === 0) && (!scholarships || scholarships.length === 0)) {
      return NextResponse.json({ error: 'No college data to analyze' }, { status: 400 });
    }

    const analysis = analyzeCollege(apps ?? [], scholarships ?? []);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildCollegePrompt(apps ?? [], scholarships ?? []);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseCollegeResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('College AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze college data' }, { status: 500 });
  }
}
