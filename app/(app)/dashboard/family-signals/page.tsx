import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { FamilySignalsModule, type SignalView } from '@/components/modules/family-signals-module';

export const metadata: Metadata = { title: 'Family Intelligence' };

export default async function FamilySignalsPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data } = await supabase
    .from('family_signals')
    .select('id, kind, title, detail, score, evidence, status, last_seen_at')
    .eq('family_id', ctx.active.familyId)
    .order('score', { ascending: false })
    .limit(200);

  const rows = (data ?? []) as {
    id: string; kind: string; title: string; detail: string | null;
    score: number; evidence: Record<string, unknown> | null; status: string; last_seen_at: string;
  }[];
  const toView = (r: (typeof rows)[number]): SignalView => ({
    id: r.id, kind: r.kind, title: r.title, detail: r.detail,
    score: r.score, evidence: r.evidence ?? {}, status: r.status, lastSeenAt: r.last_seen_at,
  });

  const active = rows.filter((r) => r.status === 'active').map(toView);
  const hidden = rows.filter((r) => r.status !== 'active').map(toView);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <FamilySignalsModule active={active} hidden={hidden} />
    </div>
  );
}
