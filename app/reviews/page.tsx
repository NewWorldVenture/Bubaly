import type { Metadata } from 'next';
import Link from 'next/link';
import { Star } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { ratingStats, PUBLIC_STATUSES, stars } from '@/lib/marketing/reviews';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Reviews · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function ReviewsWallPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: reviews } = await supabase
    .from('reviews')
    .select('id, rating, title, body, author_name, reply, submitted_at, status')
    .in('status', PUBLIC_STATUSES)
    .is('deleted_at', null)
    .order('status', { ascending: false }) // 'featured' before 'approved'
    .order('submitted_at', { ascending: false })
    .limit(200);

  const rows = reviews ?? [];
  const s = ratingStats(rows.map((r) => r.rating));

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <div className="text-center">
        <p className="text-lg font-bold tracking-tight">{t('reviews.bubaly')}</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{t('reviews.whatFamiliesSay')}</h1>
        {s.total > 0 && (
          <div className="mt-2 flex items-center justify-center gap-2 text-amber-400">
            <span className="text-lg" aria-hidden>{stars(s.average)}</span>
            <span className="text-sm text-muted">{s.average} from {s.total} review{s.total === 1 ? '' : 's'}</span>
          </div>
        )}
        <Link href="/reviews/new" className="mt-4 inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg">{t('reviews.writeAReview')}</Link>
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">{t('reviews.noReviewsYetBeTheFirst')}</p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.id} className="glass-card p-4">
              <div className="flex items-center gap-1 text-amber-400" aria-label={`${r.rating} stars`}>
                {[1, 2, 3, 4, 5].map((v) => <Star key={v} className={`h-4 w-4 ${v <= r.rating ? 'fill-amber-400' : 'text-border'}`} />)}
              </div>
              {r.title && <p className="mt-2 font-semibold">{r.title}</p>}
              {r.body && <p className="mt-1 text-sm text-muted">{r.body}</p>}
              <p className="mt-2 text-xs text-muted">— {r.author_name || 'A Bubaly family'}</p>
              {r.reply && (
                <div className="mt-3 rounded-lg border border-border bg-elevated/50 p-2 text-xs">
                  <p className="font-medium text-brand-text">Bubaly replied</p>
                  <p className="mt-0.5 text-muted">{r.reply}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
