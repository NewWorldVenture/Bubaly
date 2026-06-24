import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeMedications, buildMedicationsPrompt, parseMedicationsResponse } from '@/lib/medications/medications-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: meds } = await supabase
      .from('medications')
      .select('name, dosage, is_active')
      .eq('family_id', familyId)
      .limit(100);

    if (!meds || meds.length === 0) {
      return NextResponse.json({ error: 'No medications to analyze' }, { status: 400 });
    }

    const { count: scheduleCount } = await supabase
      .from('medication_schedules')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId);

    const { data: logs } = await supabase
      .from('medication_doses')
      .select('status')
      .eq('family_id', familyId)
      .limit(500);

    const doseSummary = { taken: 0, skipped: 0, missed: 0 };
    for (const log of logs ?? []) {
      if (log.status === 'taken') doseSummary.taken++;
      else if (log.status === 'skipped') doseSummary.skipped++;
      else if (log.status === 'missed') doseSummary.missed++;
    }

    const analysis = analyzeMedications(meds, scheduleCount ?? 0, doseSummary);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildMedicationsPrompt(meds, scheduleCount ?? 0, doseSummary);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseMedicationsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Medications AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze medications' }, { status: 500 });
  }
}
