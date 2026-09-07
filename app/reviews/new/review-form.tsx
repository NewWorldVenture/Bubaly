'use client';

import { useState, useTransition } from 'react';
import { Star, CheckCircle2, Loader2, ExternalLink } from 'lucide-react';
import { submitReviewAction } from './actions';
import { shouldRouteToPublic } from '@/lib/marketing/reviews';
import { useTranslations } from '@/components/i18n/locale-provider';

export type PublicLink = { label: string; url: string };

type Props = {
  headline: string;
  message: string;
  minPublicRating: number;
  thankYouHigh: string;
  thankYouLow: string;
  publicLinks: PublicLink[];
};

export function ReviewForm(p: Props) {
  const t = useTranslations();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  function submit() {
    if (rating < 1) { setError(t('reviewForm.pleaseChooseAStarRating')); return; }
    setError('');
    start(async () => {
      const r = await submitReviewAction({ rating, title, body, name, email });
      if (r.ok) setDone(true); else setError(r.error ?? t('reviewForm.somethingWentWrong'));
    });
  }

  if (done) {
    const high = shouldRouteToPublic(rating, p.minPublicRating);
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-success/10 text-success">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold">{high ? p.thankYouHigh : p.thankYouLow}</h2>
        {high && p.publicLinks.length > 0 && (
          <div className="mt-4 space-y-2">
            {p.publicLinks.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-brand-fg">
                Review us on {l.label} <ExternalLink className="h-4 w-4" />
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold leading-snug">{p.headline}</h1>
        {p.message && <p className="mt-1 text-sm text-muted">{p.message}</p>}
      </div>

      <div className="flex justify-center gap-1.5" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((v) => (
          <button key={v} type="button" onClick={() => setRating(v)} onMouseEnter={() => setHover(v)} aria-label={`${v} star${v === 1 ? '' : 's'}`}>
            <Star className={`h-9 w-9 transition ${(hover || rating) >= v ? 'fill-amber-400 text-amber-400' : 'text-border'}`} />
          </button>
        ))}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('reviewsNewReviewForm.titleOptional')}
        className="h-11 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={t('reviewsNewReviewForm.tellUsAboutYourExperience')}
        className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
      <div className="grid grid-cols-2 gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reviewsNewReviewForm.yourNameOptional')}
          className="h-11 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder={t('reviewsNewReviewForm.emailOptional')}
          className="h-11 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring" />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      <button onClick={submit} disabled={pending}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-brand-fg disabled:opacity-60">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('reviewsNewReviewForm.submitReview')}
      </button>
    </div>
  );
}
