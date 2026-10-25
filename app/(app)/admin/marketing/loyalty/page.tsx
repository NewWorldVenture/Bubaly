import type { Metadata } from 'next';
import Link from 'next/link';
import { Gift, Trophy, Coins, Settings2, Users, Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllAsQuery, readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { computeTier, TIER_LABELS, DEFAULT_LOYALTY, type Tier } from '@/lib/marketing/loyalty';
import { RewardRow, AddReward, type Reward } from './reward-editor';
import { RedemptionRow, type Redemption } from './redemption-row';
import { saveLoyaltySettingsAction, awardPointsAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Loyalty', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const TIER_TONE: Record<Tier, 'neutral' | 'brand' | 'warning'> = { bronze: 'neutral', silver: 'brand', gold: 'warning' };
/** Rows a summed read may page through before it is reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;
/** The award form's family picker offers at most this many families, and says so when there are more. */
const FAMILY_OPTION_CEILING = 25_000;

export default async function LoyaltyPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();

  // The lists below are the top 100 members and the newest 100 redemptions;
  // the tiles above them are the whole program. Members and Pending
  // redemptions are exact counts, and Points outstanding pages every account
  // on the id: counted from the lists, they stopped at 100 apiece, and every
  // balance below the hundredth was left out of what the program owes.
  const [
    settingsResult, rewardsResult, accountsResult, redemptionsResult, familiesResult,
    memberCountResult, pendingCountResult, activeRewardCountResult, rewardCountResult, redemptionCountResult, balancesResult,
  ] = await settleAll([
    supabase.from('loyalty_settings').select('*').eq('singleton', true).maybeSingle(),
    supabase.from('loyalty_rewards').select('*').is('deleted_at', null).order('sort', { ascending: true }).limit(200),
    supabase.from('loyalty_accounts').select('*').order('lifetime_points', { ascending: false }).limit(100),
    supabase.from('loyalty_redemptions').select('*').order('created_at', { ascending: false }).limit(100),
    // The award form's family picker. The rows above are labelled from their
    // own families, read below, not from this list. It was `.limit(1000)` with
    // no order: past a thousand families it offered an arbitrary thousand and
    // said nothing. It offers the first FAMILY_OPTION_CEILING by id now, and
    // says so when there are more (an options list, read with failOnMax: false).
    readAllAsQuery((from, to) =>
      supabase.from('families').select('id, name').order('id').range(from, to), { max: FAMILY_OPTION_CEILING, failOnMax: false }),
    supabase.from('loyalty_accounts').select('id', { count: 'exact', head: true }),
    supabase.from('loyalty_redemptions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    // Active rewards counted the catalog's list, the first 200 (coverage sweep
    // round 9, class B); it is a head:true count now, as are every reward, so
    // the catalog can say when it lists part of them.
    supabase.from('loyalty_rewards').select('id', { count: 'exact', head: true }).is('deleted_at', null).eq('is_active', true),
    supabase.from('loyalty_rewards').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('loyalty_redemptions').select('id', { count: 'exact', head: true }),
    // Summed while families earn and spend, so paged on the id: an offset read
    // counts a balance twice when an account is opened between two pages.
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('loyalty_accounts').select('id, points_balance');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]);
  // Points outstanding past its ceiling costs that one tile. Before the tiles
  // were whole-program figures this page always rendered, and the rewards,
  // the redemption queue, the award form and the program settings are work an
  // operator still has to do; the tile says it is not shown instead of showing
  // part of the balance. Any other failure is still the read-error state.
  const balancesCeiling = 'truncated' in balancesResult && balancesResult.truncated;
  const readError = settingsResult.error ?? rewardsResult.error ?? accountsResult.error ?? redemptionsResult.error ?? familiesResult.error
    ?? memberCountResult.error ?? pendingCountResult.error ?? activeRewardCountResult.error ?? rewardCountResult.error ?? redemptionCountResult.error
    ?? (balancesCeiling ? null : balancesResult.error);
  if (balancesCeiling) console.warn('[admin-marketing-loyalty] the balance read reached its ceiling; Points outstanding is not shown');
  if (readError) {
    console.error('[admin-marketing-loyalty] loyalty read failed', readError);
    return <AdminLoyaltyReadError />;
  }
  const { data: settings } = settingsResult;
  const { data: rewards } = rewardsResult;
  const { data: accounts } = accountsResult;
  const { data: redemptions } = redemptionsResult;
  const { data: families } = familiesResult;

  const set = settings ?? null;
  const rewardRows = (rewards ?? []) as Reward[];
  const accountRows = accounts ?? [];
  const redemptionRows = redemptions ?? [];

  // Name each listed row from ITS family. A thousand families from an
  // unordered read named whichever thousand came back, and every member or
  // redemption from a family past them read "Unknown family".
  const listedFamilyIds = [...new Set([...accountRows.map((a) => a.family_id), ...redemptionRows.map((r) => r.family_id)])];
  const labelsResult = await readInChunks(listedFamilyIds, (chunk) => supabase.from('families').select('id, name').in('id', chunk));
  if (labelsResult.error) {
    console.error('[admin-marketing-loyalty] loyalty read failed', labelsResult.error);
    return <AdminLoyaltyReadError />;
  }
  const nameById = new Map(labelsResult.data.map((f) => [f.id, f.name]));

  const totalOutstanding = (balancesResult.data ?? []).reduce((sum, a) => sum + a.points_balance, 0);
  const memberCount = memberCountResult.count ?? 0;
  const pendingCount = pendingCountResult.count ?? 0;
  const thresholds = { silverAt: set?.tier_silver_at ?? DEFAULT_LOYALTY.tier_silver_at, goldAt: set?.tier_gold_at ?? DEFAULT_LOYALTY.tier_gold_at };

  const redemptionView: Redemption[] = redemptionRows.map((r) => ({
    id: r.id, reward_name: r.reward_name, cost_points: r.cost_points, status: r.status,
    code: r.code, notes: r.notes, created_at: r.created_at,
    family_label: nameById.get(r.family_id) ?? 'Unknown family',
  }));

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={balancesCeiling ? [t('adminMarketingLoyalty.pointsOutstanding')] : []}
      />
      <PartialReadBanner
        title={t('adminCeiling.offeredInPart', { n: FAMILY_OPTION_CEILING.toLocaleString() })}
        failures={'truncated' in familiesResult && familiesResult.truncated ? [t('adminMarketingLoyalty.awardFamilyPicker')] : []}
      />
      <div className="flex items-center gap-2">
        <Trophy className="h-5 w-5 text-brand-text" />
        <div>
          <h2 className="text-base font-bold">{t('adminMarketingLoyalty.loyaltyAmpRewards')}</h2>
          <p className="text-xs text-muted">{t('adminMarketingLoyalty.rewardFamiliesWithPointsForSigning')}</p>
        </div>
        <Badge tone={set?.enabled ? 'success' : 'neutral'} className="ml-auto">{set?.enabled ? 'Live' : 'Off'}</Badge>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><p className="text-xs font-medium text-muted">{t('adminMarketingLoyalty.members')}</p><p className="mt-1 text-3xl font-bold leading-none">{memberCount}</p></Card>
        <Card><p className="text-xs font-medium text-muted">{t('adminMarketingLoyalty.pointsOutstanding')}</p><p className="mt-1 text-3xl font-bold leading-none">{balancesCeiling ? t('strategyMetrics.unavailable') : totalOutstanding.toLocaleString()}</p></Card>
        <Card><p className="text-xs font-medium text-muted">{t('adminMarketingLoyalty.activeRewards')}</p><p className="mt-1 text-3xl font-bold leading-none">{activeRewardCountResult.count ?? 0}</p></Card>
        <Card><p className="text-xs font-medium text-muted">{t('adminMarketingLoyalty.pendingRedemptions')}</p><p className="mt-1 text-3xl font-bold leading-none">{pendingCount}</p></Card>
      </div>

      {/* Rewards catalog */}
      <Card>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Gift className="h-4 w-4 text-brand-text" /> {t('adminMarketingLoyalty.rewardsCatalog')}</h3>
        {(rewardCountResult.count ?? 0) > rewardRows.length && (
          <p className="mb-3 text-xs text-muted">{t('adminCeiling.listShowsPart', { shown: rewardRows.length.toLocaleString(), total: (rewardCountResult.count ?? 0).toLocaleString() })}</p>
        )}
        {rewardRows.length === 0 ? (
          <EmptyState icon={Gift} title={t('adminMarketingLoyalty.noRewardsYet')} description={t('loyalty.addYourFirstRewardSo')} />
        ) : (
          <div className="space-y-2">{rewardRows.map((r) => <RewardRow key={r.id} reward={r} />)}</div>
        )}
        <div className="mt-3"><AddReward /></div>
      </Card>

      {/* Redemptions queue */}
      <Card>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {t('adminMarketingLoyalty.redemptions')} {pendingCount > 0 && <Badge tone="warning">{pendingCount} pending</Badge>}</h3>
        {(redemptionCountResult.count ?? 0) > redemptionView.length && (
          <p className="mb-3 text-xs text-muted">{t('adminCeiling.listShowsTheNewest', { shown: redemptionView.length.toLocaleString(), total: (redemptionCountResult.count ?? 0).toLocaleString() })}</p>
        )}
        {redemptionView.length === 0 ? (
          <EmptyState icon={Sparkles} title={t('adminMarketingLoyalty.noRedemptionsYet')} description={t('loyalty.redemptionsFromFamiliesWillAppear')} />
        ) : (
          <div className="space-y-2">{redemptionView.map((r) => <RedemptionRow key={r.id} redemption={r} />)}</div>
        )}
      </Card>

      {/* Members + manual award */}
      <Card>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-brand-text" /> {t('adminMarketingLoyalty.members')}</h3>
        {memberCount > accountRows.length && (
          <p className="mb-3 text-xs text-muted">{t('adminCeiling.listShowsPart', { shown: accountRows.length.toLocaleString(), total: memberCount.toLocaleString() })}</p>
        )}
        {accountRows.length === 0 ? (
          <EmptyState icon={Users} title={t('adminMarketingLoyalty.noMembersYet')} description={t('loyalty.accountsAreCreatedAutomaticallyWhen')} />
        ) : (
          <div className="space-y-1">
            {accountRows.map((a) => {
              const tier = computeTier(a.lifetime_points, thresholds);
              return (
                <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{nameById.get(a.family_id) ?? 'Unknown family'}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={TIER_TONE[tier]}>{TIER_LABELS[tier]}</Badge>
                    <span className="tabular-nums text-muted">{a.points_balance.toLocaleString()} pts</span>
                    <span className="tabular-nums text-[11px] text-muted">({a.lifetime_points.toLocaleString()} lifetime)</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <form action={awardPointsAction} className="mt-4 grid gap-2 border-t border-border/50 pt-3 sm:grid-cols-4">
          <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.family')}</span>
            <select name="family_id" required className={inputCls} defaultValue="">
              <option value="" disabled>{t('adminMarketingLoyalty.selectAFamily')}</option>
              {(families ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.points')}</span><input type="number" name="points" required className={inputCls} placeholder={t('adminMarketingLoyalty.eG250')} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.reason')}</span><input name="reason" className={inputCls} placeholder="optional" /></label>
          <div className="sm:col-span-4"><button className="inline-flex h-10 items-center gap-1 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Coins className="h-4 w-4" /> {t('adminMarketingLoyalty.awardAdjustPoints')}</button></div>
        </form>
      </Card>

      {/* Program settings */}
      <Card>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4 text-brand-text" /> {t('adminMarketingLoyalty.programSettings')}</h3>
        <form action={saveLoyaltySettingsAction} className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={set?.enabled ?? false} className="h-4 w-4 rounded border-border" /> {t('adminMarketingLoyalty.programEnabledVisibleToFamilies')}</label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.programName')}</span><input name="program_name" defaultValue={set?.program_name ?? DEFAULT_LOYALTY.program_name} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.pointsLabel')}</span><input name="points_label" defaultValue={set?.points_label ?? DEFAULT_LOYALTY.points_label} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.earnOnSignup')}</span><input type="number" min="0" name="earn_signup" defaultValue={set?.earn_signup ?? DEFAULT_LOYALTY.earn_signup} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.earnPerReferral')}</span><input type="number" min="0" name="earn_referral" defaultValue={set?.earn_referral ?? DEFAULT_LOYALTY.earn_referral} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.earnPerReview')}</span><input type="number" min="0" name="earn_review" defaultValue={set?.earn_review ?? DEFAULT_LOYALTY.earn_review} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.earnPer1Spent')}</span><input type="number" inputMode="decimal" min="0" step="0.01" name="earn_per_dollar" defaultValue={set?.earn_per_dollar ?? DEFAULT_LOYALTY.earn_per_dollar} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.silverTierAtLifetimePts')}</span><input type="number" min="0" name="tier_silver_at" defaultValue={set?.tier_silver_at ?? DEFAULT_LOYALTY.tier_silver_at} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyalty.goldTierAtLifetimePts')}</span><input type="number" min="0" name="tier_gold_at" defaultValue={set?.tier_gold_at ?? DEFAULT_LOYALTY.tier_gold_at} className={inputCls} /></label>
          <div className="sm:col-span-2"><SubmitButton className="inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg">{t('adminMarketingLoyalty.saveSettings')}</SubmitButton></div>
        </form>
      </Card>
    </div>
  );
}

async function AdminLoyaltyReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Loyalty &amp; Rewards</h1>
        <p className="mt-1 text-sm text-muted">{t('loyalty.managePointsRewardsRedemptionsAnd')}</p>
      </div>
      <ErrorState message={t('loyalty.couldNotLoadLoyaltyData')} />
      <Link href="/admin/marketing/loyalty" className="text-sm font-medium text-brand-text underline">{t('loyalty.refreshLoyalty')}</Link>
    </div>
  );
}
