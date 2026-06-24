import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeTimetable, buildTimetablePrompt, parseTimetableResponse } from '@/lib/school/timetable-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: classes } = await supabase
      .from('school_classes')
      .select('subject, teacher, room, time_slot, day_of_week, week_pattern, member_id')
      .eq('family_id', familyId)
      .limit(200);

    if (!classes || classes.length === 0) {
      return NextResponse.json({ error: 'No classes to analyze' }, { status: 400 });
    }

    const analysis = analyzeTimetable(classes);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildTimetablePrompt(classes);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseTimetableResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Timetable AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze timetable' }, { status: 500 });
  }
}
