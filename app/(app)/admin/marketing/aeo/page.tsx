import type { Metadata } from 'next';
import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { addAeoQuestion, deleteAeoQuestion, updateAeoQuestion } from '../actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · AEO', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PATTERNS = ['what_is', 'how_to', 'best_x_for_y', 'comparison', 'faq', 'local'];
const STATUSES = ['opportunity', 'drafting', 'answered', 'published'];

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'brand' | 'success'> = {
  opportunity: 'warning', drafting: 'neutral', answered: 'brand', published: 'success',
};

// Only the latest slice is rendered — the table can hold thousands of rows, and
// fetching/rendering all of them made the page slow to open. Accurate totals come
// from cheap COUNT queries (head:true → no row transfer); the editable list is
// bounded + column-projected.
const LIST_LIMIT = 50;

export default async function AeoPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [totalRes, answeredRes, listRes] = await settleAll([
    supabase.from('marketing_aeo_questions').select('id', { count: 'exact', head: true }),
    supabase.from('marketing_aeo_questions').select('id', { count: 'exact', head: true }).in('status', ['answered', 'published']),
    supabase
      .from('marketing_aeo_questions')
      .select('id, question, answer, status, pattern, entity, clarity_score, source_path')
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT),
  ]);
  const questionsError = totalRes.error ?? answeredRes.error ?? listRes.error;
  if (questionsError) {
    console.error('[admin-marketing-aeo] question read failed', questionsError);
    return <AdminAeoReadError />;
  }

  const total = totalRes.count ?? 0;
  const answered = answeredRes.count ?? 0;
  const readiness = total > 0 ? Math.round((answered / total) * 100) : 0;
  const rows = listRes.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminMarketingAeo.marketingAeo')}</h1>
          <p className="mt-1 text-sm text-muted">{t('adminMarketingAeo.answerEngineOptimizationTrackTheQuestions')}</p>
        </div>
        <Link href="/admin/marketing/seo" className="text-sm font-medium text-brand-text hover:underline">SEO →</Link>
      </div>

      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">{t('aeo.answerEngineOptimizationPreparesYour')}</div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Card><p className="text-xs text-muted">{t('adminMarketingAeo.questions')}</p><p className="text-2xl font-bold">{total.toLocaleString()}</p></Card>
            <Card><p className="text-xs text-muted">{t('adminMarketingAeo.answered')}</p><p className="text-2xl font-bold">{answered.toLocaleString()}</p></Card>
            <Card><p className="text-xs text-muted">{t('adminMarketingAeo.readiness')}</p><p className="text-2xl font-bold">{readiness}%</p></Card>
          </div>

          {total === 0 ? (
            <EmptyState icon={MessagesSquare} title={t('adminMarketingAeo.noQuestionsTracked')} description={t('aeo.captureTheQuestionsYourCustomers')} />
          ) : (
            <div className="space-y-2">
              {total > rows.length && (
                <p className="px-1 text-xs text-muted">{t('adminMarketingAeo.showingTheLatest')} {rows.length} of {total.toLocaleString()} questions.</p>
              )}
              {rows.map((q) => (
                <Card key={q.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{q.question}</p>
                    <Badge tone={STATUS_TONE[q.status] ?? 'neutral'} className="shrink-0 capitalize">{q.status}</Badge>
                  </div>
                  {q.answer && <p className="mt-2 text-sm text-muted">{q.answer}</p>}
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-xs text-muted hover:text-fg">{t('aeo.editQuestion')}</summary>
                    <form action={updateAeoQuestion} className="mt-3 grid gap-2 sm:grid-cols-2">
                      <input type="hidden" name="id" value={q.id} />
                      <input name="question" required defaultValue={q.question} className={inputCls} />
                      <input name="entity" defaultValue={q.entity ?? ''} placeholder={t('aeo.entity')} className={inputCls} />
                      <textarea name="answer" rows={4} defaultValue={q.answer ?? ''} placeholder={t('aeo.structuredAnswer')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring sm:col-span-2" />
                      <select name="pattern" defaultValue={q.pattern ?? ''} className={inputCls}><option value="">{t('aeo.pattern')}</option>{PATTERNS.map((pattern) => <option key={pattern} value={pattern}>{pattern.replace(/_/g, ' ')}</option>)}</select>
                      <select name="status" defaultValue={q.status} className={inputCls}>{STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
                      <input name="clarity_score" type="number" min="0" max="100" defaultValue={q.clarity_score ?? ''} placeholder={t('aeo.clarityScore0100')} className={inputCls} />
                      <input name="source_path" defaultValue={q.source_path ?? ''} placeholder="Source path (/faq)" className={inputCls} />
                      <button type="submit" className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90 sm:col-span-2">{t('aeo.saveQuestion')}</button>
                    </form>
                    <form action={deleteAeoQuestion} className="mt-2">
                      <input type="hidden" name="id" value={q.id} />
                      <button type="submit" className="text-xs text-muted hover:text-rose-400">{t('aeo.deleteQuestion')}</button>
                    </form>
                  </details>
                  {q.pattern && <p className="mt-2 text-xs text-muted">Pattern: {q.pattern.replace(/_/g, ' ')}{q.entity ? ` · ${q.entity}` : ''}</p>}
                </Card>
              ))}
            </div>
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">{t('adminMarketingAeo.addAQuestion')}</h2>
          <form action={addAeoQuestion} className="space-y-3 text-sm">
            <input name="question" required placeholder={t('adminMarketingAeo.whatIsTheBestFamilyOrganizer')} className={inputCls} />
            <select name="pattern" className={inputCls}><option value="">{t('adminMarketingAeo.patternOptional')}</option>{PATTERNS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}</select>
            <input name="entity" placeholder={t('adminMarketingAeo.entityEGBubaly')} className={inputCls} />
            <input name="source_path" placeholder={t('adminMarketingAeo.sourcePathFeatures')} className={inputCls} />
            <textarea name="answer" rows={4} placeholder={t('adminMarketingAeo.structuredAnswerDraft')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingAeo.addQuestion')}</button>
          </form>
        </Card>
      </div>
    </div>
  );
}

async function AdminAeoReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('aeo.marketingAeo')}</h1>
        <p className="mt-1 text-sm text-muted">{t('aeo.trackCustomerQuestionsAndStructured')}</p>
      </div>
      <ErrorState message={t('aeo.couldNotLoadAeoQuestions')} />
      <Link href="/admin/marketing/aeo" className="text-sm font-medium text-brand-text underline">{t('aeo.refreshAeo')}</Link>
    </div>
  );
}
