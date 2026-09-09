import type { Metadata } from 'next';
import { Radar, Search, Link2, ShieldAlert } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import {
  rankKeywordOpportunities, keywordOpportunity, summarizeBacklinks, type BacklinkLike,
} from '@/lib/marketing/competitive';
import type { Tables } from '@/lib/database.types';
import { ErrorState } from '@/components/ui/states';
import {
  saveCompetitorAction, deleteCompetitorAction,
  saveKeywordAction, deleteKeywordAction,
  saveBacklinkAction, deleteBacklinkAction,
} from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Competitive Intelligence', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Competitor = Tables<'competitors'>;
type Keyword = Tables<'keyword_intel'>;
type Backlink = Tables<'backlinks'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-black sm:text-2xl">{t('competitive.competitiveIntelligence')}</h1>
      <ErrorState message={t('competitive.couldNotLoadCompetitiveIntelligence')} />
      <a href="/admin/marketing/competitive" className="text-sm font-medium text-brand-text underline">{t('competitive.refreshCompetitiveIntelligence')}</a>
    </div>
  );
}

export default async function CompetitivePage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  let results;
  try {
    results = await settleAll([
      supabase.from('competitors').select('*').order('ranking', { nullsFirst: false }).limit(200),
      supabase.from('keyword_intel').select('*').limit(500),
      supabase.from('backlinks').select('*').order('created_at', { ascending: false }).limit(500),
    ]);
  } catch {
    return <ReadFailure />;
  }
  if (results.some((result) => result.error)) return <ReadFailure />;
  const [competitorsResult, keywordsResult, backlinksResult] = results;
  const comps = (competitorsResult.data ?? []) as Competitor[];
  const kws = rankKeywordOpportunities((keywordsResult.data ?? []) as Keyword[]);
  const links = (backlinksResult.data ?? []) as Backlink[];
  const bl = summarizeBacklinks(links as unknown as BacklinkLike[]);

  const stats = [
    { label: 'Competitors', value: comps.length, icon: Radar, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Keywords tracked', value: kws.length, icon: Search, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Active backlinks', value: bl.active, icon: Link2, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Avg authority', value: bl.avgAuthority, icon: ShieldAlert, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('adminMarketingCompetitive.trackCompetitorsFindKeywordOpportunitiesAnd')}</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      {/* Competitors */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Radar className="h-4 w-4 text-brand-text" /> {t('adminMarketingCompetitive.competitors')}</h2>
        <form action={saveCompetitorAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="name" required placeholder="HubSpot" className={inputCls} />
          <input name="domain" placeholder="hubspot.com" className={inputCls} />
          <input name="ranking" type="number" min="1" placeholder={t('adminMarketingCompetitive.rank1Top')} className={inputCls} />
          <button type="submit" className={btnCls}>{t('adminMarketingCompetitive.addCompetitor')}</button>
        </form>
        {comps.length === 0 ? <p className="py-3 text-center text-sm text-muted">{t('adminMarketingCompetitive.noCompetitorsTracked')}</p> : (
          <div className="space-y-1.5">
            {comps.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <span><span className="font-medium">{c.name}</span>{c.domain && <span className="ml-2 text-xs text-muted">{c.domain}</span>}{c.ranking != null && <span className="ml-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300">#{c.ranking}</span>}</span>
                <form action={deleteCompetitorAction.bind(null, c.id)}><button className="text-xs text-muted hover:text-rose-400">✕</button></form>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Keyword Intelligence */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Search className="h-4 w-4 text-brand-text" /> {t('adminMarketingCompetitive.keywordIntelligence')}</h2>
        <form action={saveKeywordAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input name="keyword" required placeholder={t('adminMarketingCompetitive.familyCalendarApp')} className={`${inputCls} lg:col-span-2`} />
          <input name="search_volume" type="number" min="0" placeholder="Volume/mo" className={inputCls} />
          <input name="difficulty" type="number" min="0" max="100" placeholder={t('adminMarketingCompetitive.difficulty')} className={inputCls} />
          <input name="our_rank" type="number" min="1" placeholder={t('adminMarketingCompetitive.ourRank')} className={inputCls} />
          <button type="submit" className={`${btnCls} lg:col-span-5`}>{t('adminMarketingCompetitive.addKeyword')}</button>
        </form>
        {kws.length === 0 ? <p className="py-3 text-center text-sm text-muted">{t('adminMarketingCompetitive.noKeywordsTracked')}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="pb-2">{t('adminMarketingCompetitive.keyword')}</th><th className="pb-2">{t('adminMarketingCompetitive.volume')}</th><th className="pb-2">{t('adminMarketingCompetitive.difficulty')}</th><th className="pb-2">{t('adminMarketingCompetitive.ourRank')}</th><th className="pb-2">{t('adminMarketingCompetitive.opportunity')}</th><th className="pb-2"></th></tr></thead>
              <tbody>
                {kws.map((k) => (
                  <tr key={k.id} className="border-t border-border">
                    <td className="py-2 font-medium">{k.keyword}</td>
                    <td className="py-2">{k.search_volume.toLocaleString()}</td>
                    <td className="py-2">{k.difficulty ?? '—'}</td>
                    <td className="py-2">{k.our_rank ?? <span className="text-muted">unranked</span>}</td>
                    <td className="py-2"><span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">{keywordOpportunity(k)}</span></td>
                    <td className="py-2 text-right"><form action={deleteKeywordAction.bind(null, k.id)}><button className="text-xs text-muted hover:text-rose-400">✕</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Backlinks */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Link2 className="h-4 w-4 text-brand-text" /> {t('adminMarketingCompetitive.backlinkMonitoring')}</h2>
        <form action={saveBacklinkAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input name="source_domain" required placeholder="techcrunch.com" className={`${inputCls} lg:col-span-2`} />
          <input name="target_url" placeholder="/blog/post" className={inputCls} />
          <input name="authority" type="number" min="0" max="100" placeholder={t('adminMarketingCompetitive.authority')} className={inputCls} />
          <select name="status" defaultValue="active" className={inputCls}><option value="active">{t('adminMarketingCompetitive.active')}</option><option value="lost">{t('adminMarketingCompetitive.lost')}</option><option value="toxic">{t('adminMarketingCompetitive.toxic')}</option></select>
          <button type="submit" className={`${btnCls} lg:col-span-5`}>{t('adminMarketingCompetitive.addBacklink')}</button>
        </form>
        {links.length === 0 ? <p className="py-3 text-center text-sm text-muted">{t('adminMarketingCompetitive.noBacklinksTracked')}</p> : (
          <div className="space-y-1.5">
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <span><span className="font-medium">{l.source_domain}</span>{l.target_url && <span className="ml-2 text-xs text-muted">→ {l.target_url}</span>}{l.authority != null && <span className="ml-2 text-xs text-muted">DA {l.authority}</span>}<span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${l.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : l.status === 'toxic' ? 'bg-rose-500/15 text-rose-300' : 'bg-slate-500/15 text-slate-300'}`}>{l.status}</span></span>
                <form action={deleteBacklinkAction.bind(null, l.id)}><button className="text-xs text-muted hover:text-rose-400">✕</button></form>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
