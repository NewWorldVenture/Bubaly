import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { createServer } from '@/lib/supabase/server';
import { analyzeWallet, buildWalletPrompt, parseWalletResponse } from '@/lib/wallet/wallet-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const { memberId, memberName } = await req.json();
    if (!memberId) return NextResponse.json({ error: 'memberId required' }, { status: 400 });

    const supabase = await createServer();
    const [bucketsRes, rulesRes, txnsRes] = await Promise.all([
      supabase.from('wallet_buckets').select('*').eq('family_id', familyId).eq('member_id', memberId),
      supabase.from('wallet_rules').select('*').eq('family_id', familyId).eq('member_id', memberId),
      supabase.from('wallet_transactions').select('*').eq('family_id', familyId).eq('member_id', memberId).order('created_at', { ascending: false }).limit(100),
    ]);

    const buckets = bucketsRes.data ?? [];
    const rules = rulesRes.data ?? [];
    const txns = txnsRes.data ?? [];

    if (buckets.length === 0) {
      return NextResponse.json({ error: 'No wallet data yet' }, { status: 400 });
    }

    const analysis = analyzeWallet(buckets, txns, memberId);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildWalletPrompt(analysis, rules, memberName || 'This member');
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseWalletResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Wallet AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze wallet' }, { status: 500 });
  }
}
