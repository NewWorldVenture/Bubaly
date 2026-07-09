// lib/marketplace/server.ts — where the marketplace's pure engines meet Supabase.
// Server-only loaders that read real rows (reviews, verifications) and run them
// through the tested engines (reviews, trust) to produce the values the UI shows:
// a member's rating summary + trust score/badges. Degrades to safe empties on any
// read error so a profile still renders.

import type { SupabaseClient } from '@supabase/supabase-js';
import { aggregateReviews, toTrustRatingSignals, type ReviewInput, type ReviewSummary } from './reviews';
import { computeTrustScore, type TrustResult, type TrustSignals, type VerificationKind } from './trust';

// Accept any Supabase client (server or service-role); the caller owns auth/RLS.
type DB = Pick<SupabaseClient, 'from'>;

const VERIFICATION_KINDS: readonly VerificationKind[] = ['email', 'phone', 'payment_method', 'identity', 'address', 'community'];
const asVerificationKind = (k: string): VerificationKind | null =>
  (VERIFICATION_KINDS as readonly string[]).includes(k) ? (k as VerificationKind) : null;

export interface MemberTrustProfile {
  reviews: ReviewSummary;
  trust: TrustResult;
}

/**
 * Load a member's public trust profile: aggregate the reviews they've received
 * and combine them with their verified badges + extra signals into a trust score.
 * `signals` lets the caller pass counts it already has (completed transactions,
 * disputes, cancellations, response time) so we don't re-query them here.
 */
export async function loadMemberTrust(
  sb: DB,
  args: { familyId: string; userId?: string | null; memberId?: string | null; signals?: Partial<TrustSignals> },
): Promise<MemberTrustProfile> {
  const empty: MemberTrustProfile = {
    reviews: aggregateReviews([]),
    trust: computeTrustScore({ ...(args.signals ?? {}) }),
  };
  if (!args.userId && !args.memberId) return empty;

  const [reviewRes, verifRes] = await Promise.all([
    args.userId
      ? sb.from('marketplace_reviews').select('rating, role, body, created_at').eq('reviewee_user_id', args.userId)
      : Promise.resolve({ data: [], error: null }),
    sb.from('marketplace_verifications')
      .select('kind, status')
      .eq('family_id', args.familyId)
      .eq('status', 'verified')
      .eq(args.memberId ? 'member_id' : 'user_id', (args.memberId ?? args.userId) as string),
  ]);

  if (reviewRes.error || verifRes.error) {
    console.error('[marketplace] trust load failed', reviewRes.error ?? verifRes.error);
    return empty;
  }

  const reviews = aggregateReviews(
    (reviewRes.data ?? []).map((r): ReviewInput => ({ rating: Number(r.rating), role: r.role, body: r.body, createdAt: r.created_at })),
  );
  const verifications = (verifRes.data ?? [])
    .map((v) => asVerificationKind(v.kind))
    .filter((k): k is VerificationKind => k !== null);

  const trust = computeTrustScore({
    ...toTrustRatingSignals(reviews),
    verifications,
    ...(args.signals ?? {}),
  });

  return { reviews, trust };
}
