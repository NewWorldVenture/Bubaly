import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { summarizeMember, type BehaviorLogLike } from '@/lib/behavior/insights';

export const runtime = 'nodejs';

/**
 * AI parenting insight for a child's recent behavior log. Reads the last ~60
 * days of behavior_logs (family-scoped via the cookie client + RLS), summarises
 * them, and asks the configured AI provider for a short, supportive insight plus
 * 3 concrete, age-appropriate tips. Degrades gracefully if AI is unconfigured.
 */
export async function POST(req: NextRequest) {
  await requireUserContext();
  const supabase = await createServer();

  let body: { memberId?: string } = {};
  try { body = await req.json(); } catch { /* optional */ }

  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  let q = supabase
    .from('behavior_logs')
    .select('member_id, kind, category, note, points, occurred_at')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(200);
  if (body.memberId) q = q.eq('member_id', body.memberId);
  const { data: logs } = await q;

  if (!logs || logs.length === 0) {
    return NextResponse.json({ insight: 'No behavior has been logged yet. Start logging positive moments and concerns to unlock AI parenting insights.', tips: [] });
  }

  const summary = summarizeMember(logs as BehaviorLogLike[]);
  const recent = (logs as Array<BehaviorLogLike & { note: string | null }>)
    .slice(0, 40)
    .map((l) => `${l.occurred_at.slice(0, 10)} · ${l.kind} · ${l.category}${l.note ? ` — ${l.note}` : ''}`)
    .join('\n');

  try {
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system: 'You are a warm, evidence-informed parenting coach. Be specific, supportive and non-judgmental. Reply ONLY as compact JSON: {"insight": string (2-3 sentences), "tips": string[] (exactly 3 short, concrete, encouraging tips)}. Never diagnose; if data shows concerns, frame them constructively.',
      messages: [{
        role: 'user',
        content: `Behavior summary: ${summary.positive} positive, ${summary.concern} concern, ${summary.neutral} neutral (balance score ${summary.balanceScore}/100). Top categories: ${summary.topCategories.map((c) => `${c.category} (${c.count})`).join(', ') || 'none'}.\n\nRecent log:\n${recent}`,
      }],
      tools: [],
      maxTokens: 500,
    });
    const match = completion.text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const insight = typeof parsed.insight === 'string' ? parsed.insight : 'Keep logging — patterns will sharpen over time.';
    const tips = Array.isArray(parsed.tips) ? parsed.tips.slice(0, 3).map(String) : [];
    return NextResponse.json({ insight, tips });
  } catch {
    // AI unconfigured or failed — return an honest, useful fallback from the data.
    const lead = summary.balanceScore >= 70
      ? 'Mostly positive lately — nice momentum.'
      : 'A few more concerns than positives recently; worth a gentle check-in.';
    return NextResponse.json({
      insight: `${lead} ${summary.positive} positive vs ${summary.concern} concern observations across ${summary.topCategories.map((c) => c.category).join(', ') || 'several areas'}.`,
      tips: ['Catch and name one positive behavior today.', 'Pick the single most frequent concern to focus on this week.', 'Review this together at a calm moment, not in the heat of it.'],
    });
  }
}
