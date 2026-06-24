import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { SurveyForm } from './survey-form';

export const metadata: Metadata = { title: 'Share your feedback · Bubaly', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function PublicSurveyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = createServiceClient();
  const { data: survey } = await supabase
    .from('surveys')
    .select('slug, name, question, scale_min, scale_max, low_label, high_label, follow_up_question, thank_you_message, status')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  const closed = !survey || survey.status !== 'active';

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-xl flex-col justify-center px-5 py-10">
      <div className="mb-6 text-center">
        <span className="text-lg font-bold tracking-tight">Bubaly</span>
      </div>
      <div className="glass-card p-6 sm:p-8">
        {closed ? (
          <div className="text-center">
            <h1 className="text-xl font-semibold">This survey isn’t available</h1>
            <p className="mt-1 text-sm text-muted">It may have closed or the link is incorrect.</p>
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
      <p className="mt-4 text-center text-[11px] text-muted">Powered by Bubaly</p>
    </main>
  );
}
