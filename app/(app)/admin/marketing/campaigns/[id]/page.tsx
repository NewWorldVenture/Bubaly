import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { getMarketingCustomersWithError, evaluateSegment, type SegmentRules } from '@/lib/marketing/customers';
import { setCampaignStatus } from '../../actions';

export const metadata: Metadata = { title: 'Marketing · Campaign', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUSES = ['draft', 'scheduled', 'active', 'paused', 'completed', 'archived'];

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createServiceClient();
  const { data: c, error: campaignError } = await supabase.from('marketing_campaigns').select('*').eq('id', id).maybeSingle();
  if (campaignError) {
    console.error('[admin-marketing-campaign-detail] campaign read failed', campaignError);
    return <CampaignDetailReadError />;
  }
  if (!c) notFound();

  let audience = 0;
  let segmentName: string | null = null;
  if (c.segment_id) {
    const [segmentResult, customersResult] = await Promise.all([
      supabase.from('marketing_segments').select('name, rules').eq('id', c.segment_id).maybeSingle(),
      getMarketingCustomersWithError(supabase),
    ]);
    const readError = segmentResult.error ?? customersResult.error;
    if (readError) {
      console.error('[admin-marketing-campaign-detail] audience read failed', readError);
      return <CampaignDetailReadError />;
    }
    const seg = segmentResult.data;
    const { customers } = customersResult;
    if (seg) {
      segmentName = seg.name;
      audience = evaluateSegment(customers, (seg.rules ?? {}) as SegmentRules).length;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/admin/marketing/campaigns" className="text-sm text-muted hover:text-fg">← Back to campaigns</Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{c.name}</h1>
              <Badge tone="brand" className="capitalize">{c.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted capitalize">{c.channel} · {c.type.replace('_', ' ')}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{c.budget_cents > 0 ? fmtMoney(c.budget_cents) : '—'}</p>
            <p className="text-xs text-muted">budget</p>
          </div>
        </div>

        {c.objective && <p className="mt-4 text-sm">{c.objective}</p>}

        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-muted">Audience</p><p className="font-semibold">{segmentName ? `${audience}` : '—'}</p></div>
          <div><p className="text-xs text-muted">Segment</p><p className="font-semibold">{segmentName ?? 'None'}</p></div>
          <div><p className="text-xs text-muted">Starts</p><p className="font-semibold">{c.starts_at ? fmtDate(c.starts_at) : '—'}</p></div>
          <div><p className="text-xs text-muted">Ends</p><p className="font-semibold">{c.ends_at ? fmtDate(c.ends_at) : '—'}</p></div>
        </div>

        {c.notes && <p className="mt-4 whitespace-pre-wrap rounded-xl bg-surface/40 p-3 text-sm text-muted">{c.notes}</p>}
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Status</h2>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <form key={s} action={setCampaignStatus}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="status" value={s} />
              <button
                disabled={s === c.status}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition ${s === c.status ? 'cursor-default border-brand/40 bg-brand/15 text-brand-text' : 'border-border text-muted hover:bg-elevated hover:text-fg'}`}
              >
                {s}
              </button>
            </form>
          ))}
        </div>
      </Card>
    </div>
  );
}

function CampaignDetailReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Campaign</h1>
        <p className="mt-1 text-sm text-muted">Review campaign details, audience, and status.</p>
      </div>
      <ErrorState message="Could not load this marketing campaign from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/campaigns" className="text-sm font-medium text-brand-text underline">Back to campaigns</Link>
    </div>
  );
}
