import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeReminders, buildRemindersPrompt, parseRemindersResponse } from '@/lib/reminders/reminders-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: reminders } = await supabase
      .from('family_reminders')
      .select('title, kind, priority, status, remind_at, recurrence')
      .eq('family_id', familyId)
      .order('remind_at', { ascending: true })
      .limit(200);

    if (!reminders || reminders.length === 0) {
      return NextResponse.json({ error: 'No reminders to analyze' }, { status: 400 });
    }

    const analysis = analyzeReminders(reminders);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildRemindersPrompt(reminders);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseRemindersResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Reminders AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze reminders' }, { status: 500 });
  }
}
