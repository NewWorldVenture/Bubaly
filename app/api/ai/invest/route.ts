import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { portfolioValue, type Holding, type PriceMap } from '@/lib/invest/portfolio';
import { buildInvestCoachPrompt, parseInvestCoach } from '@/lib/invest/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

// POST /api/ai/invest — the kids' EDUCATIONAL Money Mentor. Same tier gating +
// per-day metering as the wallet coach. Explains an investing concept; never
// gives buy/sell advice or promises returns.
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: 'The Money Mentor is available on the Basic and Plus plans.' }, { status: 403 });
    }
    const limited = await enforceAIRateLimit(supabase, `ai-invest:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many Money Mentor requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const dailyLimit = AI_COACH_DAILY_LIMIT[tier];
    if (Number.isFinite(dailyLimit)) {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const { count } = await supabase
        .from('wallet_audit_logs').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('action', 'ai_invest_call').gte('created_at', startOfDay.toISOString());
      if ((count ?? 0) >= dailyLimit) {
        return NextResponse.json({ error: `You've reached today's Money Mentor limit (${dailyLimit}/day). Upgrade to Plus for unlimited.` }, { status: 429 });
      }
    }

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as { childWalletId?: string; assetId?: string };

    // Resolve the child's name + (optional) selected asset + portfolio value.
    let childName = 'your child';
    if (body.childWalletId) {
      const { data: cw } = await supabase.from('child_wallets').select('member_id').eq('id', body.childWalletId).eq('family_id', familyId).maybeSingle();
      if (cw?.member_id) {
        const { data: m } = await supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle();
        if (m?.display_name) childName = m.display_name.split(' ')[0] || m.display_name;
      }
    }

    let assetName: string | null = null, assetDescription: string | null = null, riskLevel: string | null = null;
    if (body.assetId) {
      const { data: a } = await supabase.from('invest_assets').select('name, description, risk_level').eq('id', body.assetId).maybeSingle();
      if (a) { assetName = a.name; assetDescription = a.description; riskLevel = a.risk_level; }
    }

    let portfolioValueCents = 0, holdingsCount = 0;
    if (body.childWalletId) {
      const [{ data: holdings }, { data: assets }] = await Promise.all([
        supabase.from('invest_holdings').select('asset_id, shares, avg_cost_cents').eq('family_id', familyId).eq('child_wallet_id', body.childWalletId),
        supabase.from('invest_assets').select('id, price_cents'),
      ]);
      const prices: PriceMap = Object.fromEntries((assets ?? []).map((a) => [a.id, a.price_cents]));
      const hs: Holding[] = (holdings ?? []).map((h) => ({ assetId: h.asset_id, shares: h.shares, avgCostCents: h.avg_cost_cents }));
      portfolioValueCents = portfolioValue(hs, prices);
      holdingsCount = hs.filter((h) => h.shares > 0).length;
    }

    const { system, user } = buildInvestCoachPrompt({ childName, assetName, assetDescription, riskLevel, portfolioValueCents, holdingsCount });
    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 500 });
    const coaching = parseInvestCoach(completion.text || '');
    if (!coaching.explainer) return NextResponse.json({ error: 'Could not generate an explanation right now.' }, { status: 502 });

    await supabase.from('wallet_audit_logs').insert({
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_invest_call', entity_type: 'ai_invest_mentor', detail: 'Money Mentor explainer',
    });
    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Invest mentor error:', err);
    return NextResponse.json({ error: 'Failed to generate an explanation' }, { status: 500 });
  }
}
