import type { Metadata } from 'next';
import Link from 'next/link';
import { Gift, Users, TrendingUp, DollarSign } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { loadAdminReferralSummary } from '@/lib/referrals/admin-summary';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { getReferralConfigResult } from '@/lib/referrals/server';
import { ReferralSettingsForm } from './settings-form';
import { saveReferralConfigAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Referrals', robots: { index: false } };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t('referrals.referrals')}</h1>
      <ErrorState message={t('referrals.couldNotLoadReferralSettings')} />
      <Link href="/admin/marketing/referrals" className="text-sm font-medium text-brand-text underline">{t('referrals.refreshReferrals')}</Link>
    </div>
  );
}

export default async function AdminReferralsPage() {
  const t = await getTranslations();
  try {
    const supabase = createServiceClient();
    const [configResult, referralsResult] = await Promise.all([
      getReferralConfigResult(supabase),
      loadAdminReferralSummary(supabase),
    ]);
    if (configResult.error || referralsResult.error) {
      console.error('[admin-marketing-referrals] referral read failed', configResult.error ?? referralsResult.error);
      return <ReadFailure />;
    }
    const config = configResult.config;
    const summary = referralsResult.data;
    const rows = summary.recent;
    const { topReferrers } = summary;
    const statusKeys: Record<string, string> = {
      pending: 'referralAdmin.pending', signed_up: 'referralAdmin.signedUp', converted: 'referralAdmin.converted',
      rewarded: 'referralAdmin.rewarded', void: 'referralAdmin.void',
    };

    const stats = [
      { label: t('referralAdmin.total'), value: summary.total.toLocaleString(), icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
      { label: t('referralAdmin.converted'), value: summary.converted.toLocaleString(), icon: TrendingUp, tint: 'text-emerald-400 bg-emerald-500/15' },
      { label: t('referralAdmin.rate'), value: summary.conversionRate === null ? t('adminMarketingReferrals.noReferralsYet') : `${Math.round(summary.conversionRate * 100)}%`, icon: Gift, tint: 'text-blue-400 bg-blue-500/15' },
      { label: t('referralAdmin.unconfirmedCredits'), value: fmtMoney(summary.unconfirmedReferrerCents), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
    ];

    return (
      <div className="space-y-5">
        <p className="text-sm text-muted">{t('adminMarketingReferrals.viralReferralLoopFamiliesInviteFamilies')}</p>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.label} className="flex flex-col gap-3">
              <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
              <div>
                <p className="text-xl font-bold leading-none">{s.value}</p>
                <p className="mt-1 text-xs text-muted">{s.label}</p>
              </div>
            </Card>
          ))}
        </div>

        <div className="space-y-1 text-xs text-muted">
          <p>{t('referralAdmin.method', { date: fmtDate(summary.untilIso) })}</p>
          <p>{t('referralAdmin.creditMethod')}</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <h2 className="mb-4 text-base font-semibold">{t('adminMarketingReferrals.recentReferrals')}</h2>
            {rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr><th className="pb-2">{t('adminMarketingReferrals.code')}</th><th className="pb-2">{t('adminMarketingReferrals.referred')}</th><th className="pb-2">{t('adminMarketingReferrals.status')}</th><th className="pb-2 text-right">{t('adminMarketingReferrals.reward')}</th><th className="pb-2 text-right">{t('adminMarketingReferrals.date')}</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="py-2 font-mono text-xs">{r.code}</td>
                        <td className="py-2">{r.referred_email || '—'}</td>
                        <td className="py-2">{t(statusKeys[r.status] ?? 'referralAdmin.unknown')}</td>
                        <td className="py-2 text-right tabular-nums">{(r.status === 'converted' || r.status === 'rewarded') ? fmtMoney(r.referrer_reward_cents) : '—'}</td>
                        <td className="py-2 text-right text-muted">{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted">{t('adminMarketingReferrals.noReferralsYet')}</p>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <h2 className="mb-4 text-base font-semibold">{t('adminMarketingReferrals.programSettings')}</h2>
              <ReferralSettingsForm config={config} action={saveReferralConfigAction} />
            </Card>

            <Card>
              <h2 className="mb-3 text-base font-semibold">{t('adminMarketingReferrals.topReferrers')}</h2>
              {topReferrers.length ? (
                <ul className="space-y-2 text-sm">
                  {topReferrers.map(([fam, n], i) => (
                    <li key={fam} className="flex items-center gap-2">
                      <span className="w-5 text-muted">{i + 1}.</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{fam}</span>
                      <span className="font-semibold">{n}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t('adminMarketingReferrals.noReferrersYet')}</p>
              )}
            </Card>
          </div>
        </div>
      </div>
    );
  } catch (cause) {
    console.error('[admin-marketing-referrals] referral read threw', cause);
    return <ReadFailure />;
  }
}
