import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { DEFAULT_REPUTATION } from '@/lib/marketing/reviews';
import { realTextOr } from '@/lib/marketing/reputation';
import { ReviewForm, type PublicLink } from './review-form';
import { getTranslations } from '@/lib/i18n/server';

// The tab title is copy like any other: it was English in every locale.
// Audit C1-S9-100.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.leaveAReview'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

export default async function NewReviewPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // Smaller answer: the external review links disappear, the internal review
  // form still works. Logged rather than raised. Audit C1-S9-45.
  const { data: s, error: settingsError } = await supabase.from('reputation_settings').select('*').eq('singleton', true).maybeSingle();
  if (settingsError) {
    console.warn('[reviews/new] reputation settings read failed; external links hidden', { error: settingsError.message });
  }

  // Each button is one whole sentence per platform: "on the App Store" and
  // "on Google" take different words in German or French, so the platform is
  // not spliced into an English "Review us on …". Audit C1-S9-100.
  const publicLinks: PublicLink[] = [
    s?.google_url ? { label: t('reviewsNew.reviewUsOnGoogle'), url: s.google_url } : null,
    s?.app_store_url ? { label: t('reviewsNew.reviewUsOnAppStore'), url: s.app_store_url } : null,
    s?.play_store_url ? { label: t('reviewsNew.reviewUsOnGooglePlay'), url: s.play_store_url } : null,
    s?.trustpilot_url ? { label: t('reviewsNew.reviewUsOnTrustpilot'), url: s.trustpilot_url } : null,
  ].filter((x): x is PublicLink => x !== null);

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center px-5 py-10">
      <div className="mb-6 text-center"><span className="text-lg font-bold tracking-tight">{t('reviewsNew.bubaly')}</span></div>
      <div className="glass-card p-6 sm:p-8">
        <ReviewForm
          // Seeder text in the settings row reads as the product talking to a
          // customer; each field falls back to the default instead.
          headline={realTextOr(s?.request_headline, t('reviewsNew.defaultHeadline'))}
          message={realTextOr(s?.request_message, t('reviewsNew.defaultMessage'))}
          minPublicRating={s?.min_public_rating ?? DEFAULT_REPUTATION.min_public_rating}
          thankYouHigh={realTextOr(s?.thank_you_high, t('reviewsNew.defaultThankYouHigh'))}
          thankYouLow={realTextOr(s?.thank_you_low, t('reviewsNew.defaultThankYouLow'))}
          publicLinks={publicLinks}
        />
      </div>
      <p className="mt-4 text-center text-[11px] text-muted">{t('reviewsNew.poweredByBubaly')}</p>
    </main>
  );
}
