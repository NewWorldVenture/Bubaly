import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { planLevel } from '@/lib/constants/plans';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import {
  buildCaptureExtractionPrompt, parseCaptureExtraction, routeCaptureHeuristic,
  availableDestinations, canFile, isFileableDestination,
} from '@/lib/capture/routing';

// Routes a free-form Capture note to the best destination AND extracts a title +
// datetime so time-based items (Calendar / Reminders) can be filed directly.
// Tier-aware (never routes to a locked feature). Falls back to the deterministic
// heuristic when AI is unavailable or returns nothing usable.
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
    const heuristicResponse = {
      ...heuristic, title: null as string | null, whenISO: null as string | null,
      canFile: isFileableDestination(heuristic.key), via: 'heuristic' as const,
    };

    if (!(await isAIConfigured())) return NextResponse.json(heuristicResponse);

    try {
      const { system, user } = buildCaptureExtractionPrompt(note, level, new Date().toISOString());
      const provider = await resolveProvider();
      const completion = await provider.complete({
        system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 160,
      });
      const ex = parseCaptureExtraction(completion.text || '', level);
      if (ex) {
        const dest = availableDestinations(level).find((d) => d.key === ex.key)!;
        const url = dest.key === 'assistant' ? `${dest.url}?q=${encodeURIComponent(note)}` : dest.url;
        return NextResponse.json({
          key: dest.key, destination: dest.label, url,
          title: ex.title, whenISO: ex.whenISO,
          canFile: canFile(dest.key, ex.whenISO), via: 'ai',
        });
      }
    } catch (e) {
      console.error('Capture AI routing failed, using heuristic:', e);
    }

    return NextResponse.json(heuristicResponse);
  } catch (err) {
    console.error('Capture route error:', err);
    return NextResponse.json({ error: 'Failed to route' }, { status: 500 });
  }
}
