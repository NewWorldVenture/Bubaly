import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeFamilyTree, buildFamilyTreePrompt, parseFamilyTreeResponse } from '@/lib/family-tree/family-tree-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: nodes } = await supabase
      .from('family_tree_nodes')
      .select('name, relationship, birth_year, death_year, birth_place')
      .eq('family_id', familyId)
      .limit(200);

    if (!nodes || nodes.length === 0) {
      return NextResponse.json({ error: 'No family tree nodes to analyze' }, { status: 400 });
    }

    const analysis = analyzeFamilyTree(nodes);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildFamilyTreePrompt(nodes);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseFamilyTreeResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Family tree AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze family tree' }, { status: 500 });
  }
}
