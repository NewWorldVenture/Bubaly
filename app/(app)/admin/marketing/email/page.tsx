import type { Metadata } from 'next';
import { Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createEmailDraft } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Email', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function EmailPage() {
  const supabase = createServiceClient();
  const [{ data: emails }, { data: segments }] = await Promise.all([
    supabase.from('marketing_email_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name'),
  ]);

  const providerReady = !!process.env.RESEND_API_KEY;

  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-3 rounded-2xl border p-4 text-sm ${providerReady ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}`}>
        {providerReady ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
        {providerReady
          ? <span>Email provider connected (Resend). Drafts can be reviewed and sent.</span>
          : <span><strong>No email provider configured.</strong> Set <code>RESEND_API_KEY</code> to enable sending. You can still draft campaigns now — sends will never be faked.</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {(emails ?? []).length === 0 ? (
            <EmptyState icon={Mail} title="No email campaigns yet" description="Draft your first email on the right." />
          ) : (
            (emails ?? []).map((e) => (
              <Card key={e.id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-semibold">{e.subject}</p>
                    <Badge tone={e.status === 'sent' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'} className="capitalize">{e.status}</Badge>
                  </div>
                  {e.preview_text && <p className="mt-0.5 truncate text-sm text-muted">{e.preview_text}</p>}
                  <p className="mt-1 text-xs text-muted">Created {fmtDate(e.created_at)}</p>
                </div>
                {e.status === 'sent' && (
                  <div className="shrink-0 text-right text-xs text-muted">
                    <p className="font-semibold text-fg">{e.recipients}</p> sent
                    <p className="mt-1">{e.opens} opens · {e.clicks} clicks</p>
                  </div>
                )}
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">New email draft</h2>
          <form action={createEmailDraft} className="space-y-3 text-sm">
            <input name="subject" required placeholder="Subject line" className={inputCls} />
            <input name="preview_text" placeholder="Preview text" className={inputCls} />
            <input name="from_name" placeholder="From name (optional)" className={inputCls} />
            <select name="segment_id" className={inputCls}>
              <option value="">All customers</option>
              {(segments ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <textarea name="body_html" rows={5} placeholder="Email body (HTML or text)…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Save draft</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
