import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeDocuments, buildDocumentsPrompt, parseDocumentsResponse } from '@/lib/documents/documents-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: docs } = await supabase
      .from('documents')
      .select('title, category, expires_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!docs || docs.length === 0) {
      return NextResponse.json({ error: 'No documents to analyze' }, { status: 400 });
    }

    const analysis = analyzeDocuments(docs);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildDocumentsPrompt(docs);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseDocumentsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Documents AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze documents' }, { status: 500 });
  }
}
