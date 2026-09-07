import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { summarizeMember, type BehaviorLogLike } from '@/lib/behavior/insights';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

/** Shown whenever the coach's reply cannot be used. Named so both paths return the same words. */
const CANNED_INSIGHT = 'Keep logging — patterns will sharpen over time.';

/**
 * AI parenting insight for a child's recent behavior log. Reads the last ~60
 * days of behavior_logs (family-scoped via the cookie client + RLS), summarises
 * them, and asks the configured AI provider for a short, supportive insight plus
 * 3 concrete, age-appropriate tips. Degrades gracefully if AI is unconfigured.
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-behavior-insight:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: t('insight.tooManyBehaviorInsightRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('insight.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as { memberId?: string };

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
    // The sharpest silence on this list. Three ways a parent gets something that
    // reads like a real answer:
    //   - the model replies with no JSON at all, and `insight` becomes the canned
    //     "Keep logging — patterns will sharpen over time.";
    //   - JSON.parse throws on malformed braces, caught below;
    //   - the provider throws, also caught below.
    // The first is the worst, because it answers 200 with a warm sentence that
    // is indistinguishable from coaching. Nothing recorded any of the three.
    const result = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'behavior.insight', text: 'Parenting insight from behaviour logs' },
      async (obs) => {
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
        obs.used(provider.model, completion.usage);
        const match = completion.text.match(/\{[\s\S]*\}/);
        // The parse is caught HERE rather than left to the wrapper. V8 puts a
        // snippet of the input into its message —
        //   Unexpected token 'A', "Ava had 3 "... is not valid JSON
        // — and the input is the coach's reply about a child's behaviour logs.
        // Letting that reach the wrapper would copy it into `ai_requests.error`
        // and onto /admin/ai-activity, which shows the error column. Before this
        // route was observed the same throw landed in a bare `catch {}` and was
        // discarded, so wrapping it without this would have made privacy worse
        // in the name of visibility.
        let parsed: Record<string, unknown> = {};
        if (match) {
          try {
            parsed = JSON.parse(match[0]) as Record<string, unknown>;
          } catch {
            // RETHROWN, not returned. The route's outer catch builds a fallback
            // from the family's own numbers plus three concrete tips, and that
            // is a materially better answer than the canned line. Sanitising the
            // exception must not cost the parent that — the first version of
            // this fix returned CANNED_INSIGHT with no tips and quietly
            // downgraded the malformed-JSON case while closing the leak.
            //
            // The replacement carries no model text, so `withAiRequest` records
            // this message and nothing from the reply.
            throw new Error('The coach reply was not valid JSON.');
          }
        }
        const insight = typeof parsed.insight === 'string' ? parsed.insight : null;
        if (insight === null) {
          obs.failed(new Error('The coach replied without a usable insight; the canned line was shown instead.'));
        }
        const tips = Array.isArray(parsed.tips) ? parsed.tips.slice(0, 3).map(String) : [];
        return { insight: insight ?? CANNED_INSIGHT, tips };
      },
    );
    return NextResponse.json(result);
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
