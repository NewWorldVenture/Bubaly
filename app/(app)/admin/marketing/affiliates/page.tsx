import type { Metadata } from 'next';
import Link from 'next/link';
import { Handshake, DollarSign, BadgeCheck, Wallet } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { formatCents } from '@/lib/marketing/crm';
import { summarizeReferrals, payoutByAffiliate, type ReferralLike } from '@/lib/marketing/affiliates';
import type { Tables } from '@/lib/database.types';
import { saveAffiliateAction, toggleAffiliateStatusAction, deleteAffiliateAction, markAffiliatePaidAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { SubmitButton } from '@/components/ui/submit-button';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('affiliates.affiliates'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

/** Referrals the commission figures may page through before they are reported as not shown. */
const SUM_ROW_CEILING = 10000;
/** The newest partners the list holds. */
const LISTED = 200;

type Affiliate = Tables<'affiliates'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

export default async function AffiliatesPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // The Affiliates tile counted the list, which is the newest 200, so past
  // them it read 200 (coverage sweep round 9, class B); it is a head:true count
  // now, and the list says when it holds part of the partners.
  const [affiliatesResult, referralsResult, affiliateCountResult] = await settleAll([
    supabase.from('affiliates').select('*').order('created_at', { ascending: false }).limit(LISTED),
    // `.limit(N)` above 1,000 is not a bound — PostgREST caps at db-max-rows.
    // The commissions are summed, so the read pages on the id, not on offsets:
    // a referral recorded between two pages shifted every later offset by one,
    // and one commission was owed or paid twice.
    //
    // Past its ceiling the read costs what is summed from it — the three tiles
    // and each partner's conversions and amount owed, which say they are not
    // shown — not the partner list, its actions or the form to add one; it
    // used to be the read-error state. It keeps its prefix (failOnMax: false)
    // only so the ceiling is told from a failure: a cut-short read is never
    // summed below. Pay out stays on every row then: settling a partner with
    // nothing converted is the action's ordinary case. Any failure is still
    // the read-error state.
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('affiliate_referrals').select('id, affiliate_id, status, commission_cents');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING, failOnMax: false }),
    supabase.from('affiliates').select('id', { count: 'exact', head: true }),
  ]);
  const referralsCeiling = 'truncated' in referralsResult && referralsResult.truncated;
  const readError = affiliatesResult.error ?? referralsResult.error ?? affiliateCountResult.error;
  if (readError) {
    console.error('[admin-marketing-affiliates] affiliate read failed', readError);
    return <AdminAffiliatesReadError />;
  }
  if (referralsCeiling) console.warn('[admin-marketing-affiliates] the referral read reached its ceiling; the commissions are not shown');
  const { data: affiliates } = affiliatesResult;
  const { data: referrals } = referralsResult;
  const list = (affiliates ?? []) as Affiliate[];
  const refs = (referrals ?? []) as ReferralLike[];
  const overall = summarizeReferrals(refs);
  const byAffiliate = payoutByAffiliate(refs);
  const unavailable = t('strategyMetrics.unavailable');
  const summed = (value: string | number) => (referralsCeiling ? unavailable : value);

  const stats = [
    { label: t('affiliates.affiliates'), value: (affiliateCountResult.count ?? 0).toLocaleString(), icon: Handshake, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Conversions', value: summed(overall.conversions), icon: BadgeCheck, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Owed (unpaid)', value: summed(formatCents(overall.pendingPayoutCents)), icon: Wallet, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Paid out', value: summed(formatCents(overall.paidCents)), icon: DollarSign, tint: 'text-blue-400 bg-blue-500/15' },
  ];

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={referralsCeiling ? stats.slice(1).map((s) => s.label) : []}
      />
      <p className="text-sm text-muted">{t('affiliates.externalPartnersWhoEarnCommission')}{' '}<code className="rounded bg-elevated px-1 py-0.5 text-xs">?via=CODE</code>.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">{t('adminMarketingAffiliates.addAnAffiliate')}</h2>
        <form action={saveAffiliateAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input name="name" required placeholder={t('adminMarketingAffiliates.partnerName')} className={inputCls} />
          <input name="email" type="email" placeholder={t('adminMarketingAffiliates.email')} className={inputCls} />
          <input name="code" placeholder={t('adminMarketingAffiliates.codeEGCoolblog')} className={inputCls} />
          <input name="commission_rate" type="number" min="0" max="100" step="1" placeholder={t('adminMarketingAffiliates.commission')} className={inputCls} />
          <SubmitButton className={btnCls}>{t('adminMarketingAffiliates.addAffiliate')}</SubmitButton>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('adminMarketingAffiliates.affiliates')}</h2>
        {(affiliateCountResult.count ?? 0) > list.length && (
          <p className="mb-3 text-xs text-muted">{t('adminCeiling.listShowsTheNewest', { shown: list.length.toLocaleString(), total: (affiliateCountResult.count ?? 0).toLocaleString() })}</p>
        )}
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('adminMarketingAffiliates.noAffiliatesYet')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2">{t('adminMarketingAffiliates.partner')}</th><th className="pb-2">{t('adminMarketingAffiliates.code')}</th><th className="pb-2">{t('adminMarketingAffiliates.rate')}</th>
                  <th className="pb-2">{t('adminMarketingAffiliates.conversions')}</th><th className="pb-2">{t('adminMarketingAffiliates.owed')}</th><th className="pb-2">{t('adminMarketingAffiliates.status')}</th><th className="pb-2 text-right">{t('adminMarketingAffiliates.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const sum = byAffiliate.get(a.id);
                  return (
                    <tr key={a.id} className="border-t border-border align-top">
                      <td className="py-2"><p className="font-medium">{a.name}</p>{a.email && <p className="text-xs text-muted">{a.email}</p>}</td>
                      <td className="py-2"><code className="rounded bg-elevated px-1.5 py-0.5 text-xs">{a.code}</code></td>
                      <td className="py-2">{Math.round(a.commission_rate * 100)}%</td>
                      <td className="py-2">{summed(sum?.conversions ?? 0)}</td>
                      <td className="py-2">{summed(formatCents(sum?.pendingPayoutCents ?? 0))}</td>
                      <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-[11px] ${a.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>{a.status}</span></td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-1">
                          {(referralsCeiling || (sum?.pendingPayoutCents ?? 0) > 0) && (
                            <form action={markAffiliatePaidAction.bind(null, a.id)}>
                              <SubmitButton className="rounded-md border border-border px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10">{t('affiliates.payOut')}</SubmitButton>
                            </form>
                          )}
                          <form action={toggleAffiliateStatusAction.bind(null, a.id, a.status === 'active' ? 'paused' : 'active')}>
                            <SubmitButton className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-fg">{a.status === 'active' ? 'Pause' : 'Activate'}</SubmitButton>
                          </form>
                          <form action={deleteAffiliateAction.bind(null, a.id)}>
                            <SubmitButton className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:text-rose-400">✕</SubmitButton>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function AdminAffiliatesReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('affiliates.affiliates')}</h1>
        <p className="mt-1 text-sm text-muted">{t('affiliates.managePartnerConversionsAndPayouts')}</p>
      </div>
      <ErrorState message={t('affiliates.couldNotLoadAffiliatePayout')} />
      <Link href="/admin/marketing/affiliates" className="text-sm font-medium text-brand-text underline">{t('affiliates.refreshAffiliates')}</Link>
    </div>
  );
}
