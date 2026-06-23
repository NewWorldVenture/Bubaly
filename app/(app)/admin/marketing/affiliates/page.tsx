import type { Metadata } from 'next';
import { Handshake, DollarSign, BadgeCheck, Wallet } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { formatCents } from '@/lib/marketing/crm';
import { summarizeReferrals, payoutByAffiliate, type ReferralLike } from '@/lib/marketing/affiliates';
import type { Tables } from '@/lib/database.types';
import { saveAffiliateAction, toggleAffiliateStatusAction, deleteAffiliateAction, markAffiliatePaidAction } from './actions';

export const metadata: Metadata = { title: 'Affiliates', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Affiliate = Tables<'affiliates'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

export default async function AffiliatesPage() {
  const supabase = createServiceClient();
  const [{ data: affiliates }, { data: referrals }] = await Promise.all([
    supabase.from('affiliates').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('affiliate_referrals').select('affiliate_id, status, commission_cents').limit(10000),
  ]);
  const list = (affiliates ?? []) as Affiliate[];
  const refs = (referrals ?? []) as ReferralLike[];
  const overall = summarizeReferrals(refs);
  const byAffiliate = payoutByAffiliate(refs);

  const stats = [
    { label: 'Affiliates', value: list.length, icon: Handshake, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Conversions', value: overall.conversions, icon: BadgeCheck, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Owed (unpaid)', value: formatCents(overall.pendingPayoutCents), icon: Wallet, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Paid out', value: formatCents(overall.paidCents), icon: DollarSign, tint: 'text-blue-400 bg-blue-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">External partners who earn commission on conversions — low-cost acquisition with transparent payouts. Each partner drives traffic with <code className="rounded bg-elevated px-1 py-0.5 text-xs">?via=CODE</code>.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">Add an affiliate</h2>
        <form action={saveAffiliateAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input name="name" required placeholder="Partner name" className={inputCls} />
          <input name="email" type="email" placeholder="Email" className={inputCls} />
          <input name="code" placeholder="Code (e.g. COOLBLOG)" className={inputCls} />
          <input name="commission_rate" type="number" min="0" max="100" step="1" placeholder="Commission %" className={inputCls} />
          <button type="submit" className={btnCls}>Add affiliate</button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Affiliates</h2>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No affiliates yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2">Partner</th><th className="pb-2">Code</th><th className="pb-2">Rate</th>
                  <th className="pb-2">Conversions</th><th className="pb-2">Owed</th><th className="pb-2">Status</th><th className="pb-2 text-right">Actions</th>
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
                      <td className="py-2">{sum?.conversions ?? 0}</td>
                      <td className="py-2">{formatCents(sum?.pendingPayoutCents ?? 0)}</td>
                      <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-[11px] ${a.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>{a.status}</span></td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-1">
                          {(sum?.pendingPayoutCents ?? 0) > 0 && (
                            <form action={markAffiliatePaidAction.bind(null, a.id)}>
                              <button type="submit" className="rounded-md border border-border px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Pay out</button>
                            </form>
                          )}
                          <form action={toggleAffiliateStatusAction.bind(null, a.id, a.status === 'active' ? 'paused' : 'active')}>
                            <button type="submit" className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-fg">{a.status === 'active' ? 'Pause' : 'Activate'}</button>
                          </form>
                          <form action={deleteAffiliateAction.bind(null, a.id)}>
                            <button type="submit" className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:text-rose-400">✕</button>
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
