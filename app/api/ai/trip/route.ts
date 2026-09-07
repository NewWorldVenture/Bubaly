import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import {
  buildTripResearchPrompt, parseTripResearch, fallbackTripResearch, type TripResearchInput,
} from '@/lib/trips/research';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

// POST /api/ai/trip — AI Family Travel Concierge. Given a destination, who's
// going, the family's interests and a weather summary, returns structured
// restaurant/activity/tip recommendations. Falls back to deterministic,
// never-fabricated guidance when AI is unconfigured or returns junk.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext(); // auth gate (family-scoped session)
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-trip:${ctx.user.id}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: t('trip.tooManyTripResearchRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as Partial<TripResearchInput>;
    const destination = (body.destination ?? '').toString().trim();
    if (!destination) {
      return NextResponse.json({ error: t('trip.aDestinationIsRequired') }, { status: 400 });
    }

    const input: TripResearchInput = {
      destination,
      interests: body.interests ?? null,
      members: Array.isArray(body.members) ? body.members.map(String).slice(0, 12) : [],
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      weatherSummary: body.weatherSummary ?? null,
    };

    let recommendations = fallbackTripResearch(input);
    let source: 'ai' | 'fallback' = 'fallback';

    if (await isAIConfigured()) {
      try {
        const { system, user } = buildTripResearchPrompt(input);
        // Inside the swallow, so both ways this ends at `source: 'fallback'` —
        // the provider threw, or the research would not parse — are told apart
        // on the row. From the traveller's side they are one thing, and both
        // look like "no API key configured" too.
        const parsed = await withAiRequest(
          scopeFromUserContext(ctx, supabase),
          { feature: 'travel.research', text: `Research a trip to ${input.destination}` },
          async (obs) => {
            const provider = await resolveProvider();
            const completion = await provider.complete({
              system,
              messages: [{ role: 'user', content: user }],
              tools: [],
              maxTokens: 1400,
            });
            obs.used(completion.model ?? 'unknown', completion.usage);
            const out = parseTripResearch(completion.text || '');
            if (!out) obs.failed(new Error('The trip research did not parse; fell back to the deterministic plan.'));
            return out;
          },
        );
        if (parsed) {
          recommendations = parsed;
          source = 'ai';
        }
      } catch {
        // keep deterministic fallback
      }
    }

    return NextResponse.json({ recommendations, source });
  } catch (err) {
    console.error('Trip research error:', err);
    return NextResponse.json({ error: t('trip.couldNotResearchThisTrip') }, { status: 500 });
  }
}
