import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeChores, buildChoresPrompt, parseChoresResponse } from '@/lib/chores/chores-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: chores } = await supabase
      .from('chores')
      .select('title, priority, category, due_at, is_active')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .limit(100);

    if (!chores || chores.length === 0) {
      return NextResponse.json({ error: 'No chores to analyze' }, { status: 400 });
    }

    const { data: assignments } = await supabase
      .from('chore_assignments')
      .select('status')
      .eq('family_id', familyId)
      .limit(500);

    const statusCounts: Record<string, number> = {};
    for (const a of assignments ?? []) {
      statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    }

    const choreEntries = chores.map((c) => ({
      title: c.title,
      priority: c.priority,
      status: statusCounts['done'] ? 'active' : 'todo',
      due_at: c.due_at,
      category: c.category,
    }));

    const analysis = analyzeChores(choreEntries);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildChoresPrompt(choreEntries);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseChoresResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Chores AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze chores' }, { status: 500 });
  }
}
