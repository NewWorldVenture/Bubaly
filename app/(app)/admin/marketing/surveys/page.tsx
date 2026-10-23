import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, Plus, MessagesSquare } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle, settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { SURVEY_TYPES, summarize, isSurveyType, type SurveyType } from '@/lib/marketing/surveys';
import { createSurveyAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Surveys', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const STATUS_TONE = { draft: 'neutral', active: 'success', closed: 'warning' } as const;
/** Responses the scores may page through before they are reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;

export default async function SurveysPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const surveysResult = await settle(
    supabase.from('surveys').select('*').is('deleted_at', null).order('created_at', { ascending: false }));
  // Every listed survey's score is summed from these, and the public answers
  // while the page reads: paged on the id, to a real ceiling. An unbounded
  // select stopped at 1,000 responses across ALL surveys with no error, so a
  // survey's NPS was scored from whatever share of its answers came back.
  //
  // Only the LIVE surveys' responses, a hundred surveys a request: a deleted
  // survey's answers are scored nowhere on this page, and reading them let
  // them push the whole page past the ceiling. A batch that does reach it is
  // read again a survey at a time, so the ceiling costs the score of the
  // survey answered past it alone, not those of the up to 99 others in its
  // batch (review R5-CEILING-POLISH); never the list or the form to create one.
  const unscored = new Set<string>();
  const responsesOf = (surveyIds: string[]) => readAllByIdAsQuery((after, limit) => {
    let query = supabase.from('survey_responses').select('id, survey_id, score').in('survey_id', surveyIds);
    if (after) query = query.gt('id', after);
    return query.order('id').limit(limit);
  }, { max: SUM_ROW_CEILING });
  const responsesResult = await readInChunks((surveysResult.data ?? []).map((sv) => sv.id), async (chunk) => {
    const page = await responsesOf(chunk);
    if (!page.truncated) return page;
    if (chunk.length === 1) {
      unscored.add(chunk[0]);
      return { data: [], error: null };
    }
    const each = await settleAll(chunk.map((id) => responsesOf([id])));
    const data: NonNullable<typeof page.data> = [];
    for (const [i, one] of each.entries()) {
      if ('truncated' in one && one.truncated) unscored.add(chunk[i]);
      else if (one.error) return { data: null, error: one.error };
      else data.push(...(one.data ?? []));
    }
    return { data, error: null };
  });
  const readError = surveysResult.error ?? responsesResult.error;
  if (readError) {
    console.error('[admin-marketing-surveys] survey read failed', readError);
    return <AdminSurveysReadError />;
  }
  const { data: surveys } = surveysResult;
  const { data: responses } = responsesResult;
  // Each name once: two surveys of one name are one line of the banner, and each says Unavailable in the list.
  const unscoredNames = [...new Set((surveys ?? []).filter((sv) => unscored.has(sv.id)).map((sv) => sv.name))];
  if (unscoredNames.length > 0) console.warn('[admin-marketing-surveys] a response read reached its ceiling; those surveys are not scored');

  const scoresBySurvey = new Map<string, number[]>();
  for (const r of responses ?? []) {
    if (r.score == null) continue;
    const arr = scoresBySurvey.get(r.survey_id) ?? [];
    arr.push(r.score);
    scoresBySurvey.set(r.survey_id, arr);
  }

  return (
    <div className="space-y-5">
      <PartialReadBanner title={tr('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })} failures={unscoredNames} />
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
            <SubmitButton className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Plus className="h-4 w-4" /> {tr('adminMarketingSurveys.createSurvey')}</SubmitButton>
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
            const scored = !unscored.has(sv.id);
            return (
              <Link key={sv.id} href={`/admin/marketing/surveys/${sv.id}`}>
                <Card className="transition hover:border-brand/40">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{sv.name}</p>
                      <p className="text-xs text-muted">{SURVEY_TYPES[type].label}{scored && <> · {summary.total} response{summary.total === 1 ? '' : 's'}</>}</p>
                    </div>
                    <Badge tone={STATUS_TONE[sv.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{sv.status}</Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <p className="text-2xl font-bold leading-none">{!scored ? tr('strategyMetrics.unavailable') : summary.total > 0 ? summary.value : '—'}</p>
                      <p className="mt-1 text-xs text-muted">{summary.headline}{scored && summary.detail && summary.total > 0 ? ` · ${summary.detail}` : ''}</p>
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
