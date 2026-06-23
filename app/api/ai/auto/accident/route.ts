import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';

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
  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'AI is not configured (OpenAI API key missing).' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
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
    const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });
    text = completion.text.trim();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 503 });
  }

  const supabase = await createServer();
  await supabase.from('auto_ai_logs').insert({
    family_id: ctx.active.familyId, user_id: ctx.user.id, vehicle_id: vehicleId, kind: 'accident',
    input: { situation, injuries, hasInsurance }, output: { text }, created_by: ctx.user.id,
  });

  return NextResponse.json({ text });
}
