import type { Metadata } from 'next';
import { Star } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { ratingSummary } from '@/lib/marketplace/trust';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Reviews · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex" aria-label={`${n} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn('h-3.5 w-3.5', i <= n ? 'fill-current text-amber-500' : 'text-border')} />
      ))}
    </span>
  );
}

export default async function MarketplaceReviewsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const selfId = ctx.active.member.id;

  const { data: reviews, error: reviewsError } = await sb
    .from('marketplace_reviews')
    .select('id, reviewer_member, reviewee_member, role, rating, comment, created_at, listing_id')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(200);

  // Reviews drive a member's marketplace reputation. A dropped read error would
  // render "No reviews received yet" + "None yet" — the user's rating appears to
  // vanish on a transient failure. Surface a retryable error instead.
  if (reviewsError) {
    return (
      <div>
        <PageHeader title={t('marketplaceReviews.reviews')} description="Two-sided reviews — both parties rate every completed exchange." />
        <ErrorState message="Couldn’t load your reviews. Refresh and try again." />
      </div>
    );
  }

  const received = (reviews ?? []).filter((r) => r.reviewee_member === selfId);
  const given = (reviews ?? []).filter((r) => r.reviewer_member === selfId);
  const summary = ratingSummary(received.map((r) => r.rating));

  const { data: members } = await sb.from('family_members').select('id, display_name').eq('family_id', ctx.active.familyId);
  const nameOf = (id: string | null) => members?.find((m) => m.id === id)?.display_name ?? 'Someone';

  const Section = ({ title, rows, whoOf }: { title: string; rows: typeof received; whoOf: (r: (typeof received)[number]) => string }) => (
    <section className="mt-5">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted">None yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-border bg-surface/60 p-3.5">
              <div className="flex items-center gap-2">
                <Stars n={r.rating} />
                <span className="text-xs text-muted">{whoOf(r)} · as {r.role}</span>
              </div>
              {r.comment && <p className="mt-1.5 text-sm text-fg">“{r.comment}”</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div>
      <PageHeader title={t('marketplaceReviews.reviews')} description="Two-sided reviews — both parties rate every completed exchange." />
      <div className="rounded-2xl border border-border bg-surface/60 p-4">
        <p className="text-sm font-semibold">{t('marketplaceReviews.yourRating')}</p>
        {summary.count === 0 ? (
          <p className="mt-1 text-xs text-muted">{t('marketplaceReviews.noReviewsReceivedYetCompleteAn')}</p>
        ) : (
          <p className="mt-1 flex items-center gap-2 text-sm">
            <span className="text-xl font-bold text-amber-500">★ {summary.avg.toFixed(1)}</span>
            <span className="text-xs text-muted">from {summary.count} review{summary.count === 1 ? '' : 's'}</span>
          </p>
        )}
      </div>
      <Section title={t('marketplaceReviews.received')} rows={received} whoOf={(r) => `from ${nameOf(r.reviewer_member)}`} />
      <Section title={t('marketplaceReviews.given')} rows={given} whoOf={(r) => `to ${nameOf(r.reviewee_member)}`} />
    </div>
  );
}
