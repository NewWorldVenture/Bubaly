import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeDonations, buildDonationsPrompt, parseDonationsResponse } from '@/lib/donations/donations-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: donations } = await supabase
      .from('family_donations')
      .select('organization, donation_type, amount, category, donation_date, is_tax_deductible')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('donation_date', { ascending: false })
      .limit(200);

    if (!donations || donations.length === 0) {
      return NextResponse.json({ error: 'No donations to analyze' }, { status: 400 });
    }

    const analysis = analyzeDonations(donations);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildDonationsPrompt(donations);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseDonationsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Donations AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze donations' }, { status: 500 });
  }
}
