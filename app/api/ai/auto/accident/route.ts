import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI accident & claim assistant. Given the situation, returns a calm, ordered
 * checklist: immediate safety, what to document, who to call, and how to start an
 * insurance claim. Safety-first (always defers to 911 for injuries). Uses only
 * what the user provides; never invents policy numbers or fault determinations.
 */
export async function POST(req: Request) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-auto-accident:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many accident-assistant requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'AI is not configured (OpenAI API key missing).' }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const situation = String(body.situation ?? '').slice(0, 1500).trim();
  const injuries = Boolean(body.injuries);
  const vehicleId = typeof body.vehicleId === 'string' ? body.vehicleId : null;
  const vehicleDesc = String(body.vehicleDesc ?? '').slice(0, 120);
  const hasInsurance = Boolean(body.hasInsurance);
  if (!situation) return NextResponse.json({ error: 'Briefly describe what happened.' }, { status: 400 });

  const system =
    'You are a calm assistant helping a driver right after a car accident or roadside emergency. ' +
    'Safety comes first: if there are injuries or danger, the FIRST step is always to call 911. ' +
    'Give a short, numbered, do-this-now checklist in plain text with these sections:\n' +
    'RIGHT NOW: 2–4 immediate safety steps.\n' +
    'DOCUMENT: exactly what to photograph and what info to exchange (other driver, plates, witnesses).\n' +
    'CALLS TO MAKE: who to contact (911 if needed, police for a report, insurance claims line, roadside).\n' +
    'START YOUR CLAIM: 2–3 steps to begin the insurance claim.\n' +
    'Be reassuring and concise. Never assign fault or invent details.';

  const userMsg =
    `Situation: ${situation}\nInjuries reported: ${injuries ? 'yes' : 'no/unknown'}\n` +
    `Vehicle: ${vehicleDesc || 'unspecified'}\nHas auto insurance on file: ${hasInsurance ? 'yes' : 'unknown'}`;

  let text: string;
  try {
    // Someone has just had a car accident. A 503 here is the one failure on
    // this list a family is most likely to write in about, and until now it
    // left nothing behind.
    text = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'auto.accident', text: 'Accident next steps' },
      async (obs) => {
        const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text.trim();
      },
    );
  } catch (err) {
    console.error('Accident assistant error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }

  await supabase.from('auto_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, vehicle_id: vehicleId, kind: 'accident',
    input: { situation, injuries, hasInsurance }, output: { text }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text });
}
