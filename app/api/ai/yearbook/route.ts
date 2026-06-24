import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeYearbook, buildYearbookPrompt, parseYearbookResponse } from '@/lib/yearbook/yearbook-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { count: yearbookCount } = await supabase
      .from('family_yearbooks')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('is_active', true);

    const { data: entries } = await supabase
      .from('yearbook_entries')
      .select('title, category, entry_date, description')
      .eq('family_id', familyId)
      .order('entry_date', { ascending: false })
      .limit(200);

    if ((yearbookCount ?? 0) === 0 && (!entries || entries.length === 0)) {
      return NextResponse.json({ error: 'No yearbook data to analyze' }, { status: 400 });
    }

    const analysis = analyzeYearbook(yearbookCount ?? 0, entries ?? []);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildYearbookPrompt(entries ?? []);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseYearbookResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Yearbook AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze yearbook' }, { status: 500 });
  }
}
