import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveProvider, describeAIError } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { settleAll } from '@/lib/supabase/settle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI Health Coach. Answers a family's wellness question grounded ONLY in the
 * data they've stored (medical profile, active meds, recent symptoms/metrics for
 * the chosen member). Safety-first: it is explicitly NOT medical advice, never
 * diagnoses definitively, and routes anything urgent to a clinician / emergency
 * services. Nothing is invented beyond the provided context.
 */
export async function POST(req: Request) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('coach.unauthorized') }, { status: 401 }); }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: t('coach.theAiEngineIsnT') }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('coach.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const question = String(body.question ?? '').slice(0, 2000).trim();
  const memberId = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
  if (!question) return NextResponse.json({ error: t('coach.askAQuestionFirst') }, { status: 400 });

  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not, and it
  // calls a model. Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/health']);
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-health-coach:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('coach.tooManyHealthCoachRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const familyId = ctx.active.familyId;

  // Ground the answer in this family's own health data.
  //
  // `memberId` arrives in the request body. Every read below therefore filters
  // on family_id as well: RLS admits EVERY family the caller belongs to
  // (`is_family_member(family_id)`), not the one this request is about, so a
  // parent in two households could name a member of the other one and be
  // answered about them. The medications read already scoped itself, which is
  // what made the gap dangerous rather than merely wrong — three of the four
  // reads crossed and the fourth did not, so the coach described that person's
  // blood type, allergies, conditions and last ten symptoms while reporting
  // "Active medications: none on file". A confident wrong answer about
  // medication is worse on a health surface than a refusal.
  const [
    { data: member, error: memberError },
    { data: profile, error: profileError },
    { data: meds, error: medsError },
    { data: symptoms, error: symptomsError },
  ] = await settleAll([
    memberId ? supabase.from('family_members').select('display_name, birthday').eq('id', memberId).eq('family_id', familyId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    memberId ? supabase.from('medical_profiles').select('blood_type, allergies, conditions, current_medications').eq('member_id', memberId).eq('family_id', familyId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    memberId
      ? supabase.from('medications').select('name, dosage, instructions').eq('family_id', familyId).eq('member_id', memberId).eq('is_active', true).limit(20)
      : supabase.from('medications').select('name, dosage').eq('family_id', familyId).eq('is_active', true).limit(20),
    memberId
      ? supabase.from('symptom_logs').select('symptom, severity, started_at, status, notes').eq('member_id', memberId).eq('family_id', familyId).order('started_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: null, error: null }),
  ]);

  // settleAll rather than Promise.all: a transport rejection would otherwise
  // reject the batch and the grounding check below would never run at all.
  //
  // A refused read is not an empty medical record. Coaching over one silently
  // drops the allergy, the condition or the medication the answer needed to
  // account for, and nothing on the page says the grounding was incomplete.
  const groundingError = memberError ?? profileError ?? medsError ?? symptomsError;
  if (groundingError) {
    console.error('[health-coach] grounding read failed; refusing to answer', { familyId, memberId }, groundingError);
    return NextResponse.json({ error: t('coach.healthDataUnavailable') }, { status: 503 });
  }

  const personLine = member?.display_name ? `Person: ${member.display_name}${member.birthday ? ` (DOB ${member.birthday})` : ''}` : 'Person: (not specified)';
  const profileLines = profile ? [
    profile.blood_type ? `Blood type: ${profile.blood_type}` : '',
    profile.allergies ? `Allergies: ${profile.allergies}` : '',
    profile.conditions ? `Conditions: ${profile.conditions}` : '',
    profile.current_medications ? `Noted medications: ${profile.current_medications}` : '',
  ].filter(Boolean).join('\n') : '';
  const medLines = (meds ?? []).length ? `Active medications: ${(meds ?? []).map((m) => `${m.name}${'dosage' in m && m.dosage ? ` (${m.dosage})` : ''}`).join(', ')}` : 'Active medications: none on file';
  const symptomLines = (symptoms ?? []).length
    ? `Recent symptoms:\n${(symptoms ?? []).map((s) => `- ${s.symptom} (severity ${s.severity}/5, ${s.status}, since ${String(s.started_at).slice(0, 10)})${s.notes ? ` — ${s.notes}` : ''}`).join('\n')}`
    : 'Recent symptoms: none logged';

  const context = [personLine, profileLines, medLines, symptomLines].filter(Boolean).join('\n');

  const system =
    'You are a calm, knowledgeable family health & wellness assistant. You are NOT a doctor and you do NOT diagnose. ' +
    'Use ONLY the household data provided; never invent history, labs, or medications. ' +
    'Always be safety-first. If the question describes red-flag/emergency symptoms (e.g. chest pain, trouble breathing, ' +
    'stroke signs, severe bleeding, suicidal thoughts, anaphylaxis, a baby with a high fever), tell them to call emergency ' +
    'services / seek urgent care immediately and keep the rest brief. Consider any allergies and current medications in your ' +
    'suggestions (flag possible interactions to ask a pharmacist about — do not assert them as fact). ' +
    'Respond in short plain-text sections:\n' +
    'WHAT THIS COULD BE: 2–4 gentle, non-definitive possibilities.\n' +
    'SELF-CARE: 2–4 safe, practical steps to try at home.\n' +
    'SEE A CLINICIAN IF: 2–3 clear escalation signs.\n' +
    'Then one short reassurance line. End with: "This is general wellness information, not medical advice."';

  const userMsg = `Household health context:\n${context}\n\nQuestion: ${question}`;

  try {
    const text = (await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'health.coach', text: 'Health coaching' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [], maxTokens: 1024 });
        obs.used(completion.model ?? 'unknown', completion.usage);
        return completion.text;
      },
    )).trim() || 'I couldn’t generate guidance just now. Please try again.';
    return NextResponse.json({ text });
  } catch (err) {
    console.error('AI health coach error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }
}
