import type { Metadata } from 'next';
import Link from 'next/link';
import { Gift, Users, TrendingUp, DollarSign } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { getReferralConfigResult } from '@/lib/referrals/server';
import { ReferralSettingsForm } from './settings-form';
import { saveReferralConfigAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'referrals.referrals', robots: { index: false } };
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
  const supabase = createServiceClient();
  const [configResult, referralsResult] = await Promise.all([
    getReferralConfigResult(supabase),
    settle(supabase
      .from('referrals')
      .select('id, code, referrer_family_id, referred_email, status, referrer_reward_cents, created_at')
      .order('created_at', { ascending: false })
      .limit(100)),
  ]);
  if (configResult.error || referralsResult.error) {
    console.error('[admin-marketing-referrals] referral read failed', configResult.error ?? referralsResult.error);
    return <ReadFailure />;
  }
  const config = configResult.config;
  const { data: referrals } = referralsResult;
  const rows = referrals ?? [];

  const converted = rows.filter((r) => r.status === 'converted' || r.status === 'rewarded');
  const creditsCents = converted.reduce((s, r) => s + (r.referrer_reward_cents ?? 0), 0);
  const convRate = rows.length ? Math.round((converted.length / rows.length) * 100) : 0;

  // Top referrers by referral count.
  const byFamily = new Map<string, number>();
  for (const r of rows) byFamily.set(r.referrer_family_id, (byFamily.get(r.referrer_family_id) ?? 0) + 1);
  const topReferrers = [...byFamily.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const stats = [
    { label: 'Total Referrals', value: rows.length.toLocaleString(), icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Converted', value: converted.length.toLocaleString(), icon: TrendingUp, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Conversion Rate', value: `${convRate}%`, icon: Gift, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Credits Owed', value: fmtMoney(creditsCents), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
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
                  {rows.slice(0, 25).map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-2 font-mono text-xs">{r.code}</td>
                      <td className="py-2">{r.referred_email || '—'}</td>
                      <td className="py-2 capitalize">{r.status.replace('_', ' ')}</td>
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
}
