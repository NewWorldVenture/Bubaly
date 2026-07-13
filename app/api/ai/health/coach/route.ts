import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, describeAIError } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

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
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'The AI engine isn’t configured. Set an API key in Admin → AI Engine.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const question = String(body.question ?? '').slice(0, 2000).trim();
  const memberId = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
  if (!question) return NextResponse.json({ error: 'Ask a question first.' }, { status: 400 });

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-health-coach:${ctx.user.id}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many health-coach requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const familyId = ctx.active.familyId;

  // Ground the answer in this family's own health data.
  const [{ data: member }, { data: profile }, { data: meds }, { data: symptoms }] = await Promise.all([
    memberId ? supabase.from('family_members').select('display_name, birthday').eq('id', memberId).maybeSingle() : Promise.resolve({ data: null }),
    memberId ? supabase.from('medical_profiles').select('blood_type, allergies, conditions, current_medications').eq('member_id', memberId).maybeSingle() : Promise.resolve({ data: null }),
    memberId
      ? supabase.from('medications').select('name, dosage, instructions').eq('family_id', familyId).eq('member_id', memberId).eq('is_active', true).limit(20)
      : supabase.from('medications').select('name, dosage').eq('family_id', familyId).eq('is_active', true).limit(20),
    memberId
      ? supabase.from('symptom_logs').select('symptom, severity, started_at, status, notes').eq('member_id', memberId).order('started_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: null }),
  ]);

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
    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [], maxTokens: 1024 });
    const text = completion.text.trim() || 'I couldn’t generate guidance just now. Please try again.';
    return NextResponse.json({ text });
  } catch (err) {
    console.error('AI health coach error:', err);
    const { message, detail } = describeAIError(err);
    return NextResponse.json({ error: message, detail }, { status: 503 });
  }
}
