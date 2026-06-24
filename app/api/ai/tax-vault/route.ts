import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeTaxVault, buildTaxVaultPrompt, parseTaxVaultResponse } from '@/lib/tax-vault/tax-vault-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: docs } = await supabase
      .from('tax_documents')
      .select('category, tax_year, name')
      .eq('family_id', familyId)
      .order('tax_year', { ascending: false })
      .limit(200);

    if (!docs || docs.length === 0) {
      return NextResponse.json({ error: 'No tax documents to analyze' }, { status: 400 });
    }

    const analysis = analyzeTaxVault(docs);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildTaxVaultPrompt(docs);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseTaxVaultResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Tax vault AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze tax documents' }, { status: 500 });
  }
}
