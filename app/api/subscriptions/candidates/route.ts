import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { featureAccessByTier, isFeatureTier, resolveFeatureTiers, type FeatureOverrides } from '@/lib/features/tiers';
import { CANDIDATE_SOURCE_LIMIT, detectSubscriptionCandidates, subscriptionCandidateWindow, type SubscriptionCandidateResponse } from '@/lib/finance/subscription-candidates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function GET() {
  try {
    // getUserContext performs reads only; do not auto-provision a family on this GET.
    const ctx = await getUserContext();
    if (!ctx) return json({ code: 'signed_out', error: 'Sign in to review recorded expenses.' }, 401);
    if ('needsFamily' in ctx) return json({ code: 'needs_family', error: 'Select an existing family first.' }, 403);
    if (!isManager(ctx.active.role)) return json({ code: 'role_required', error: 'A parent or adult must review household expenses.' }, 403);
    if (!ctx.active.member?.id || !ctx.active.member.is_active) return json({ code: 'membership_required', error: 'A current active membership is required to review recorded expenses.' }, 403);
    const db = await createServer();
    const familyId = ctx.active.familyId;

    // Same catalog/override and plan rules as requireFeature, with explicit settings failures.
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

    const window = subscriptionCandidateWindow();
    const [expenses, tracked] = await Promise.all([
      db.from('transactions').select('id, family_id, name, amount, type, date, category, account_id, member_id', { count: 'exact' })
        .eq('family_id', familyId).eq('type', 'expense').gte('date', window.from).lte('date', window.to)
        .order('date', { ascending: false }).order('id').limit(CANDIDATE_SOURCE_LIMIT + 1),
      db.from('subscriptions_tracked').select('family_id, name, note', { count: 'exact' })
        .eq('family_id', familyId).order('id').limit(CANDIDATE_SOURCE_LIMIT + 1),
    ]);
    if (expenses.error || tracked.error || !expenses.data || !tracked.data || expenses.count === null || tracked.count === null) {
      return json({ code: 'source_unavailable', error: 'Recorded expenses or tracked subscriptions could not be read. Try again.' }, 503);
    }
    if (tracked.count > CANDIDATE_SOURCE_LIMIT || tracked.data.length < tracked.count) {
      return json({ code: 'comparison_incomplete', error: 'The tracked-subscription comparison exceeds this bounded review. Use the existing list to review duplicates manually.' }, 503);
    }
    if (expenses.data.some((row) => row.family_id !== familyId) || tracked.data.some((row) => row.family_id !== familyId)
      || expenses.data.length < Math.min(expenses.count, CANDIDATE_SOURCE_LIMIT)) {
      return json({ code: 'source_unavailable', error: 'Recorded-expense scope could not be confirmed. Try again.' }, 503);
    }
    const recent = expenses.data.slice(0, CANDIDATE_SOURCE_LIMIT);
    const accountIds = [...new Set(recent.map((row) => row.account_id).filter((id): id is string => !!id))];
    const currencies = new Map<string, string>();
    if (accountIds.length) {
      const accounts = await db.from('financial_accounts').select('id, family_id, currency')
        .eq('family_id', familyId).in('id', accountIds).limit(CANDIDATE_SOURCE_LIMIT);
      if (accounts.error || !accounts.data || accounts.data.some((row) => row.family_id !== familyId)) {
        return json({ code: 'source_unavailable', error: 'Recorded-expense currencies could not be checked. Try again.' }, 503);
      }
      for (const account of accounts.data) currencies.set(account.id, account.currency);
    }
    const records = recent.map((row) => ({
      id: row.id, name: row.name, amount: row.amount, type: row.type, date: row.date, category: row.category,
      accountId: row.account_id, memberId: row.member_id, currency: row.account_id ? currencies.get(row.account_id) ?? null : null,
    }));
    const body: SubscriptionCandidateResponse = {
      familyId, window, recordsRead: records.length, limited: expenses.count > CANDIDATE_SOURCE_LIMIT,
      context: { familyId, userId: ctx.user.id, memberId: ctx.active.member.id, role: ctx.active.role, active: ctx.active.member.is_active },
      unsupportedCurrencyRecords: records.filter((row) => row.currency !== 'USD').length,
      candidates: detectSubscriptionCandidates(records, tracked.data, window),
    };
    return json(body);
  } catch {
    return json({ code: 'review_unavailable', error: 'The recorded-expense review is temporarily unavailable. Try again.' }, 503);
  }
}
