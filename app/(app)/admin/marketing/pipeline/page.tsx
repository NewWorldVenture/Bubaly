import type { Metadata } from 'next';
import Link from 'next/link';
import { TrendingUp, DollarSign, Trophy, Percent } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { fmtDate } from '@/lib/utils/format';
import {
  dealsByStage, openPipelineValueCents, weightedPipelineValueCents, wonValueCents, winRate,
  formatCents, contactDisplayName, DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage,
} from '@/lib/marketing/crm';
import type { Tables } from '@/lib/database.types';
import { saveDealAction, setDealStageAction, deleteDealAction } from '../crm/actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pipeline.salesPipeline'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

type Deal = Tables<'crm_deals'>;
type Contact = Tables<'crm_contacts'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
/** Deals the tiles may page through before they are reported as not shown (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;
/** The board lists the newest this many deals. */
const BOARD_SHOWN = 500;
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const STAGE_TINT: Record<DealStage, string> = {
  lead: 'text-slate-300', qualified: 'text-blue-300', proposal: 'text-violet-300',
  negotiation: 'text-amber-300', won: 'text-emerald-300', lost: 'text-rose-300',
};

export default async function PipelinePage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // The board is the newest 500 deals and the contact picker the newest 500
  // contacts; the tiles are the whole pipeline. Summed from the board, Open
  // pipeline, Weighted, Won and Win rate left out every older deal, so the
  // deals are paged on the id to a real ceiling, and past it the tiles say
  // they are not shown rather than adding up part of the pipeline.
  const [dealsResult, contactsResult, pipelineResult] = await settleAll([
    supabase.from('crm_deals').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(BOARD_SHOWN),
    supabase.from('crm_contacts').select('id, first_name, last_name, email').order('created_at', { ascending: false }).limit(500),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('crm_deals').select('id, stage, amount_cents');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]);
  const pipelineCeiling = 'truncated' in pipelineResult && pipelineResult.truncated;
  const readError = dealsResult.error ?? contactsResult.error ?? (pipelineCeiling ? null : pipelineResult.error);
  if (readError) {
    console.error('[admin-marketing-pipeline] pipeline read failed', readError);
    return <AdminPipelineReadError />;
  }
  const { data: deals } = dealsResult;
  const { data: contacts } = contactsResult;

  const list = (deals ?? []) as Deal[];
  const contactList = (contacts ?? []) as Pick<Contact, 'id' | 'first_name' | 'last_name' | 'email'>[];
  // A deal is named from ITS contact. The newest 500 contacts named whichever
  // contacts were newest, and a deal whose contact was older read "—".
  const listedContactIds = [...new Set(list.map((d) => d.contact_id).filter((id): id is string => !!id))];
  const labelsResult = await readInChunks(listedContactIds, (chunk) =>
    supabase.from('crm_contacts').select('id, first_name, last_name, email').in('id', chunk));
  if (labelsResult.error) {
    console.error('[admin-marketing-pipeline] pipeline read failed', labelsResult.error);
    return <AdminPipelineReadError />;
  }
  const contactName = new Map(labelsResult.data.map((c) => [c.id, contactDisplayName(c)]));
  const grouped = dealsByStage(list.map((d) => ({ ...d, stage: d.stage as DealStage })));
  const pipeline = (pipelineResult.data ?? []).map((d) => ({ ...d, stage: d.stage as DealStage }));
  // Each column header counts and adds up its WHOLE stage, from the paged
  // read the tiles use, so the open stages add up to Open pipeline; from the
  // board they described the newest 500 deals (review
  // R5-CRM-BOARD-AND-RANKING-FROM-CAPPED-LISTS). Past the ceiling they say they
  // are not shown, as the tiles do, and the board says when it lists fewer
  // deals than the pipeline holds.
  const stageTotals = dealsByStage(pipeline);
  const boardIsPart = pipelineCeiling || pipeline.length > list.length;
  const unavailable = t('strategyMetrics.unavailable');
  const tile = (value: string) => (pipelineCeiling ? unavailable : value);

  const stats = [
    { label: 'Open pipeline', value: tile(formatCents(openPipelineValueCents(pipeline))), icon: TrendingUp, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Weighted (expected)', value: tile(formatCents(weightedPipelineValueCents(pipeline))), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Won', value: tile(formatCents(wonValueCents(pipeline))), icon: Trophy, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Win rate', value: tile(`${Math.round(winRate(pipeline) * 100)}%`), icon: Percent, tint: 'text-blue-400 bg-blue-500/15' },
  ];

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={pipelineCeiling ? [...stats.map((s) => s.label), t('adminMarketingPipeline.stageTotals')] : []}
      />
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
          <input name="amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder={t('adminMarketingPipeline.amount')} className={inputCls} />
          <select name="stage" defaultValue="lead" aria-label={t('adminMarketingPipeline.stage')} className={inputCls}>
            {DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABELS[s]}</option>)}
          </select>
          <select name="contact_id" defaultValue="" aria-label={t('adminMarketingPipeline.contact')} className={`${inputCls} lg:col-span-2`}>
            <option value="">{t('adminMarketingPipeline.noContact')}</option>
            {contactList.map((c) => <option key={c.id} value={c.id}>{contactDisplayName(c)}</option>)}
          </select>
          <input name="close_date" type="date" aria-label={t('adminMarketingPipeline.closeDate')} className={inputCls} />
          <SubmitButton className={btnCls}>{t('adminMarketingPipeline.addDeal')}</SubmitButton>
        </form>
      </Card>

      {/* Pipeline board */}
      {boardIsPart && (
        <p className="text-xs text-muted">{t('adminMarketingPipeline.boardIsTheNewest', { n: BOARD_SHOWN.toLocaleString() })}</p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {DEAL_STAGES.map((stage) => {
          const col = grouped[stage];
          const whole = stageTotals[stage];
          const total = whole.reduce((sum, d) => sum + (d.amount_cents || 0), 0);
          return (
            <div key={stage} className="rounded-2xl border border-border bg-surface/30 p-2.5">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className={`text-sm font-semibold ${STAGE_TINT[stage]}`}>{DEAL_STAGE_LABELS[stage]}</span>
                <span className="text-xs text-muted">{pipelineCeiling ? unavailable : `${whole.length} · ${formatCents(total)}`}</span>
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
                        <SubmitButton className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:text-rose-400">✕</SubmitButton>
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
