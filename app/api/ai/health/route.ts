import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeHealth, buildHealthPrompt, parseHealthResponse } from '@/lib/health/health-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: metrics } = await supabase
      .from('health_metrics')
      .select('type, value, recorded_at')
      .eq('family_id', familyId)
      .order('recorded_at', { ascending: false })
      .limit(200);

    const { data: workouts } = await supabase
      .from('workout_logs')
      .select('activity, duration_minutes, calories, recorded_at')
      .eq('family_id', familyId)
      .order('recorded_at', { ascending: false })
      .limit(100);

    const { count: goalCount } = await supabase
      .from('health_goals')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('is_active', true);

    if ((!metrics || metrics.length === 0) && (!workouts || workouts.length === 0)) {
      return NextResponse.json({ error: 'No health data to analyze' }, { status: 400 });
    }

    const analysis = analyzeHealth(metrics ?? [], workouts ?? [], goalCount ?? 0);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildHealthPrompt(metrics ?? [], workouts ?? []);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseHealthResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Health AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze health data' }, { status: 500 });
  }
}
