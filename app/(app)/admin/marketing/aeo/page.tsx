import type { Metadata } from 'next';
import { MessagesSquare } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { addAeoQuestion } from '../actions';

export const metadata: Metadata = { title: 'Marketing · AEO', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PATTERNS = ['what_is', 'how_to', 'best_x_for_y', 'comparison', 'faq', 'local'];

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'brand' | 'success'> = {
  opportunity: 'warning', drafting: 'neutral', answered: 'brand', published: 'success',
};

export default async function AeoPage() {
  const supabase = createServiceClient();
  const { data: questions } = await supabase.from('marketing_aeo_questions').select('*').order('created_at', { ascending: false });

  const rows = questions ?? [];
  const answered = rows.filter((q) => q.status === 'answered' || q.status === 'published').length;
  const readiness = rows.length > 0 ? Math.round((answered / rows.length) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Answer Engine Optimization prepares your content for ChatGPT, Perplexity, Google AI Overviews, and voice assistants.
        Track the questions customers ask and publish clear, structured answers. We never claim AI-engine rankings without real tracking data.
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Card><p className="text-xs text-muted">Questions</p><p className="text-2xl font-bold">{rows.length}</p></Card>
            <Card><p className="text-xs text-muted">Answered</p><p className="text-2xl font-bold">{answered}</p></Card>
            <Card><p className="text-xs text-muted">Readiness</p><p className="text-2xl font-bold">{readiness}%</p></Card>
          </div>

          {rows.length === 0 ? (
            <EmptyState icon={MessagesSquare} title="No questions tracked" description="Capture the questions your customers ask AI engines." />
          ) : (
            <div className="space-y-2">
              {rows.map((q) => (
                <Card key={q.id}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{q.question}</p>
                    <Badge tone={STATUS_TONE[q.status] ?? 'neutral'} className="shrink-0 capitalize">{q.status}</Badge>
                  </div>
                  {q.answer && <p className="mt-2 text-sm text-muted">{q.answer}</p>}
                  {q.pattern && <p className="mt-2 text-xs text-muted">Pattern: {q.pattern.replace(/_/g, ' ')}{q.entity ? ` · ${q.entity}` : ''}</p>}
                </Card>
              ))}
            </div>
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">Add a question</h2>
          <form action={addAeoQuestion} className="space-y-3 text-sm">
            <input name="question" required placeholder="What is the best family organizer app?" className={inputCls} />
            <select name="pattern" className={inputCls}><option value="">Pattern (optional)</option>{PATTERNS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}</select>
            <input name="entity" placeholder="Entity (e.g. FamilyOS)" className={inputCls} />
            <textarea name="answer" rows={4} placeholder="Structured answer draft…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Add question</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
