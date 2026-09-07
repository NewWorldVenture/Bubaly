import type { Metadata } from 'next';
import Link from 'next/link';
import { TrendingUp, DollarSign, Trophy, Percent } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import {
  dealsByStage, openPipelineValueCents, weightedPipelineValueCents, wonValueCents, winRate,
  formatCents, contactDisplayName, DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage,
} from '@/lib/marketing/crm';
import type { Tables } from '@/lib/database.types';
import { saveDealAction, setDealStageAction, deleteDealAction } from '../crm/actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'pipeline.salesPipeline', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Deal = Tables<'crm_deals'>;
type Contact = Tables<'crm_contacts'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const STAGE_TINT: Record<DealStage, string> = {
  lead: 'text-slate-300', qualified: 'text-blue-300', proposal: 'text-violet-300',
  negotiation: 'text-amber-300', won: 'text-emerald-300', lost: 'text-rose-300',
};

export default async function PipelinePage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [dealsResult, contactsResult] = await Promise.all([
    supabase.from('crm_deals').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('crm_contacts').select('id, first_name, last_name, email').order('created_at', { ascending: false }).limit(500),
  ]);
  const readError = dealsResult.error ?? contactsResult.error;
  if (readError) {
    console.error('[admin-marketing-pipeline] pipeline read failed', readError);
    return <AdminPipelineReadError />;
  }
  const { data: deals } = dealsResult;
  const { data: contacts } = contactsResult;

  const list = (deals ?? []) as Deal[];
  const contactList = (contacts ?? []) as Pick<Contact, 'id' | 'first_name' | 'last_name' | 'email'>[];
  const contactName = new Map(contactList.map((c) => [c.id, contactDisplayName(c)]));
  const grouped = dealsByStage(list.map((d) => ({ ...d, stage: d.stage as DealStage })));

  const stats = [
    { label: 'Open pipeline', value: formatCents(openPipelineValueCents(list as never)), icon: TrendingUp, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Weighted (expected)', value: formatCents(weightedPipelineValueCents(list as never)), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Won', value: formatCents(wonValueCents(list as never)), icon: Trophy, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Win rate', value: `${Math.round(winRate(list as never) * 100)}%`, icon: Percent, tint: 'text-blue-400 bg-blue-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('adminMarketingPipeline.trackEveryOpportunityFromLeadTo')}</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      {/* Add deal */}
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t('adminMarketingPipeline.addADeal')}</h2>
        <form action={saveDealAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="name" required placeholder={t('adminMarketingPipeline.dealName')} className={`${inputCls} lg:col-span-2`} />
          <input name="amount" type="number" min="0" step="0.01" placeholder={t('adminMarketingPipeline.amount')} className={inputCls} />
          <select name="stage" defaultValue="lead" className={inputCls}>
            {DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABELS[s]}</option>)}
          </select>
          <select name="contact_id" defaultValue="" className={`${inputCls} lg:col-span-2`}>
            <option value="">{t('adminMarketingPipeline.noContact')}</option>
            {contactList.map((c) => <option key={c.id} value={c.id}>{contactDisplayName(c)}</option>)}
          </select>
          <input name="close_date" type="date" className={inputCls} />
          <button type="submit" className={btnCls}>{t('adminMarketingPipeline.addDeal')}</button>
        </form>
      </Card>

      {/* Pipeline board */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {DEAL_STAGES.map((stage) => {
          const col = grouped[stage];
          const total = col.reduce((sum, d) => sum + (d.amount_cents || 0), 0);
          return (
            <div key={stage} className="rounded-2xl border border-border bg-surface/30 p-2.5">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className={`text-sm font-semibold ${STAGE_TINT[stage]}`}>{DEAL_STAGE_LABELS[stage]}</span>
                <span className="text-xs text-muted">{col.length} · {formatCents(total)}</span>
              </div>
              <div className="space-y-2">
                {col.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-muted">—</p>
                ) : col.map((d) => (
                  <div key={d.id} className="rounded-xl border border-border bg-surface/60 p-2.5">
                    <p className="text-sm font-medium leading-tight">{d.name}</p>
                    <p className="mt-0.5 text-sm font-semibold">{formatCents(d.amount_cents)}</p>
                    {d.contact_id && <p className="text-xs text-muted">{contactName.get(d.contact_id) ?? '—'}</p>}
                    {d.close_date && <p className="text-[11px] text-muted">close {fmtDate(d.close_date)}</p>}
                    <div className="mt-1.5 flex items-center gap-1">
                      <form action={setDealStageAction.bind(null, d.id, nextStage(stage))} className="flex-1">
                        <button type="submit" className="w-full rounded-md border border-border px-1.5 py-1 text-[11px] text-muted hover:text-fg" disabled={stage === 'won'}>
                          {stage === 'won' || stage === 'lost' ? '↻ reopen' : '→ advance'}
                        </button>
                      </form>
                      <form action={deleteDealAction.bind(null, d.id)}>
                        <button type="submit" className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:text-rose-400">✕</button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The stage a deal advances to when "→ advance" is clicked. */
function nextStage(stage: DealStage): DealStage {
  const order: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won'];
  const i = order.indexOf(stage);
  if (stage === 'won' || stage === 'lost') return 'qualified'; // reopen
  return i >= 0 && i < order.length - 1 ? order[i + 1] : 'won';
}

async function AdminPipelineReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('pipeline.salesPipeline')}</h1>
        <p className="mt-1 text-sm text-muted">{t('pipeline.trackOpportunitiesFromLeadTo')}</p>
      </div>
      <ErrorState message={t('pipeline.couldNotLoadTheSales')} />
      <Link href="/admin/marketing/pipeline" className="text-sm font-medium text-brand-text underline">{t('pipeline.refreshPipeline')}</Link>
    </div>
  );
}
