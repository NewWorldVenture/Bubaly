import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzePets, buildPetsPrompt, parsePetsResponse } from '@/lib/pets/pets-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: pets } = await supabase
      .from('pets')
      .select('name, species, breed, birthday')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .limit(50);

    if (!pets || pets.length === 0) {
      return NextResponse.json({ error: 'No pets to analyze' }, { status: 400 });
    }

    const analysis = analyzePets(pets);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildPetsPrompt(pets);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parsePetsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Pets AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze pets' }, { status: 500 });
  }
}
