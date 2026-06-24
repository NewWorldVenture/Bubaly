import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeImmunizations, buildImmunizationsPrompt, parseImmunizationsResponse } from '@/lib/health/immunizations-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: records } = await supabase
      .from('immunizations')
      .select('vaccine, dose_label, date_given, next_due_date')
      .eq('family_id', familyId)
      .limit(200);

    if (!records || records.length === 0) {
      return NextResponse.json({ error: 'No immunization records to analyze' }, { status: 400 });
    }

    const analysis = analyzeImmunizations(records);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildImmunizationsPrompt(records);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseImmunizationsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Immunizations AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze immunizations' }, { status: 500 });
  }
}
