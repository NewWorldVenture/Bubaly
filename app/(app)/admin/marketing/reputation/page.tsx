import type { Metadata } from 'next';
import { Quote, BookOpenCheck, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import {
  saveTestimonialAction, togglePublishTestimonialAction, deleteTestimonialAction,
  saveCaseStudyAction, deleteCaseStudyAction,
} from './actions';

export const metadata: Metadata = { title: 'Reputation & Trust', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Testimonial = Tables<'testimonials'>;
type CaseStudy = Tables<'case_studies'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

export default async function ReputationPage() {
  const supabase = createServiceClient();
  const [{ data: testimonials }, { data: caseStudies }] = await Promise.all([
    supabase.from('testimonials').select('*').order('sort_order').order('created_at', { ascending: false }).limit(200),
    supabase.from('case_studies').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  const tList = (testimonials ?? []) as Testimonial[];
  const cList = (caseStudies ?? []) as CaseStudy[];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">Curated social proof — published testimonials and case studies that power conversions and enterprise sales.</p>

      {/* Testimonials */}
      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Quote className="h-4 w-4 text-brand" /> Testimonials</h2>
        <form action={saveTestimonialAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="author_name" required placeholder="Author name" className={inputCls} />
          <input name="author_role" placeholder="Role (e.g. Mom of 3)" className={inputCls} />
          <input name="company" placeholder="Company / city" className={inputCls} />
          <input name="rating" type="number" min="1" max="5" placeholder="Rating 1–5" className={inputCls} />
          <textarea name="quote" required placeholder="“Bubaly changed how our family…”" className={`${inputCls} h-auto py-2 sm:col-span-2 lg:col-span-3`} rows={2} />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_published" className="h-4 w-4 accent-[var(--brand)]" /> Publish</label>
          <button type="submit" className={`${btnCls} sm:col-span-2 lg:col-span-1`}>Add testimonial</button>
        </form>
        {tList.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No testimonials yet.</p>
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
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><BookOpenCheck className="h-4 w-4 text-brand" /> Case studies</h2>
        <form action={saveCaseStudyAction} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder="Title" className={`${inputCls} lg:col-span-2`} />
          <input name="customer_name" placeholder="Customer" className={inputCls} />
          <input name="industry" placeholder="Industry / segment" className={inputCls} />
          <input name="result_metric" placeholder="Result (e.g. Saved 6 hrs/week)" className={`${inputCls} lg:col-span-2`} />
          <input name="summary" placeholder="One-line summary" className={`${inputCls} lg:col-span-2`} />
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" name="is_published" className="h-4 w-4 accent-[var(--brand)]" /> Publish</label>
          <button type="submit" className={`${btnCls} sm:col-span-2 lg:col-span-1`}>Add case study</button>
        </form>
        {cList.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No case studies yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="pb-2">Title</th><th className="pb-2">Customer</th><th className="pb-2">Result</th><th className="pb-2">Status</th><th className="pb-2">Added</th><th className="pb-2"></th></tr>
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
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">Delete</button>
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
