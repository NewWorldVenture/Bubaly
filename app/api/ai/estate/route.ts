import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeEstate, buildEstatePrompt, parseEstateResponse } from '@/lib/estate/estate-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: docs } = await supabase
      .from('estate_documents')
      .select('document_type, title, review_status, effective_date, expiration_date, next_review')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .limit(200);

    if (!docs || docs.length === 0) {
      return NextResponse.json({ error: 'No estate documents to analyze' }, { status: 400 });
    }

    const analysis = analyzeEstate(docs);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildEstatePrompt(docs);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseEstateResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Estate AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze estate documents' }, { status: 500 });
  }
}
