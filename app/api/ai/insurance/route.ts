import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeInsurance, buildInsurancePrompt, parseInsuranceResponse } from '@/lib/insurance/insurance-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: policies } = await supabase
      .from('family_insurance_policies')
      .select('policy_type, insurer, premium_amount, premium_frequency, coverage_amount, deductible, renewal_date')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .limit(100);

    if (!policies || policies.length === 0) {
      return NextResponse.json({ error: 'No insurance policies to analyze' }, { status: 400 });
    }

    const analysis = analyzeInsurance(policies);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildInsurancePrompt(policies);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseInsuranceResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Insurance AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze insurance' }, { status: 500 });
  }
}
