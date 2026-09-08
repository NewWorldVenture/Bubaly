import type { Metadata } from 'next';
import { Gift } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getOrCreateReferralCode, listReferralsForFamily, getReferralConfig } from '@/lib/referrals/server';
import { summarizeReferrals, referralLink } from '@/lib/referrals/core';
import { fmtMoney } from '@/lib/utils/format';
import { ReferralPanel } from '@/components/referrals/referral-panel';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Refer a Family', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function ReferralsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  const service = createServiceClient();
  const [code, config] = await Promise.all([
    getOrCreateReferralCode(familyId, { familyName: ctx.active.family.name, userId: ctx.user.id }),
    getReferralConfig(service),
  ]);

  const supabase = await createServer();
  const referrals = await listReferralsForFamily(supabase, familyId);
  const summary = summarizeReferrals(referrals);

  // Did this family itself get referred?
  const { data: wasReferred } = await supabase
    .from('referrals')
    .select('id')
    .eq('referred_family_id', familyId)
    .maybeSingle();

  const rows = referrals.map((r) => ({
    id: r.id,
    email: r.referred_email,
    status: r.status,
    rewardCents: r.referrer_reward_cents,
    createdAt: r.created_at,
  }));

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand/15 text-brand-text"><Gift className="h-6 w-6" /></div>
        <div>
          <h1 className="text-xl font-bold">{t('referrals.referAFamily')}</h1>
          <p className="text-sm text-muted">
            {t('referrals.give')} {config.rewardLabel}{t('referrals.get')} {config.rewardLabel} {t('referrals.whenAFamilyYouInviteUpgrades')}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Invited', labelKey: 'referrals.tileInvited', value: summary.total },
          { label: 'Signed up', labelKey: 'referrals.tileSignedUp', value: summary.signedUp },
          { label: 'Upgraded', labelKey: 'referrals.tileUpgraded', value: summary.converted },
          { label: 'Earned', labelKey: 'referrals.tileEarned', value: fmtMoney(summary.earnedCents) },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <p className="text-2xl font-bold leading-none">{s.value}</p>
            <p className="mt-1 text-xs text-muted">{t(s.labelKey)}</p>
          </div>
        ))}
      </div>

      <ReferralPanel
        code={code}
        link={referralLink(code)}
        rewardLabel={config.rewardLabel}
        enabled={config.enabled}
        alreadyReferred={Boolean(wasReferred)}
        rows={rows}
      />
    </div>
  );
}
