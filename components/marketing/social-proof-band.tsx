// "Real families, real outcomes" — only what the database can back, used
// exactly as stored. Testimonials and case studies come from the admin-curated
// tables (app/(app)/admin/marketing/reputation) through
// lib/marketing/reputation-server.ts, which returns only published rows.
//
// When nothing is published the band renders NOTHING: no placeholder quotes,
// no invented names, no "coming soon". The "Verified outcome" badge is gated
// on a case study's verified_at, which only an admin can set.
import { Gift, Quote, ShieldCheck, Star } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { BandHeader, Container } from '@/components/marketing/visual-mocks';
import { getPublishedCaseStudies, getPublishedTestimonials } from '@/lib/marketing/reputation-server';
import { getPublicStats } from '@/lib/marketing/stats';
import { familiesNote } from '@/lib/marketing/format';
import { cn } from '@/lib/utils/cn';

function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={cn('h-3.5 w-3.5', i < rating ? 'fill-amber-400 text-amber-400' : 'text-white/25')} aria-hidden />
      ))}
    </span>
  );
}

export async function SocialProofBand() {
  const [testimonials, caseStudies] = await Promise.all([getPublishedTestimonials(), getPublishedCaseStudies()]);
  if (!testimonials.length && !caseStudies.length) return null;

  const t = await getTranslations();
  const { families } = await getPublicStats();

  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
      <BandHeader eyebrow={t('socialProof.eyebrow')} title={t('socialProof.title')} align="center" />
      {/* The same registered-family line the pricing TrustStrip shows; hidden
          at zero rather than falling back to a slogan under real quotes. */}
      {families > 0 && (
        <p className="mt-3 text-center text-sm text-white/60">{familiesNote(t, families)}</p>
      )}

      {testimonials.length > 0 && (
        <ul className="-mx-5 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
          {testimonials.map((item) => (
            <li key={item.id} className="w-[85%] shrink-0 snap-start sm:w-auto">
              <figure className="showcase-card flex h-full flex-col p-5">
                <Quote className="h-5 w-5 text-violet-300" aria-hidden />
                <blockquote className="mt-3 flex-1 text-sm leading-6 text-white/85">{item.quote}</blockquote>
                <figcaption className="mt-4 text-xs text-white/60">
                  <span className="font-semibold text-white/85">{item.authorName}</span>
                  {item.authorRole ? `, ${item.authorRole}` : ''}
                  {item.company ? ` · ${item.company}` : ''}
                </figcaption>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  {item.rating != null && <Stars rating={item.rating} label={t('socialProof.ratingLabel', { count: item.rating })} />}
                  <span className="text-[10px] font-medium uppercase tracking-wider text-white/45">{t('socialProof.sharedWithPermission')}</span>
                </div>
              </figure>
            </li>
          ))}
        </ul>
      )}

      {caseStudies.length > 0 && (
        <div className="mt-10">
          <h3 className="text-center text-lg font-semibold">{t('socialProof.caseStudiesTitle')}</h3>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {caseStudies.map((study) => (
              <li key={study.id} className="showcase-card flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-base font-semibold">{study.title}</h4>
                  {study.verifiedAt && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-white/85">
                      <ShieldCheck className="h-3 w-3 text-emerald-400" aria-hidden />
                      {t('socialProof.verifiedBadge')}
                    </span>
                  )}
                </div>
                {study.customerName && <p className="mt-1 text-xs text-white/55">{study.customerName}</p>}
                {study.summary && <p className="mt-3 flex-1 text-sm leading-6 text-white/75">{study.summary}</p>}
                {study.resultMetric && (
                  <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-white/50">{t('socialProof.resultLabel')} · {t('socialProof.customerWords')}</p>
                    <p className="mt-1 text-sm font-medium text-white/90">{study.resultMetric}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10 flex flex-col items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-5 py-6 text-center">
        <Gift className="h-5 w-5 text-violet-300" aria-hidden />
        <p className="text-base font-semibold">{t('socialProof.referTitle')}</p>
        <p className="text-sm text-white/65">{t('socialProof.referBody')}</p>
      </div>
    </Container>
  );
}
