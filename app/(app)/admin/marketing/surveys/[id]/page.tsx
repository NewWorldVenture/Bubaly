import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { MessagesSquare } from 'lucide-react';
import {
  SURVEY_TYPES, summarize, computeNps, distribution, isSurveyType,
} from '@/lib/marketing/surveys';
import { SurveyControls } from './survey-controls';

export const metadata: Metadata = { title: 'Survey · Marketing', robots: { index: false } };
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

export default async function SurveyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createServiceClient();
  const { data: survey, error: surveyError } = await supabase.from('surveys').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (surveyError) {
    console.error('[admin-marketing-survey-detail] survey read failed', surveyError);
    return <SurveyDetailReadError />;
  }
  if (!survey) notFound();

  const { data: responses, error: responsesError } = await supabase
    .from('survey_responses').select('*').eq('survey_id', id).order('submitted_at', { ascending: false });
  if (responsesError) {
    console.error('[admin-marketing-survey-detail] response read failed', responsesError);
    return <SurveyDetailReadError />;
  }
  const rows = responses ?? [];
  const scores = rows.map((r) => r.score);
  const type = isSurveyType(survey.type) ? survey.type : 'custom';
  const summary = summarize(type, scores, survey.scale_max);
  const dist = distribution(scores, survey.scale_min, survey.scale_max);
  const maxCount = Math.max(1, ...dist.map((d) => d.count));
  const nps = type === 'nps' ? computeNps(scores) : null;
  const publicUrl = `${SITE_URL}/s/${survey.slug}`;

  return (
    <div className="space-y-5">
      <Link href="/admin/marketing/surveys" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> All surveys
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">{survey.name}</h2>
            <Badge tone={survey.status === 'active' ? 'success' : survey.status === 'closed' ? 'warning' : 'neutral'}>{survey.status}</Badge>
          </div>
          <p className="text-sm text-muted">{SURVEY_TYPES[type].label} · {SURVEY_TYPES[type].metric}</p>
        </div>
      </div>

      <SurveyControls id={survey.id} status={survey.status} publicUrl={publicUrl} />

      {/* Share link */}
      <Card>
        <p className="text-xs font-medium text-muted">Public share link {survey.status !== 'active' && <span className="text-warning">(activate the survey to accept responses)</span>}</p>
        <a href={publicUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 break-all text-sm font-medium text-brand-text underline">
          {publicUrl} <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
        <p className="mt-2 text-sm text-muted">“{survey.question}”</p>
      </Card>

      {/* Score dashboard */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <p className="text-xs font-medium text-muted">{summary.headline}</p>
          <p className="mt-1 text-4xl font-bold leading-none">{summary.total > 0 ? summary.value : '—'}</p>
          <p className="mt-2 text-xs text-muted">{summary.total} response{summary.total === 1 ? '' : 's'}{summary.detail && summary.total > 0 ? ` · ${summary.detail}` : ''}</p>
          {nps && nps.total > 0 && (
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex items-center justify-between"><span className="text-success">Promoters</span><span>{nps.promoters} ({nps.promoterPct}%)</span></div>
              <div className="flex items-center justify-between"><span className="text-muted">Passives</span><span>{nps.passives} ({nps.passivePct}%)</span></div>
              <div className="flex items-center justify-between"><span className="text-danger">Detractors</span><span>{nps.detractors} ({nps.detractorPct}%)</span></div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <p className="mb-2 text-xs font-medium text-muted">Score distribution</p>
          <div className="flex items-end gap-1.5" style={{ height: 140 }}>
            {dist.map((d) => (
              <div key={d.value} className="flex flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[10px] text-muted">{d.count || ''}</span>
                <div
                  className={`w-full rounded-t ${type === 'nps' ? (d.value >= 9 ? 'bg-success' : d.value >= 7 ? 'bg-warning' : 'bg-danger') : 'bg-brand'}`}
                  style={{ height: `${(d.count / maxCount) * 100}%`, minHeight: d.count ? 4 : 0 }}
                />
                <span className="text-[10px] text-muted">{d.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Responses */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Responses</h3>
        {rows.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No responses yet" description="Share the link above to start collecting feedback." />
        ) : (
          <div className="space-y-2">
            {rows.slice(0, 100).map((r) => (
              <div key={r.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-sm font-bold">{r.score ?? '–'}</span>
                <div className="min-w-0 flex-1">
                  {r.comment && <p className="text-sm">{r.comment}</p>}
                  <p className="text-xs text-muted">{r.respondent_email ?? 'Anonymous'} · {new Date(r.submitted_at).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function SurveyDetailReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Survey</h1>
        <p className="mt-1 text-sm text-muted">Review survey configuration and responses.</p>
      </div>
      <ErrorState message="Could not load this survey from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/surveys" className="text-sm font-medium text-brand-text underline">Back to surveys</Link>
    </div>
  );
}
