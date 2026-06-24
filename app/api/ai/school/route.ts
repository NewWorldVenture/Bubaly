import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeSchool, buildSchoolPrompt, parseSchoolResponse } from '@/lib/school/school-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { count: classCount } = await supabase
      .from('school_classes')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId);

    const { data: grades } = await supabase
      .from('grades')
      .select('subject, grade_type, score, max_score, date')
      .eq('family_id', familyId)
      .order('date', { ascending: false })
      .limit(200);

    if ((classCount ?? 0) === 0 && (!grades || grades.length === 0)) {
      return NextResponse.json({ error: 'No school data to analyze' }, { status: 400 });
    }

    const analysis = analyzeSchool(classCount ?? 0, grades ?? []);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildSchoolPrompt(grades ?? []);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseSchoolResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('School AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze school data' }, { status: 500 });
  }
}
