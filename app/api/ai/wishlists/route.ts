import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeWishlists, buildWishlistsPrompt, parseWishlistsResponse } from '@/lib/wishlists/wishlists-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: items } = await supabase
      .from('wishlist_items')
      .select('title, price, priority, claimed_by, is_purchased')
      .eq('family_id', familyId)
      .limit(200);

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No wish list items to analyze' }, { status: 400 });
    }

    const analysis = analyzeWishlists(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildWishlistsPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseWishlistsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Wishlists AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze wish lists' }, { status: 500 });
  }
}
