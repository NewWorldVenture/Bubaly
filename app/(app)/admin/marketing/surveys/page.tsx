import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, Plus, MessagesSquare } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SURVEY_TYPES, summarize, isSurveyType, type SurveyType } from '@/lib/marketing/surveys';
import { createSurveyAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Surveys', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const STATUS_TONE = { draft: 'neutral', active: 'success', closed: 'warning' } as const;

export default async function SurveysPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const [surveysResult, responsesResult] = await settleAll([
    supabase.from('surveys').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('survey_responses').select('survey_id, score'),
  ]);
  const readError = surveysResult.error ?? responsesResult.error;
  if (readError) {
    console.error('[admin-marketing-surveys] survey read failed', readError);
    return <AdminSurveysReadError />;
  }
  const { data: surveys } = surveysResult;
  const { data: responses } = responsesResult;

  const scoresBySurvey = new Map<string, number[]>();
  for (const r of responses ?? []) {
    if (r.score == null) continue;
    const arr = scoresBySurvey.get(r.survey_id) ?? [];
    arr.push(r.score);
    scoresBySurvey.set(r.survey_id, arr);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-brand-text" />
        <div>
          <h2 className="text-base font-bold">{tr('adminMarketingSurveys.surveysNpsCsatCes')}</h2>
          <p className="text-xs text-muted">{tr('adminMarketingSurveys.measureLoyaltySatisfactionAndEffortShare')}</p>
        </div>
      </div>

      {/* Create */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold">{tr('adminMarketingSurveys.newSurvey')}</h3>
        <form action={createSurveyAction} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">{tr('adminMarketingSurveys.type')}</span>
            <select name="type" className={inputCls} defaultValue="nps">
              {(Object.keys(SURVEY_TYPES) as SurveyType[]).map((t) => (
                <option key={t} value={t}>{SURVEY_TYPES[t].label} — {SURVEY_TYPES[t].metric}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">{tr('adminMarketingSurveys.nameInternal')}</span>
            <input name="name" required className={inputCls} placeholder={tr('adminMarketingSurveys.q3OnboardingNps')} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="block text-xs font-medium text-muted">{tr('adminMarketingSurveys.questionLeaveBlankForTheType')}</span>
            <input name="question" className={inputCls} placeholder={tr('adminMarketingSurveys.howLikelyAreYouToRecommend')} />
          </label>
          <div className="sm:col-span-2">
            <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Plus className="h-4 w-4" /> {tr('adminMarketingSurveys.createSurvey')}</button>
            <p className="mt-1 text-[11px] text-muted">{tr('adminMarketingSurveys.scaleAmpLabelsDefaultToThe')}</p>
          </div>
        </form>
      </Card>

      {/* List */}
      {(surveys ?? []).length === 0 ? (
        <EmptyState icon={MessagesSquare} title={tr('adminMarketingSurveys.noSurveysYet')} description={tr('surveys.createYourFirstNpsCsat')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(surveys ?? []).map((sv) => {
            const type = isSurveyType(sv.type) ? sv.type : 'custom';
            const summary = summarize(type, scoresBySurvey.get(sv.id) ?? [], sv.scale_max);
            return (
              <Link key={sv.id} href={`/admin/marketing/surveys/${sv.id}`}>
                <Card className="transition hover:border-brand/40">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{sv.name}</p>
                      <p className="text-xs text-muted">{SURVEY_TYPES[type].label} · {summary.total} response{summary.total === 1 ? '' : 's'}</p>
                    </div>
                    <Badge tone={STATUS_TONE[sv.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{sv.status}</Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <p className="text-2xl font-bold leading-none">{summary.total > 0 ? summary.value : '—'}</p>
                      <p className="mt-1 text-xs text-muted">{summary.headline}{summary.detail && summary.total > 0 ? ` · ${summary.detail}` : ''}</p>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function AdminSurveysReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('surveys.marketingSurveys')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('surveys.createAndMeasureNpsCsat')}</p>
      </div>
      <ErrorState message={tr('surveys.couldNotLoadSurveyData')} />
      <Link href="/admin/marketing/surveys" className="text-sm font-medium text-brand-text underline">{tr('surveys.refreshSurveys')}</Link>
    </div>
  );
}
