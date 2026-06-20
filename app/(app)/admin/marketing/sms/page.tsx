import type { Metadata } from 'next';
import { MessageSquare, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createSmsDraft } from '../actions';

export const metadata: Metadata = { title: 'Marketing · SMS', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function SmsPage() {
  const supabase = createServiceClient();
  const [{ data: sms }, { data: segments }] = await Promise.all([
    supabase.from('marketing_sms_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name'),
  ]);
  const ready = !!process.env.TWILIO_AUTH_TOKEN;

  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-3 rounded-2xl border p-4 text-sm ${ready ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}`}>
        {ready ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
        {ready
          ? <span>SMS provider connected. Only SMS-consented contacts will receive messages.</span>
          : <span><strong>No SMS provider configured.</strong> Set <code>TWILIO_AUTH_TOKEN</code> to enable sending. Draft now — sends are never faked, and require valid opt-in consent.</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {(sms ?? []).length === 0 ? (
            <EmptyState icon={MessageSquare} title="No SMS campaigns yet" description="Draft your first message on the right." />
          ) : (
            (sms ?? []).map((s) => (
              <Card key={s.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{s.message}</p>
                  <p className="mt-1 text-xs text-muted">Created {fmtDate(s.created_at)}{s.recipients ? ` · ${s.recipients} sent` : ''}</p>
                </div>
                <Badge tone={s.status === 'sent' ? 'success' : 'neutral'} className="capitalize">{s.status}</Badge>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">New SMS draft</h2>
          <form action={createSmsDraft} className="space-y-3 text-sm">
            <select name="segment_id" className={inputCls}>
              <option value="">SMS-consented contacts</option>
              {(segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}
            </select>
            <textarea name="message" required maxLength={320} rows={4} placeholder="Message (keep under 160 chars; include opt-out)…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <p className="text-xs text-muted">Always include “Reply STOP to opt out.”</p>
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Save draft</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
