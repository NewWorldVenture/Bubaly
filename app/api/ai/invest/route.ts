import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { portfolioValue, type Holding, type PriceMap } from '@/lib/invest/portfolio';
import { buildInvestCoachPrompt, parseInvestCoach } from '@/lib/invest/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { logWalletAudit } from '@/lib/server/audit';

// POST /api/ai/invest — the kids' EDUCATIONAL Money Mentor. Same tier gating +
// per-day metering as the wallet coach. Explains an investing concept; never
// gives buy/sell advice or promises returns.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: t('invest.theMoneyMentorIsAvailable') }, { status: 403 });
    }
    const limited = await enforceAIRateLimit(supabase, `ai-invest:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('invest.tooManyMoneyMentorRequests') },
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
    if (!boundedBody.ok) return NextResponse.json({ error: t('invest.requestBodyIsTooLarge') }, { status: 400 });
    const body = (boundedBody.value ?? {}) as { childWalletId?: string; assetId?: string };

    // Resolve the child's name + (optional) selected asset + portfolio value.
    // The two name lookups degrade honestly: "your child" instead of a first
    // name is a blander answer, not a wrong one, so a failed read is logged and
    // the fallback stands.
    let childName = 'your child';
    if (body.childWalletId) {
      const { data: cw, error: cwError } = await supabase.from('child_wallets').select('member_id').eq('id', body.childWalletId).eq('family_id', familyId).maybeSingle();
      if (cwError) console.warn('[ai/invest] child wallet read failed; using a generic name', { familyId, error: cwError.message });
      if (cw?.member_id) {
        const { data: m, error: mError } = await supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle();
        if (mError) console.warn('[ai/invest] member read failed; using a generic name', { familyId, error: mError.message });
        if (m?.display_name) childName = m.display_name.split(' ')[0] || m.display_name;
      }
    }

    // The ASSET does not degrade honestly, and that is the difference. The
    // caller named a specific asset; a refused read left name, description and
    // risk level all null, and the model went on to give investing guidance to
    // a CHILD about an asset it had been told nothing about — including its
    // risk level, which is the one fact this feature exists to teach. A blander
    // name is a smaller answer; an unknown asset is a different question.
    // Audit C1-S9-40.
    let assetName: string | null = null, assetDescription: string | null = null, riskLevel: string | null = null;
    if (body.assetId) {
      const { data: a, error: assetError } = await supabase.from('invest_assets').select('name, description, risk_level').eq('id', body.assetId).maybeSingle();
      if (assetError) {
        console.error('[ai/invest] asset read failed', { assetId: body.assetId, error: assetError.message });
        return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
      }
      if (a) { assetName = a.name; assetDescription = a.description; riskLevel = a.risk_level; }
    }

    let portfolioValueCents = 0, holdingsCount = 0;
    if (body.childWalletId) {
      const [{ data: holdings }, { data: assets }] = await settleAll([
        supabase.from('invest_holdings').select('asset_id, shares, avg_cost_cents').eq('family_id', familyId).eq('child_wallet_id', body.childWalletId),
        supabase.from('invest_assets').select('id, price_cents'),
      ]);
      const prices: PriceMap = Object.fromEntries((assets ?? []).map((a) => [a.id, a.price_cents]));
      const hs: Holding[] = (holdings ?? []).map((h) => ({ assetId: h.asset_id, shares: h.shares, avgCostCents: h.avg_cost_cents }));
      portfolioValueCents = portfolioValue(hs, prices);
      holdingsCount = hs.filter((h) => h.shares > 0).length;
    }

    const { system, user } = buildInvestCoachPrompt({ childName, assetName, assetDescription, riskLevel, portfolioValueCents, holdingsCount });
    const coaching = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'invest.mentor', text: 'Explain an investing concept' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 500 });
        obs.used(provider.model, completion.usage);
        const parsed = parseInvestCoach(completion.text || '');
        if (!parsed.explainer) obs.failed(new Error('The mentor reply had no explainer.'));
        return parsed;
      },
    );
    if (!coaching.explainer) return NextResponse.json({ error: t('invest.couldNotGenerateAnExplanation') }, { status: 502 });

    await logWalletAudit(supabase, {
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_invest_call', entity_type: 'ai_invest_mentor', detail: 'Money Mentor explainer',
    }, 'AI invest mentor call');
    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Invest mentor error:', err);
    return NextResponse.json({ error: t('invest.failedToGenerateAnExplanation') }, { status: 500 });
  }
}
