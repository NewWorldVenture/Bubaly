import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardCheck, Sparkles, AlertTriangle, Trophy, Plus } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReviewCard, type ReviewItem } from './review-card';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Missions' };
export const dynamic = 'force-dynamic';

const REVIEW_STATUSES = ['pending', 'ai_reviewed', 'needs_improvement', 'parent_review', 'disputed'];

export default async function MissionsPage() {
  const t = await getTranslations();
  const ctx = await requireFeature('/missions');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Submissions awaiting a human decision + lookups.
  const { data: submissions, error: submissionsError } = await supabase
    .from('chore_submissions')
    .select('*')
    .eq('family_id', familyId)
    .in('status', REVIEW_STATUSES)
    .order('created_at', { ascending: false })
    .limit(60);

  // The approval queue is a parent's source of truth for pending kid proofs,
  // disputes and AI SAFETY FLAGS. A dropped read error here would render the
  // reassuring "All caught up! 🎉" empty state — a parent could miss a
  // safety-flagged submission because the page falsely says there's nothing to
  // review. Surface a retryable error instead of a false-empty queue.
  if (submissionsError) {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Trophy className="h-5 w-5 text-brand-text" />
          <div>
            <h1 className="text-lg font-bold">{t('missions.familyMissions')}</h1>
            <p className="text-xs text-muted">{t('missions.reviewProofApproveRewardsAndKeep')}</p>
          </div>
        </div>
        <ErrorState message={t('missions.couldnTLoadTheApproval')} />
      </div>
    );
  }

  const subs = submissions ?? [];
  const choreIds = [...new Set(subs.map((s) => s.chore_id).filter(Boolean))] as string[];
  const subIds = subs.map((s) => s.id);

  const [{ data: chores }, { data: members }, { data: validations }, { data: disputes }] = await Promise.all([
    choreIds.length ? settle(supabase.from('chores').select('*').in('id', choreIds)) : Promise.resolve({ data: [] }),
    settle(supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId)),
    subIds.length ? settle(supabase.from('chore_ai_validations').select('*').in('submission_id', subIds)) : Promise.resolve({ data: [] }),
    subIds.length ? settle(supabase.from('chore_disputes').select('*').in('submission_id', subIds).eq('status', 'open')) : Promise.resolve({ data: [] }),
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
    // A failed signing used to be indistinguishable from no proof at all.
    // `ReviewCard` renders the proof block only under `mediaUrls.length > 0`,
    // so a submission WITH `media_paths` whose signing failed showed no proof
    // section and no explanation — and this is the one screen whose entire job
    // is evidence review. A parent reviewing a `proof_required` mission would
    // see what looks like a proof-less submission and approve it, releasing
    // points or real cash.
    //
    // The page already KNOWS `media_paths` was non-empty; that is precisely the
    // information that was being thrown away. Counting what could not be signed
    // costs nothing and turns a silent gap into a stated one. Audit C1-S9-29.
    const expectedProof = (s.media_paths ?? []).slice(0, 4);
    const mediaUrls: string[] = [];
    for (const path of expectedProof) {
      // The gap is already STATED below (proofUnavailable); the error was the
      // one thing still dropped. Audit C1-S9-71.
      const { data, error: signError } = await supabase.storage.from('chore-proof').createSignedUrl(path, 600);
      if (signError) console.error('[missions] proof signing failed', { submissionId: s.id, error: signError.message });
      if (data?.signedUrl) mediaUrls.push(data.signedUrl);
    }
    const proofUnavailable = expectedProof.length > mediaUrls.length;
    const v = valBySub.get(s.id);
    items.push({
      proofUnavailable,
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
          <h1 className="text-lg font-bold">{t('missions.familyMissions')}</h1>
          <p className="text-xs text-muted">{t('missions.reviewProofApproveRewardsAndKeep')}</p>
        </div>
        <Link href="/missions/new" className="ml-auto inline-flex h-9 items-center gap-1 rounded-xl bg-brand px-3 text-sm font-medium text-brand-fg">
          <Plus className="h-4 w-4" /> {t('missions.newMission')}
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><p className="text-xs font-medium text-muted">{t('missions.awaitingReview')}</p><p className="mt-1 text-3xl font-bold leading-none">{items.length}</p></Card>
        <Card><p className="text-xs font-medium text-muted">{t('missions.disputes')}</p><p className="mt-1 text-3xl font-bold leading-none">{disputeCount}</p></Card>
        <Card><p className="text-xs font-medium text-muted">{t('missions.safetyFlags')}</p><p className="mt-1 text-3xl font-bold leading-none">{safetyCount}</p></Card>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="h-4 w-4 text-brand-text" /> {t('missions.approvalQueue')}
        </h2>
        {items.length === 0 ? (
          <EmptyState icon={Sparkles} title={t('missions.allCaughtUp')} description={t('missions.noSubmissionsAreWaitingFor')} />
        ) : (
          <div className="space-y-3">{items.map((i) => <ReviewCard key={i.submissionId} item={i} />)}</div>
        )}
      </section>

      {safetyCount > 0 && (
        <p className="flex items-center gap-2 text-xs text-warning"><AlertTriangle className="h-4 w-4" /> {t('missions.someSubmissionsHaveAiSafetyFlags')}</p>
      )}
    </div>
  );
}
