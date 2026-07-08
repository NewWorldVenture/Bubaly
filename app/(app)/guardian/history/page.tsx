import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { CallHistory } from '@/components/guardian/call-history';
import { Clock, ArrowLeft } from 'lucide-react';

export const metadata: Metadata = { title: 'Communication History · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  const pageNum = parseInt(page ?? '1', 10);
  const pageSize = 50;
  const offset = (pageNum - 1) * pageSize;

  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const { data: communications, count } = await (db.from('guardian_communications') as ReturnType<typeof supabase.from>)
    .select(
      'id, comm_type, direction, from_number, to_number, from_name, body, summary, sentiment, trust_level_at_time, routing_mode_used, ai_decision_reason, scam_detected, scam_type, scam_confidence, call_duration_secs, call_recording_url, status, started_at, ended_at',
      { count: 'exact' },
    )
    .eq('family_id', familyId)
    .order('started_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  const totalPages = Math.ceil((count ?? 0) / pageSize);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-purple-500/15">
          <Clock className="h-5 w-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">Communication History</h1>
          <p className="text-sm text-muted">{count ?? 0} total</p>
        </div>
      </div>

      <CallHistory
        communications={(communications ?? []) as unknown as Parameters<typeof CallHistory>[0]['communications']}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          {pageNum > 1 && (
            <a
              href={`/guardian/history?page=${pageNum - 1}`}
              className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface transition"
            >
              Previous
            </a>
          )}
          <span className="text-sm text-muted">Page {pageNum} of {totalPages}</span>
          {pageNum < totalPages && (
            <a
              href={`/guardian/history?page=${pageNum + 1}`}
              className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface transition"
            >
              Next
            </a>
          )}
        </div>
      )}
    </div>
  );
}
