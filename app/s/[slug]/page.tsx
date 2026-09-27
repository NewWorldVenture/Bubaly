import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { SurveyForm } from './survey-form';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Share your feedback · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function PublicSurveyPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = await getTranslations();
  const { slug } = await params;
  const supabase = createServiceClient();
  // `closed` is computed from `!survey`, so a refused read told respondents the
  // survey was closed. A public survey that turns people away loses the
  // responses it exists to collect, and nobody comes back. Audit C1-S9-45.
  const { data: survey, error: surveyError } = await supabase
    .from('surveys')
    .select('slug, name, question, scale_min, scale_max, low_label, high_label, follow_up_question, thank_you_message, status')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (surveyError) {
    console.error('[survey] survey read failed', { slug, error: surveyError.message });
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-xl flex-col items-center justify-center gap-3 px-5 py-10 text-center">
        <h1 className="text-xl font-bold">{t('survey.weCouldNotLoadThisSurvey')}</h1>
        <p className="text-sm text-muted">{t('survey.pleaseRefreshInAMoment')}</p>
      </main>
    );
  }

  const closed = !survey || survey.status !== 'active';

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center px-5 py-10">
      <div className="mb-6 text-center">
        <span className="text-lg font-bold tracking-tight">{t('s.bubaly')}</span>
      </div>
      <div className="glass-card p-6 sm:p-8">
        {closed ? (
          <div className="text-center">
            <h1 className="text-xl font-semibold">{t('s.thisSurveyIsntAvailable')}</h1>
            <p className="mt-1 text-sm text-muted">{t('s.itMayHaveClosedOrThe')}</p>
          </div>
        ) : (
          <SurveyForm
            slug={survey.slug}
            question={survey.question}
            scaleMin={survey.scale_min}
            scaleMax={survey.scale_max}
            lowLabel={survey.low_label}
            highLabel={survey.high_label}
            followUp={survey.follow_up_question}
            thankYou={survey.thank_you_message}
          />
        )}
      </div>
      <p className="mt-4 text-center text-[11px] text-muted">{t('s.poweredByBubaly')}</p>
    </main>
  );
}
