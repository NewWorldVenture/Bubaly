import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getSocialAccess } from '@/lib/social/access';
import { generate, AI_GENERATION_KINDS, type AiGenerationKind } from '@/lib/social/ai';
import { isPlatform } from '@/lib/social/capabilities';
import { describeAIError } from '@/lib/ai/provider';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await requireUserContext();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const familyId = ctx.active.familyId;

  const access = await getSocialAccess(familyId);
  if (!access || !access.can('generate_ai')) {
    return NextResponse.json({ error: 'You do not have permission to generate AI content.' }, { status: 403 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const kind = String(body.kind ?? '') as AiGenerationKind;
  if (!AI_GENERATION_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'Unknown generation kind' }, { status: 400 });
  }
  const platform = isPlatform(body.platform) ? body.platform : null;
  const topic = String(body.topic ?? '').slice(0, 2000);
  const tone = body.tone ? String(body.tone).slice(0, 60) : undefined;
  const source = body.source ? String(body.source).slice(0, 8000) : undefined;

  let result;
  try {
    result = await generate({ kind, topic, platform, tone, source });
  } catch (err) {
    console.error('Social AI generation error:', err);
    const message = describeAIError(err).message;
    // Persist the failed attempt for auditability.
    const supabase = await createServer();
    await supabase.from('social_ai_generations').insert({
      family_id: familyId, user_id: ctx.user.id, kind, platform, prompt: topic,
      input: { tone: tone ?? null, hasSource: Boolean(source) }, status: 'failed',
      output: { error: message }, created_by: ctx.user.id,
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }

  const supabase = await createServer();
  await supabase.from('social_ai_generations').insert({
    family_id: familyId,
    user_id: ctx.user.id,
    kind,
    platform,
    prompt: topic,
    input: { tone: tone ?? null, hasSource: Boolean(source) },
    output: { text: result.text },
    model: result.model,
    status: 'succeeded',
    created_by: ctx.user.id,
  });
  await supabase.from('social_usage_events').insert({
    family_id: familyId, user_id: ctx.user.id, kind: 'ai_generation', quantity: 1,
  });

  return NextResponse.json({ text: result.text, model: result.model, kind });
}
