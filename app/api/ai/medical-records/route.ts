import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeMedicalRecords, buildMedicalRecordsPrompt, parseMedicalRecordsResponse } from '@/lib/medical-records/medical-records-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: profiles } = await supabase
      .from('medical_profiles')
      .select('blood_type, allergies, conditions')
      .eq('family_id', familyId)
      .limit(200);

    if (!profiles || profiles.length === 0) {
      return NextResponse.json({ error: 'No medical profiles to analyze' }, { status: 400 });
    }

    const analysis = analyzeMedicalRecords(profiles);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildMedicalRecordsPrompt(profiles);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseMedicalRecordsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Medical records AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze medical records' }, { status: 500 });
  }
}
