import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { planLevel } from '@/lib/constants/plans';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { buildCapturePrompt, routeCaptureHeuristic, resolveAiKey } from '@/lib/capture/routing';

// Routes a free-form Capture note to the best destination. Tier-aware (never
// routes to a locked feature). Falls back to the deterministic heuristic when AI
// is unavailable or returns nothing usable, so Capture always resolves.
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const { text } = (await req.json()) as { text?: string };
    const note = (text ?? '').trim();
    if (!note) return NextResponse.json({ error: 'Text is required' }, { status: 400 });

    const supabase = await createServer();
    const { data: sub } = await supabase
      .from('subscriptions').select('plan, status')
      .eq('family_id', ctx.active.familyId).in('status', ['active', 'trialing']).maybeSingle();
    const level = planLevel(sub?.plan ?? null);

    const heuristic = routeCaptureHeuristic(note, level);

    if (!(await isAIConfigured())) {
      return NextResponse.json({ ...heuristic, via: 'heuristic' });
    }

    try {
      const { system, user } = buildCapturePrompt(note, level);
      const provider = await resolveProvider();
      const completion = await provider.complete({
        system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 16,
      });
      const ai = resolveAiKey(completion.text, level, note);
      if (ai) return NextResponse.json({ ...ai, via: 'ai' });
    } catch (e) {
      console.error('Capture AI routing failed, using heuristic:', e);
    }

    return NextResponse.json({ ...heuristic, via: 'heuristic' });
  } catch (err) {
    console.error('Capture route error:', err);
    return NextResponse.json({ error: 'Failed to route' }, { status: 500 });
  }
}
