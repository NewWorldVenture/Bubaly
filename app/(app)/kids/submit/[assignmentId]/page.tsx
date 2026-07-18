import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, Camera, Star } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { computeReward, DIFFICULTY_LABELS, fmtCash, type Difficulty } from '@/lib/chores/logic';
import { SubmitProofForm } from './submit-form';

export const metadata: Metadata = { title: 'Submit your work' };
export const dynamic = 'force-dynamic';

export default async function SubmitProofPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Distinguish a transient read failure from a genuinely missing assignment/chore:
  // throwing renders a retryable 5xx, whereas notFound() would tell a kid the chore
  // "doesn't exist" on a DB blip — a dead end for a chore they're trying to finish.
  const { data: assignment, error: assignmentError } = await supabase
    .from('chore_assignments').select('*').eq('id', assignmentId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (assignmentError) throw new Error(`Failed to load chore assignment "${assignmentId}": ${assignmentError.message}`);
  if (!assignment) notFound();
  const { data: chore, error: choreError } = await supabase.from('chores').select('*').eq('id', assignment.chore_id).maybeSingle();
  if (choreError) throw new Error(`Failed to load chore "${assignment.chore_id}": ${choreError.message}`);
  if (!chore) notFound();

  const proofKind = (chore.proof_required as string) ?? 'none';
  // Reward preview at a "great job" score so kids see the upside.
  const preview = computeReward(
    { reward_mode: (chore.reward_mode as 'fixed_points'), points: chore.points, points_min: chore.points_min, points_max: chore.points_max, cash_cents: chore.cash_cents, cash_min_cents: chore.cash_min_cents, cash_max_cents: chore.cash_max_cents },
    90,
  );

  return (
    <div className="mx-auto max-w-lg space-y-5 pt-2">
      <Link href="/kids" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> Back</Link>

      <div className="rounded-3xl bg-gradient-to-br from-brand/20 to-pink-500/20 p-5">
        <div className="text-4xl">{chore.icon ?? '🎯'}</div>
        <h1 className="mt-2 text-2xl font-black">{chore.title}</h1>
        {chore.instructions || chore.description ? <p className="mt-1 text-sm text-muted">{chore.instructions ?? chore.description}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {preview.type !== 'none' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-3 py-1 font-bold text-amber-300">
              <Star className="h-4 w-4" /> {preview.type === 'cash' ? `up to ${fmtCash(preview.cashCents)}` : `up to ${preview.points} pts`}
            </span>
          )}
          {chore.est_minutes ? <span className="inline-flex items-center gap-1 rounded-full bg-elevated px-3 py-1 text-muted"><Clock className="h-4 w-4" /> {chore.est_minutes} min</span> : null}
          <span className="inline-flex items-center gap-1 rounded-full bg-elevated px-3 py-1 text-muted">{DIFFICULTY_LABELS[(chore.difficulty as Difficulty) ?? 'medium']}</span>
        </div>
      </div>

      {proofKind !== 'none' ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 p-3 text-sm text-muted">
          <Camera className="h-5 w-5 text-brand-text" />
          {proofKind === 'video' ? 'Add a short video to show your work.' : proofKind === 'before_after' ? 'Add before and after photos.' : 'Add a photo to show your work.'}
        </div>
      ) : null}

      <SubmitProofForm assignmentId={assignmentId} proofKind={proofKind} />
    </div>
  );
}
