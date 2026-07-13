import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, Plus, MessagesSquare } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { SURVEY_TYPES, summarize, isSurveyType, type SurveyType } from '@/lib/marketing/surveys';
import { createSurveyAction } from './actions';

export const metadata: Metadata = { title: 'Marketing · Surveys', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const STATUS_TONE = { draft: 'neutral', active: 'success', closed: 'warning' } as const;

export default async function SurveysPage() {
  const supabase = createServiceClient();
  const [{ data: surveys }, { data: responses }] = await Promise.all([
    supabase.from('surveys').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('survey_responses').select('survey_id, score'),
  ]);

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
          <h2 className="text-base font-bold">Surveys — NPS · CSAT · CES</h2>
          <p className="text-xs text-muted">Measure loyalty, satisfaction, and effort. Share a link and watch scores roll in.</p>
        </div>
      </div>

      {/* Create */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold">New survey</h3>
        <form action={createSurveyAction} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">Type</span>
            <select name="type" className={inputCls} defaultValue="nps">
              {(Object.keys(SURVEY_TYPES) as SurveyType[]).map((t) => (
                <option key={t} value={t}>{SURVEY_TYPES[t].label} — {SURVEY_TYPES[t].metric}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">Name (internal)</span>
            <input name="name" required className={inputCls} placeholder="Q3 onboarding NPS" />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="block text-xs font-medium text-muted">Question (leave blank for the type default)</span>
            <input name="question" className={inputCls} placeholder="How likely are you to recommend Bubaly?" />
          </label>
          <div className="sm:col-span-2">
            <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Plus className="h-4 w-4" /> Create survey</button>
            <p className="mt-1 text-[11px] text-muted">Scale &amp; labels default to the chosen type (NPS 0–10, CSAT 1–5, CES 1–7) and are editable after creating.</p>
          </div>
        </form>
      </Card>

      {/* List */}
      {(surveys ?? []).length === 0 ? (
        <EmptyState icon={MessagesSquare} title="No surveys yet" description="Create your first NPS, CSAT, or CES survey above." />
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
