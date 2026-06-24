import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeRelocation, buildRelocationPrompt, parseRelocationResponse } from '@/lib/relocation/relocation-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: relocations } = await supabase
      .from('family_relocations')
      .select('id')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!relocations) {
      return NextResponse.json({ error: 'No active relocation to analyze' }, { status: 400 });
    }

    const { data: tasks } = await supabase
      .from('relocation_tasks')
      .select('title, status, category, due_date')
      .eq('relocation_id', relocations.id)
      .order('sort_order')
      .limit(200);

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ error: 'No relocation tasks to analyze' }, { status: 400 });
    }

    const analysis = analyzeRelocation(tasks);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRelocationPrompt(tasks);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRelocationResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Relocation AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze relocation' }, { status: 500 });
  }
}
