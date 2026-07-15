import type { Metadata } from 'next';
import Link from 'next/link';
import { Star, MessageSquareQuote, Settings2, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ratingStats, DEFAULT_REPUTATION } from '@/lib/marketing/reviews';
import { ReviewRow } from './review-row';
import { saveReputationSettingsAction } from './actions';

export const metadata: Metadata = { title: 'Marketing · Reviews', robots: { index: false } };
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';
const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const FILTERS = ['all', 'pending', 'approved', 'featured', 'rejected'] as const;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const active = (FILTERS as readonly string[]).includes(status ?? '') ? status! : 'all';
  const supabase = createServiceClient();

  const [reviewsResult, settingsResult] = await Promise.all([
    supabase.from('reviews').select('*').is('deleted_at', null).order('submitted_at', { ascending: false }).limit(500),
    supabase.from('reputation_settings').select('*').eq('singleton', true).maybeSingle(),
  ]);
  const readError = reviewsResult.error ?? settingsResult.error;
  if (readError) {
    console.error('[admin-marketing-reviews] review read failed', readError);
    return <AdminReviewsReadError />;
  }
  const { data: all } = reviewsResult;
  const { data: settings } = settingsResult;
  const rows = all ?? [];
  const stats = ratingStats(rows.map((r) => r.rating));
  const filtered = active === 'all' ? rows : rows.filter((r) => r.status === active);
  const reviewUrl = `${SITE_URL}/reviews/new`;
  const set = settings ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <MessageSquareQuote className="h-5 w-5 text-brand-text" />
        <div>
          <h2 className="text-base font-bold">Reviews &amp; Reputation</h2>
          <p className="text-xs text-muted">Collect star reviews, reply, feature the best, and route happy customers to public platforms.</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium text-muted">Average rating</p>
          <p className="mt-1 text-3xl font-bold leading-none">{stats.total ? stats.average : '—'}</p>
          <p className="mt-1 text-xs text-muted">{stats.total} review{stats.total === 1 ? '' : 's'} · {stats.positivePct}% positive</p>
        </Card>
        <Card className="sm:col-span-2">
          <p className="mb-2 text-xs font-medium text-muted">Distribution</p>
          <div className="space-y-1">
            {stats.distribution.map((d) => (
              <div key={d.star} className="flex items-center gap-2 text-xs">
                <span className="inline-flex w-8 items-center gap-0.5">{d.star}<Star className="h-3 w-3 fill-amber-400 text-amber-400" /></span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated"><div className="h-full rounded-full bg-amber-400" style={{ width: `${d.pct}%` }} /></div>
                <span className="w-8 text-right text-muted">{d.count}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Share link */}
      <Card>
        <p className="text-xs font-medium text-muted">Public review link &amp; wall</p>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <a href={reviewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text underline">{reviewUrl} <ExternalLink className="h-3.5 w-3.5" /></a>
          <a href={`${SITE_URL}/reviews`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted underline">View public wall <ExternalLink className="h-3.5 w-3.5" /></a>
        </div>
      </Card>

      {/* Filters + list */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f} href={f === 'all' ? '/admin/marketing/reviews' : `/admin/marketing/reviews?status=${f}`}
            className={`rounded-lg px-3 py-1 text-sm font-medium capitalize ${active === f ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'}`}>
            {f}{f !== 'all' ? ` (${rows.filter((r) => r.status === f).length})` : ''}
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={MessageSquareQuote} title="No reviews here" description="Share your review link to start collecting feedback." />
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => <ReviewRow key={r.id} review={r} />)}
        </div>
      )}

      {/* Reputation settings */}
      <Card>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4 text-brand-text" /> Reputation settings</h3>
        <form action={saveReputationSettingsAction} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">Google review URL</span><input name="google_url" defaultValue={set?.google_url ?? ''} className={inputCls} placeholder="https://g.page/r/…/review" /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">App Store URL</span><input name="app_store_url" defaultValue={set?.app_store_url ?? ''} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">Google Play URL</span><input name="play_store_url" defaultValue={set?.play_store_url ?? ''} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">Trustpilot URL</span><input name="trustpilot_url" defaultValue={set?.trustpilot_url ?? ''} className={inputCls} /></label>
          <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">Request headline</span><input name="request_headline" defaultValue={set?.request_headline ?? DEFAULT_REPUTATION.request_headline} className={inputCls} /></label>
          <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">Request message</span><input name="request_message" defaultValue={set?.request_message ?? DEFAULT_REPUTATION.request_message} className={inputCls} /></label>
          <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">Thank-you (happy reviewers)</span><input name="thank_you_high" defaultValue={set?.thank_you_high ?? DEFAULT_REPUTATION.thank_you_high} className={inputCls} /></label>
          <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">Thank-you (critical reviewers)</span><input name="thank_you_low" defaultValue={set?.thank_you_low ?? DEFAULT_REPUTATION.thank_you_low} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">Min rating to invite public review</span><input type="number" min="1" max="5" name="min_public_rating" defaultValue={set?.min_public_rating ?? 4} className={inputCls} /></label>
          <label className="space-y-1"><span className="block text-xs font-medium text-muted">Auto-approve at/above (blank = manual)</span><input type="number" min="1" max="5" name="auto_approve_min" defaultValue={set?.auto_approve_min ?? ''} className={inputCls} /></label>
          <div className="sm:col-span-2"><button className="inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg">Save settings</button></div>
        </form>
      </Card>
    </div>
  );
}

function AdminReviewsReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reviews &amp; Reputation</h1>
        <p className="mt-1 text-sm text-muted">Collect, review, and publish customer feedback.</p>
      </div>
      <ErrorState message="Could not load reviews from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/reviews" className="text-sm font-medium text-brand-text underline">Refresh reviews</Link>
    </div>
  );
}
