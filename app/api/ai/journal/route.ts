import { NextResponse } from 'next/server';
import { refuseClosedOrTrialEnded } from '@/lib/server/account-standing';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveProvider } from '@/lib/ai/provider';
import { buildJournalPrompt, parseJournalPrompt, promptOfTheDay } from '@/lib/journal/prompts';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { AI_ASSISTANT_FEATURE_KEY, accessDeniedResponse, assertAIAccess } from '@/lib/server/ai-access';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { describeReadError } from '@/lib/supabase/settle';

// POST /api/ai/journal — returns one personalized reflection prompt for the
// signed-in member, informed by their recent entries. Falls back to the
// evergreen prompt-of-the-day if AI is unavailable, so the UX never dead-ends.
export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const memberId = ctx.active.member?.id ?? null;
    const supabase = await createServer();
    // A closed or trial-ended family is refused before any work: see lib/server/account-standing.ts.
    const closed = await refuseClosedOrTrialEnded(supabase, ctx.active.familyId);
    if (closed) return closed;
    // The page in front of this is feature-gated; this endpoint was not, and it
    // calls a model. Same resolver, so the two cannot disagree.
    const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/journal']);
    if (refused) return refused;
    const limited = await enforceAIRateLimit(supabase, `ai-journal:${ctx.user.id}`, { limit: 20 });
    if (!limited.ok) return NextResponse.json(
      { error: t('journal.tooManyJournalRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    // A model call, so the Free plan's monthly AI allowance applies here as it
    // does at /api/ai: only the routes that asked `assertAIAccess` enforced it,
    // so a Free family past its ten requests kept getting these — while their
    // rows still counted toward the limit the assistant then refused them on.
    const access = await assertAIAccess(ctx, { db: supabase, featureKey: AI_ASSISTANT_FEATURE_KEY });
    if (!access.ok) return accessDeniedResponse(access);

    // These five entries are the only thing that makes the prompt personal. A
    // refused read produced an empty list, which is also what a brand-new
    // journal produces — so the route fell back to a generic prompt and
    // labelled it `source: 'ai'`, indistinguishable from one written for this
    // person. The evergreen fallback already exists for exactly this, and it is
    // honest about what it is. Audit C1-S9-37.
    const { data: recent, error: recentError } = await supabase
      .from('journal_entries')
      .select('mood, body')
      .eq('family_id', ctx.active.familyId)
      .eq('member_id', memberId ?? '')
      .order('entry_date', { ascending: false })
      .limit(5);

    if (recentError) {
      console.error('[ai/journal] recent entry read failed', {
        familyId: ctx.active.familyId, error: describeReadError(recentError),
      });
      return NextResponse.json({ prompt: promptOfTheDay(), source: 'evergreen' });
    }

    const snippets = (recent ?? []).map((r) => ({ mood: r.mood, snippet: (r.body ?? '').slice(0, 160) }));

    try {
      const { system, user } = buildJournalPrompt(snippets);
      // Inside the try that falls through to the evergreen prompt, so a failure
      // is recorded before it is swallowed — the same reason the daily brief
      // wraps inside its own silent catch.
      const prompt = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'journal.prompt', text: 'Journal prompt' },
        async (obs) => {
          const provider = await resolveProvider();
          const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 60 });
          obs.used(completion.model ?? 'unknown', completion.usage);
          const parsed = parseJournalPrompt(completion.text || '');
          if (!parsed) {
            obs.failed(new Error('The model returned no usable journal prompt.'));
          }
          return parsed;
        },
      );
      if (prompt) return NextResponse.json({ prompt, source: 'ai' });
    } catch {
      // fall through to evergreen
    }

    return NextResponse.json({ prompt: promptOfTheDay(), source: 'evergreen' });
  } catch (err) {
    console.error('Journal prompt error:', err);
    return NextResponse.json({ error: t('journal.failedToGenerateAPrompt') }, { status: 500 });
  }
}
