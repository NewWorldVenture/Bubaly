import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardCheck, Sparkles, AlertTriangle, Trophy, Plus } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { ReviewCard, type ReviewItem } from './review-card';

export const metadata: Metadata = { title: 'Family Missions' };
export const dynamic = 'force-dynamic';

const REVIEW_STATUSES = ['pending', 'ai_reviewed', 'needs_improvement', 'parent_review', 'disputed'];

export default async function MissionsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Submissions awaiting a human decision + lookups.
  const { data: submissions } = await supabase
    .from('chore_submissions')
    .select('*')
    .eq('family_id', familyId)
    .in('status', REVIEW_STATUSES)
    .order('created_at', { ascending: false })
    .limit(60);

  const subs = submissions ?? [];
  const choreIds = [...new Set(subs.map((s) => s.chore_id).filter(Boolean))] as string[];
  const subIds = subs.map((s) => s.id);

  const [{ data: chores }, { data: members }, { data: validations }, { data: disputes }] = await Promise.all([
    choreIds.length ? supabase.from('chores').select('*').in('id', choreIds) : Promise.resolve({ data: [] }),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    subIds.length ? supabase.from('chore_ai_validations').select('*').in('submission_id', subIds) : Promise.resolve({ data: [] }),
    subIds.length ? supabase.from('chore_disputes').select('*').in('submission_id', subIds).eq('status', 'open') : Promise.resolve({ data: [] }),
  ]);

  const choreById = new Map((chores ?? []).map((c) => [c.id, c]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const valBySub = new Map((validations ?? []).map((v) => [v.submission_id, v]));
  const disputeBySub = new Map((disputes ?? []).map((d) => [d.submission_id, d]));

  // Build signed URLs for proof media (private bucket).
  const items: ReviewItem[] = [];
  for (const s of subs) {
    const chore = choreById.get(s.chore_id ?? '');
    const member = memberById.get(s.member_id);
    const mediaUrls: string[] = [];
    for (const path of (s.media_paths ?? []).slice(0, 4)) {
      const { data } = await supabase.storage.from('chore-proof').createSignedUrl(path, 600);
      if (data?.signedUrl) mediaUrls.push(data.signedUrl);
    }
    const v = valBySub.get(s.id);
    items.push({
      submissionId: s.id,
      choreTitle: chore?.title ?? 'Chore',
      instructions: chore?.instructions ?? chore?.description ?? null,
      memberName: member?.display_name ?? 'Child',
      memberColor: member?.color ?? null,
      note: s.note,
      status: s.status,
      mediaUrls,
      aiScore: v?.quality_score ?? null,
      aiStatus: v?.status ?? null,
      aiKidFeedback: v?.kid_feedback ?? null,
      aiParentSummary: v?.parent_summary ?? null,
      aiIsFallback: v?.is_fallback ?? false,
      safetyFlags: Array.isArray(v?.safety_flags) ? (v!.safety_flags as string[]) : [],
      recommendedType: v?.recommended_reward_type ?? null,
      recommendedAmount: v?.recommended_reward_amount ?? null,
      rewardMode: chore?.reward_mode ?? 'fixed_points',
      defaultPoints: chore?.points ?? 0,
      isDisputed: disputeBySub.has(s.id),
      disputeReason: disputeBySub.get(s.id)?.reason ?? null,
    });
  }

  const disputeCount = items.filter((i) => i.isDisputed).length;
  const safetyCount = items.filter((i) => i.safetyFlags.length > 0).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Trophy className="h-5 w-5 text-brand-text" />
        <div>
          <h1 className="text-lg font-bold">Family Missions</h1>
          <p className="text-xs text-muted">Review proof, approve rewards, and keep chores fair.</p>
        </div>
        <Link href="/missions/new" className="ml-auto inline-flex h-9 items-center gap-1 rounded-xl bg-brand px-3 text-sm font-medium text-brand-fg">
          <Plus className="h-4 w-4" /> New mission
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><p className="text-xs font-medium text-muted">Awaiting review</p><p className="mt-1 text-3xl font-bold leading-none">{items.length}</p></Card>
        <Card><p className="text-xs font-medium text-muted">Disputes</p><p className="mt-1 text-3xl font-bold leading-none">{disputeCount}</p></Card>
        <Card><p className="text-xs font-medium text-muted">Safety flags</p><p className="mt-1 text-3xl font-bold leading-none">{safetyCount}</p></Card>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="h-4 w-4 text-brand-text" /> Approval queue
        </h2>
        {items.length === 0 ? (
          <EmptyState icon={Sparkles} title="All caught up! 🎉" description="No submissions are waiting for your review." />
        ) : (
          <div className="space-y-3">{items.map((i) => <ReviewCard key={i.submissionId} item={i} />)}</div>
        )}
      </section>

      {safetyCount > 0 && (
        <p className="flex items-center gap-2 text-xs text-warning"><AlertTriangle className="h-4 w-4" /> Some submissions have AI safety flags — please review those first.</p>
      )}
    </div>
  );
}
