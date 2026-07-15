import type { Metadata } from 'next';
import Link from 'next/link';
import { BellRing, Send, AlertTriangle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { pushConfigured } from '@/lib/server/push';
import { summarizePush, canSendPush, deliveryRate } from '@/lib/marketing/push';
import { createPushCampaignAction, sendPushCampaignAction, deletePushCampaignAction } from './actions';

export const metadata: Metadata = { title: 'Marketing · Push', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Campaign = Tables<'marketing_push_campaigns'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral', sending: 'warning', sent: 'success', failed: 'danger',
};

export default async function PushPage() {
  const supabase = createServiceClient();
  const [campaignsResult, devicesResult] = await Promise.all([
    supabase.from('marketing_push_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(200),
    supabase.from('push_devices').select('id', { count: 'exact', head: true }).eq('enabled', true),
  ]);
  const readError = campaignsResult.error ?? devicesResult.error;
  if (readError) {
    console.error('[admin-marketing-push] push read failed', readError);
    return <AdminPushReadError />;
  }
  const { data } = campaignsResult;
  const { count: deviceCount } = devicesResult;
  const campaigns = (data ?? []) as Campaign[];
  const stats = summarizePush(campaigns);
  const cfg = pushConfigured();

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Broadcast a push to all opted-in devices (suppressed emails are excluded). Reuses the product&apos;s VAPID/FCM delivery.
      </p>

      {!cfg.web && !cfg.native && (
        <Card className="flex items-start gap-2 border-amber-500/30 bg-amber-500/5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p>Push delivery isn&apos;t configured (no VAPID/FCM keys). Campaigns will send but all devices will be <strong>skipped</strong> until keys are set.</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Opted-in devices', deviceCount ?? 0],
          ['Campaigns', stats.campaigns],
          ['Sent', stats.sentCampaigns],
          ['Delivery rate', `${stats.deliveryRate}%`],
        ].map(([label, val]) => (
          <Card key={String(label)} className="py-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-xl font-semibold">{val}</p>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><BellRing className="h-4 w-4 text-brand-text" /> New push</h2>
        <form action={createPushCampaignAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder="Title" className={`${inputCls} lg:col-span-2`} />
          <input name="url" placeholder="Click URL (e.g. /pricing)" className={`${inputCls} lg:col-span-2`} />
          <input name="body" placeholder="Body text" className={`${inputCls} lg:col-span-3`} />
          <button type="submit" className={btnCls}>Create draft</button>
        </form>
      </Card>

      {campaigns.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No push campaigns yet.</p>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <Card key={c.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">{c.title} <Badge tone={STATUS_TONE[c.status] ?? 'neutral'} className="capitalize">{c.status}</Badge></p>
                {c.body && <p className="mt-0.5 truncate text-xs text-muted">{c.body}</p>}
                <p className="mt-1 text-xs text-muted">
                  {c.status === 'sent'
                    ? `${c.sent}/${c.recipients} delivered (${deliveryRate(c.sent, c.recipients)}%)${c.skipped ? ` · ${c.skipped} skipped` : ''}${c.failed ? ` · ${c.failed} failed` : ''} · ${c.sent_at ? fmtDate(c.sent_at) : ''}`
                    : c.url ? `→ ${c.url}` : 'Draft'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                {canSendPush(c.status) && (
                  <form action={sendPushCampaignAction.bind(null, c.id)}>
                    <button type="submit" className="inline-flex items-center gap-1 font-semibold text-brand-text hover:underline">
                      <Send className="h-3.5 w-3.5" /> Send
                    </button>
                  </form>
                )}
                <form action={deletePushCampaignAction.bind(null, c.id)}>
                  <button type="submit" className="text-xs text-muted hover:text-rose-400">Delete</button>
                </form>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminPushReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Push</h1>
        <p className="mt-1 text-sm text-muted">Create and deliver consent-aware push campaigns.</p>
      </div>
      <ErrorState message="Could not load push campaigns from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/push" className="text-sm font-medium text-brand-text underline">Refresh push</Link>
    </div>
  );
}
