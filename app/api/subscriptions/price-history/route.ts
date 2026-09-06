import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { featureAccessByTier, isFeatureTier, resolveFeatureTiers, type FeatureOverrides } from '@/lib/features/tiers';
import { subscriptionCandidateWindow } from '@/lib/finance/subscription-candidates';
import {
  PRICE_HISTORY_SOURCE_LIMIT, priceHistorySourceCoverage, reviewSubscriptionPriceHistory,
  type SubscriptionPriceHistoryResponse,
} from '@/lib/finance/subscription-price-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function GET(request: Request) {
  try {
    const ctx = await getUserContext();
    if (!ctx) return json({ code: 'signed_out', error: 'Sign in to review recorded charges.' }, 401);
    if ('needsFamily' in ctx) return json({ code: 'needs_family', error: 'Select an existing family first.' }, 403);
    if (!isManager(ctx.active.role)) return json({ code: 'role_required', error: 'A parent or adult must review recorded charges.' }, 403);
    if (!ctx.active.member?.id || ctx.active.member.is_active !== true) return json({ code: 'membership_required', error: 'A current active membership is required.' }, 403);
    const ids = new URL(request.url).searchParams.getAll('subscriptionId');
    if (ids.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ids[0])) {
      return json({ code: 'invalid_subscription', error: 'Choose an existing tracked subscription.' }, 400);
    }
    const db = await createServer();
    const familyId = ctx.active.familyId;
    // Reuse the candidate review's authenticated feature/plan gates and cookie-bound RLS client.
    const { data: setting, error: settingError } = await db.from('app_settings').select('value').eq('key', 'feature_tiers').maybeSingle();
    if (settingError) return json({ code: 'access_unavailable', error: 'Feature access could not be checked. Try again.' }, 503);
    const overrides: FeatureOverrides = {};
    if (setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)) {
      for (const [key, value] of Object.entries(setting.value)) if (typeof value === 'string' && isFeatureTier(value)) overrides[key] = value;
    }
    const tiers = resolveFeatureTiers(overrides);
    const superAdmin = await isSuperAdmin();
    const level = superAdmin ? 2 : await resolveFamilyPlanLevel(db, familyId);
    for (const key of ['subscription-tracking', 'finances']) {
      const access = featureAccessByTier(tiers[key], level, superAdmin);
      if (access === 'hidden') return json({ code: 'feature_off', error: 'Not found.' }, 404);
      if (access === 'locked') return json({ code: 'plan_required', error: 'Your family plan does not include this review.' }, 403);
    }

    const tracked = await db.from('subscriptions_tracked').select('id, family_id, name, cost_cents, cadence, note')
      .eq('family_id', familyId).eq('id', ids[0]).maybeSingle();
    if (tracked.error) return json({ code: 'source_unavailable', error: 'The tracked subscription could not be read. Try again.' }, 503);
    if (!tracked.data) return json({ code: 'not_found', error: 'This tracked subscription is not available in the current family.' }, 404);
    if (tracked.data.family_id !== familyId || tracked.data.id !== ids[0]) return json({ code: 'source_unavailable', error: 'The tracked-subscription scope could not be confirmed.' }, 503);

    const window = subscriptionCandidateWindow();
    const expenses = await db.from('transactions').select('id, family_id, name, amount, type, date, category, account_id, member_id', { count: 'exact' })
      .eq('family_id', familyId).eq('type', 'expense').gte('date', window.from).lte('date', window.to)
      .order('date', { ascending: false }).order('id').limit(PRICE_HISTORY_SOURCE_LIMIT + 1);
    if (expenses.error || !Array.isArray(expenses.data)
      || priceHistorySourceCoverage(expenses.count, expenses.data.length).state === 'unavailable'
      || expenses.data.some((row) => row.family_id !== familyId)) {
      return json({ code: 'source_unavailable', error: 'Recorded-charge coverage could not be established. Try again; no complete history is claimed.' }, 503);
    }
    const recent = expenses.data.slice(0, PRICE_HISTORY_SOURCE_LIMIT);
    const accountIds = [...new Set(recent.map((row) => row.account_id).filter((id): id is string => !!id))];
    const currencies = new Map<string, string>();
    if (accountIds.length) {
      const accounts = await db.from('financial_accounts').select('id, family_id, currency')
        .eq('family_id', familyId).in('id', accountIds).limit(PRICE_HISTORY_SOURCE_LIMIT);
      if (accounts.error || !Array.isArray(accounts.data)
        || accounts.data.some((row) => row.family_id !== familyId || !accountIds.includes(row.id))
        || new Set(accounts.data.map((row) => row.id)).size !== accounts.data.length) {
        return json({ code: 'source_unavailable', error: 'Recorded-charge currencies could not be checked. Try again.' }, 503);
      }
      for (const account of accounts.data) currencies.set(account.id, account.currency);
    }
    const records = recent.map((row) => ({
      id: row.id, name: row.name, amount: row.amount, type: row.type, date: row.date, category: row.category,
      accountId: row.account_id, memberId: row.member_id, currency: row.account_id ? currencies.get(row.account_id) ?? null : null,
    }));
    const body: SubscriptionPriceHistoryResponse = {
      familyId,
      context: { familyId, userId: ctx.user.id, memberId: ctx.active.member.id, role: ctx.active.role, active: ctx.active.member.is_active },
      history: reviewSubscriptionPriceHistory(records, {
        id: tracked.data.id, name: tracked.data.name, costCents: tracked.data.cost_cents, cadence: tracked.data.cadence, note: tracked.data.note,
      }, window, expenses.count, expenses.data.length),
    };
    return json(body);
  } catch {
    return json({ code: 'review_unavailable', error: 'Recorded-charge history is temporarily unavailable. Try again.' }, 503);
  }
}
