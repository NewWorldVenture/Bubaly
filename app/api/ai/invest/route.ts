import { NextRequest, NextResponse } from 'next/server';
import { refuseOverAIAllowance } from '@/lib/server/ai-access';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { isWithheldFromGuest } from '@/lib/auth/guest-scope';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext, dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { portfolioValue, type Holding, type PriceMap } from '@/lib/invest/portfolio';
import { buildInvestCoachPrompt, parseInvestCoach } from '@/lib/invest/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { logWalletAudit } from '@/lib/server/audit';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { readsEveryWallet } from '@/lib/wallet/own-wallets';

/** The `feature` the mentor's request row is filed under (withAiRequest below): what the daily cap counts. */
const AI_REQUEST_FEATURE = 'invest.mentor';

// POST /api/ai/invest — the kids' EDUCATIONAL Money Mentor. Same tier gating +
// per-day metering as the wallet coach. Explains an investing concept; never
// gives buy/sell advice or promises returns.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    // Every /wallet page sends a guest away (lib/auth/guest-scope.ts, the held
    // 0509); the mentor reads a child's portfolio value, on the family's metered
    // coach quota, so it answers to the same rule.
    if (ctx.active.role === 'guest' && isWithheldFromGuest('/wallet')) {
      return NextResponse.json({ error: t('householdMoney.keptByParents') }, { status: 403 });
    }
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: t('invest.theMoneyMentorIsAvailable') }, { status: 403 });
    }
    // With no key the provider threw "not configured" and the catch below
    // answered a generic 500; the other AI routes say so with a 503 first.
    if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    const limited = await enforceAIRateLimit(supabase, `ai-invest:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('invest.tooManyMoneyMentorRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const dailyLimit = AI_COACH_DAILY_LIMIT[tier];
    if (Number.isFinite(dailyLimit)) {
      // The family's midnight, not the host's. This bound is the daily AI
      // quota window: on a UTC host `setHours(0,0,0,0)` rolls over at 17:00 in
      // California and 11:00 in Sydney, so a household's allowance reset in the
      // middle of their afternoon and calls made after it were counted against
      // tomorrow. Same defect and same fix as the kitchen display
      // (app/(app)/display/page.tsx:122).
      const startOfDay = new Date(zonedDayBoundsMs(dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC'), ctx.active.family.timezone || 'UTC').start);
      // Counted from the server's own record of each explainer: the
      // `ai_requests` row withAiRequest files below, of kind 'feature' and
      // settled 'completed' when an explainer came back. The meter counted
      // `wallet_audit_logs` rows with action 'ai_invest_call' from ANY actor,
      // which any member may write as themselves with any created_at
      // (wallet_audit_logs_insert, 0380), so five planted rows refused the
      // family the mentor for the day (household-roles
      // N6-R1-WALLET-METERS-FORGEABLE). A member may file only a 'concierge'
      // request, 'queued' (0255), and may not update one. The service client,
      // because a non-manager's own client sees only their own requests (the held 0493).
      const { count, error: meterError } = await createServiceClient()
        .from('ai_requests').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('kind', 'feature').eq('feature', AI_REQUEST_FEATURE).eq('status', 'completed')
        .gte('created_at', startOfDay.toISOString());
      // An unreadable meter is not "none used": that answer lifted the daily
      // limit, and every call behind it is a paid model call.
      if (meterError || count === null) {
        console.error('[ai-invest] usage meter read failed', meterError);
        return NextResponse.json({ error: t('invest.failedToGenerateAnExplanation') }, { status: 503 });
      }
      if (count >= dailyLimit) {
        return NextResponse.json({ error: t('invest.mentorDailyLimitReached', { limit: dailyLimit }) }, { status: 429 });
      }
    }

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: t('invest.requestBodyIsTooLarge') }, { status: 400 });
    const body = (boundedBody.value ?? {}) as { childWalletId?: string; assetId?: string };

    // Resolve the child's name + (optional) selected asset + portfolio value.
    // The two name lookups degrade honestly: "your child" instead of a first
    // name is a blander answer, not a wrong one, so a failed read is logged and
    // the fallback stands.
    // The held 0515: a sibling's wallet and holdings answer anyone but a parent
    // or adult as not there, which is what the database will answer them.
    if (body.childWalletId && !readsEveryWallet(ctx.active.role)) {
      const { data: own, error: ownError } = await supabase.from('child_wallets').select('id')
        .eq('id', body.childWalletId).eq('family_id', familyId).eq('member_id', ctx.active.member.id).maybeSingle();
      if (ownError) {
        console.error('[ai/invest] own wallet read failed', { familyId, error: ownError.message });
        return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
      }
      if (!own) return NextResponse.json({ error: t('child.childWalletNotFound') }, { status: 404 });
    }
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
      const [{ data: holdings, error: holdingsError }, { data: assets, error: assetsError }] = await settleAll([
        // Paged: this total is the portfolio value the model is told about.
        readAllAsQuery<{ asset_id: string; shares: number; avg_cost_cents: number }>(
          (from, to) => supabase.from('invest_holdings').select('asset_id, shares, avg_cost_cents')
            .eq('family_id', familyId).eq('child_wallet_id', body.childWalletId!).order('asset_id').order('id').range(from, to),
        ),
        supabase.from('invest_assets').select('id, price_cents'),
      ]);
      // The model is told this portfolio's value. A holdings read that failed,
      // or stopped at readAll's ceiling, would tell it a smaller number than the
      // child holds, and an unreadable price list would value every holding at
      // zero. Either is a wrong figure stated with confidence, so stop instead.
      if (holdingsError || assetsError) {
        console.error('[ai-invest] portfolio read failed', holdingsError ?? assetsError);
        return NextResponse.json({ error: t('invest.failedToGenerateAnExplanation') }, { status: 503 });
      }
      const prices: PriceMap = Object.fromEntries((assets ?? []).map((a) => [a.id, a.price_cents]));
      const hs: Holding[] = (holdings ?? []).map((h) => ({ assetId: h.asset_id, shares: h.shares, avgCostCents: h.avg_cost_cents }));
      portfolioValueCents = portfolioValue(hs, prices);
      holdingsCount = hs.filter((h) => h.shares > 0).length;
    }

    const { system, user } = buildInvestCoachPrompt({ childName, assetName, assetDescription, riskLevel, portfolioValueCents, holdingsCount });
    // F19: the monthly AI allowance the plans sell, checked before the model runs.
    const overAllowance = await refuseOverAIAllowance(ctx, supabase);
    if (overAllowance) return overAllowance;
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

    // The wallet trail's record of the call, best-effort. It is not the meter: the request row above is.
    await logWalletAudit(supabase, {
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_invest_call', entity_type: 'ai_invest_mentor', detail: 'Money Mentor explainer',
    }, 'AI invest mentor call');
    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Invest mentor error:', err);
    return NextResponse.json({ error: t('invest.failedToGenerateAnExplanation') }, { status: 500 });
  }
}
