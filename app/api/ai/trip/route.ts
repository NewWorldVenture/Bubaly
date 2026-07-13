import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
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
  try {
    const ctx = await requireUserContext(); // auth gate (family-scoped session)
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-trip:${ctx.user.id}`, { limit: 15 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many trip-research requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as Partial<TripResearchInput>;
    const destination = (body.destination ?? '').toString().trim();
    if (!destination) {
      return NextResponse.json({ error: 'A destination is required.' }, { status: 400 });
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
        const provider = await resolveProvider();
        const completion = await provider.complete({
          system,
          messages: [{ role: 'user', content: user }],
          tools: [],
          maxTokens: 1400,
        });
        const parsed = parseTripResearch(completion.text || '');
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
    return NextResponse.json({ error: 'Could not research this trip.' }, { status: 500 });
  }
}
