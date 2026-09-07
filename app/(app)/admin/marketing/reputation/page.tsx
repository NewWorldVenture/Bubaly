import type { Metadata } from 'next';
import Link from 'next/link';
import { Quote, BookOpenCheck, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import {
  saveTestimonialAction, togglePublishTestimonialAction, deleteTestimonialAction,
  saveCaseStudyAction, deleteCaseStudyAction,
} from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Reputation & Trust', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Testimonial = Tables<'testimonials'>;
type CaseStudy = Tables<'case_studies'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

export default async function ReputationPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const [testimonialsResult, caseStudiesResult] = await Promise.all([
    supabase.from('testimonials').select('*').order('sort_order').order('created_at', { ascending: false }).limit(200),
    supabase.from('case_studies').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  const readError = testimonialsResult.error ?? caseStudiesResult.error;
  if (readError) {
    console.error('[admin-marketing-reputation] reputation read failed', readError);
    return <AdminReputationReadError />;
  }
  const { data: testimonials } = testimonialsResult;
  const { data: caseStudies } = caseStudiesResult;
  const tList = (testimonials ?? []) as Testimonial[];
  const cList = (caseStudies ?? []) as CaseStudy[];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{tr('adminMarketingReputation.curatedSocialProofPublishedTestimonialsAnd')}</p>

      {/* Testimonials */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Quote className="h-4 w-4 text-brand-text" /> {tr('adminMarketingReputation.testimonials')}</h2>
        <form action={saveTestimonialAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="author_name" required placeholder={tr('adminMarketingReputation.authorName')} className={inputCls} />
          <input name="author_role" placeholder={tr('adminMarketingReputation.roleEGMomOf3')} className={inputCls} />
          <input name="company" placeholder={tr('adminMarketingReputation.companyCity')} className={inputCls} />
          <input name="rating" type="number" min="1" max="5" placeholder={tr('adminMarketingReputation.rating15')} className={inputCls} />
          <textarea name="quote" required placeholder={tr('adminMarketingReputation.bubalyChangedHowOurFamily')} className={`${inputCls} h-auto py-2 sm:col-span-2 lg:col-span-3`} rows={2} />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_published" className="h-4 w-4 accent-[var(--brand)]" /> {tr('adminMarketingReputation.publish')}</label>
          <button type="submit" className={`${btnCls} sm:col-span-2 lg:col-span-1`}>{tr('adminMarketingReputation.addTestimonial')}</button>
        </form>
        {tList.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">{tr('adminMarketingReputation.noTestimonialsYet')}</p>
        ) : (
          <div className="space-y-2">
            {tList.map((t) => (
              <div key={t.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">“{t.quote}”</p>
                  <p className="mt-1 text-xs text-muted">
                    {t.author_name}{t.author_role ? `, ${t.author_role}` : ''}{t.company ? ` · ${t.company}` : ''}
                    {t.rating ? ` · ${'★'.repeat(t.rating)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${t.is_published ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>
                    {t.is_published ? 'Live' : 'Draft'}
                  </span>
                  <form action={togglePublishTestimonialAction.bind(null, t.id, !t.is_published)}>
                    <button type="submit" className="text-muted hover:text-fg" title={t.is_published ? 'Unpublish' : 'Publish'}>
                      {t.is_published ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </form>
                  <form action={deleteTestimonialAction.bind(null, t.id)}>
                    <button type="submit" className="text-xs text-muted hover:text-rose-400">✕</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Case studies */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><BookOpenCheck className="h-4 w-4 text-brand-text" /> {tr('adminMarketingReputation.caseStudies')}</h2>
        <form action={saveCaseStudyAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder={tr('adminMarketingReputation.title')} className={`${inputCls} lg:col-span-2`} />
          <input name="customer_name" placeholder={tr('adminMarketingReputation.customer')} className={inputCls} />
          <input name="industry" placeholder={tr('adminMarketingReputation.industrySegment')} className={inputCls} />
          <input name="result_metric" placeholder={tr('adminMarketingReputation.resultEGSaved6Hrs')} className={`${inputCls} lg:col-span-2`} />
          <input name="summary" placeholder={tr('adminMarketingReputation.oneLineSummary')} className={`${inputCls} lg:col-span-2`} />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_published" className="h-4 w-4 accent-[var(--brand)]" /> {tr('adminMarketingReputation.publish')}</label>
          <button type="submit" className={`${btnCls} sm:col-span-2 lg:col-span-1`}>{tr('adminMarketingReputation.addCaseStudy')}</button>
        </form>
        {cList.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">{tr('adminMarketingReputation.noCaseStudiesYet')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="pb-2">{tr('adminMarketingReputation.title')}</th><th className="pb-2">{tr('adminMarketingReputation.customer')}</th><th className="pb-2">{tr('adminMarketingReputation.result')}</th><th className="pb-2">{tr('adminMarketingReputation.status')}</th><th className="pb-2">{tr('adminMarketingReputation.added')}</th><th className="pb-2"></th></tr>
              </thead>
              <tbody>
                {cList.map((c) => (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="py-2 font-medium">{c.title}<p className="text-xs text-muted">/{c.slug}</p></td>
                    <td className="py-2">{c.customer_name ?? '—'}</td>
                    <td className="py-2 text-xs text-muted">{c.result_metric ?? '—'}</td>
                    <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-[11px] ${c.is_published ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>{c.is_published ? 'Live' : 'Draft'}</span></td>
                    <td className="py-2 text-xs text-muted">{fmtDate(c.created_at)}</td>
                    <td className="py-2 text-right">
                      <form action={deleteCaseStudyAction.bind(null, c.id)}>
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">{tr('reputation.delete')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function AdminReputationReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reputation &amp; Trust</h1>
        <p className="mt-1 text-sm text-muted">{tr('reputation.manageTestimonialsAndCaseStudies')}</p>
      </div>
      <ErrorState message={tr('reputation.couldNotLoadReputationContent')} />
      <Link href="/admin/marketing/reputation" className="text-sm font-medium text-brand-text underline">{tr('reputation.refreshReputation')}</Link>
    </div>
  );
}
