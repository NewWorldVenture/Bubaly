import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeTodos, buildTodosPrompt, parseTodosResponse } from '@/lib/todos/todos-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: todos } = await supabase
      .from('todo_items')
      .select('title, is_done, priority, due_date')
      .eq('family_id', familyId)
      .limit(200);

    if (!todos || todos.length === 0) {
      return NextResponse.json({ error: 'No todos to analyze' }, { status: 400 });
    }

    const analysis = analyzeTodos(todos);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildTodosPrompt(todos);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseTodosResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Todos AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze todos' }, { status: 500 });
  }
}
