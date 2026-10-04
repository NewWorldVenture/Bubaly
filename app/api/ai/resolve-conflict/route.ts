import { NextResponse } from 'next/server';
import { refuseOverAIAllowance, admissionRefusalResponse } from '@/lib/server/ai-access';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EventLite = { title?: string; starts_at?: string; ends_at?: string | null; location?: string | null };

// In the FAMILY's zone: this text is what the model reasons about and what the
// family reads back, and rendered on the host's clock a 6pm practice in
// California was described as a 1am one.
function fmt(e: EventLite, tz: string): string {
  const start = e.starts_at ? new Date(e.starts_at) : null;
  const end = e.ends_at ? new Date(e.ends_at) : null;
  const when = start
    ? start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
    : 'unknown time';
  const until = end ? `–${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}` : '';
  const where = e.location ? ` at ${e.location}` : '';
  return `“${e.title ?? 'Untitled'}” (${when}${until})${where}`;
}

/**
 * Generate 3 concrete, family-friendly ways to resolve a scheduling clash between
 * two events. Advisory text only — applying a fix is an explicit, separate action
 * (the deterministic reschedule on the page). Never invents details it wasn't given.
 */
export async function POST(req: Request) {
  const t = await getTranslations();
  let ctx;
  try {
    ctx = await requireUserContext();
  } catch {
    return NextResponse.json({ error: t('resolveConflict.unauthorized') }, { status: 401 });
  }
  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not, and it
  // calls a model. Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/conflicts']);
  const tz = ctx.active.family.timezone || 'UTC';
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-resolve-conflict:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: t('resolveConflict.tooManyConflictResolutionRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: t('resolveConflict.aiIsNotConfiguredOpenai') }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('resolveConflict.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const a = (body.a ?? {}) as EventLite;
  const b = (body.b ?? {}) as EventLite;
  if (!a.title || !b.title) {
    return NextResponse.json({ error: t('resolveConflict.bothEventsAreRequired') }, { status: 400 });
  }
  const provider = await resolveProvider();
  const system =
    'You are a calm, practical family scheduling assistant. Two events overlap. ' +
    'Give exactly 3 short, concrete resolution options a busy parent could act on in seconds. ' +
    'Each option ≤ 18 words, starts with a verb (Move, Shorten, Split, Ask, Swap, Drop, Combine). ' +
    'Only use the facts provided — never invent names, places, or times. Return one option per line, no numbering.';

  try {
    // F19: the monthly AI allowance the plans sell, checked before the model runs.
    const overAllowance = await refuseOverAIAllowance(ctx, supabase);
    if (overAllowance) return overAllowance;
    const ideas = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'calendar.resolve-conflict', text: 'Resolve a calendar clash' },
      async (obs) => {
        const completion = await provider.complete({
          system,
          messages: [{ role: 'user', content: `Event A: ${fmt(a, tz)}\nEvent B: ${fmt(b, tz)}\n\nHow can we resolve this clash?` }],
          tools: [],
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = completion.text
          .split('\n')
          .map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim())
          .filter(Boolean)
          .slice(0, 3);
        // A distinct shape of silence: this route answers 200 with `ideas: []`
        // when nothing parses, so the parent sees "no suggestions" — which is
        // exactly what a working model with nothing to say would produce. The
        // response is unchanged; the row is the only place the difference lives.
        if (parsed.length === 0) obs.failed(new Error('The model returned no usable options.'));
        return parsed;
      },
    );
    return NextResponse.json({ ideas });
  } catch (err) {
    const refused = admissionRefusalResponse(err, t);
    if (refused) return refused;
    console.error('Conflict-resolution assistant error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }
}
