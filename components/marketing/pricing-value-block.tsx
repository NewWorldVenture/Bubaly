'use client';

// "What you're paying for" — the value block above the /pricing plan cards.
//
// Part A is a tier × row matrix: what the family still decides, what Bubaly
// prepares and what Bubaly handles on each tier. It renders as three tier
// cards that sit side by side from `md` up and STACK below it — never a
// horizontal table, never a sideways scroller — so phones keep no horizontal
// overflow (tests/e2e/overflow.spec.ts, tests/e2e/mobile.spec.ts).
//
// Part B shows three kinds of number, in three cards, never blended into one
// sentence and never into one number:
//   REAL          cross-family counts from public_handled_stats(); the card is
//                 OMITTED below HANDLED_PUBLIC_MIN (lib/marketing/value.ts),
//                 so a young site shows nothing rather than a zero.
//   ILLUSTRATIVE  a fictional family's brief, computed by the app's own
//                 composer (lib/marketing/handled-sample.ts) and badged
//                 "Illustrative sample" with the estimate note beneath it.
//   YOURS         the family's own Daily Brief counts, which exist per family
//                 from day one (home_briefs.handled / time_saved_minutes).
//
// No cross-family time-saved aggregate is published here: the north-star
// metric that would back one is not defined yet, and the only minutes on this
// page belong to the badged sample.
//
// Client-safe on purpose: this renders inside pricing-content.tsx, a client
// component. It imports only the shared primitives and lib/marketing/value.ts;
// the stats and the sample numbers arrive as props from the server page.
import { BandHeader, SampleBadge } from '@/components/marketing/primitives';
import { useTranslations } from '@/components/i18n/locale-provider';
import { VALUE_ROWS, VALUE_TIERS, realHandledCounts, type HandledStatsLike } from '@/lib/marketing/value';

/** The composer's numbers for the fictional week — computed, never typed. */
export type PricingValueSample = {
  today: number;
  clashes: number;
  handled: number;
  minutes: number;
};

const TIER_DOT: Record<string, string> = {
  trial: 'bg-emerald-400',
  basic: 'bg-blue-400',
  plus: 'bg-violet-400',
};

const CARD_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-white/55';

export function PricingValueBlock({ handled, sample }: { handled: HandledStatsLike; sample: PricingValueSample }) {
  const t = useTranslations();
  const real = realHandledCounts(handled);

  return (
    <section aria-label={t('pricingValue.title')} className="mt-12 sm:mt-14">
      <BandHeader
        eyebrow={t('pricingValue.eyebrow')}
        title={t('pricingValue.title')}
        body={t('pricingValue.body')}
        align="center"
      />

      {/* Part A — the tier × row matrix, one card per tier; stacked under md. */}
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {VALUE_TIERS.map((tier) => (
          <article
            key={tier.key}
            className={tier.key === 'basic'
              ? 'showcase-card border-violet-400/60 p-5 ring-1 ring-violet-400/30'
              : 'rounded-2xl border border-white/10 bg-white/[0.03] p-5'}
          >
            <h3 className="flex items-center gap-2 text-base font-bold">
              <span className={`h-2 w-2 shrink-0 rounded-full ${TIER_DOT[tier.key]}`} aria-hidden />
              {t(tier.labelKey)}
            </h3>
            <dl className="mt-4 space-y-3">
              {VALUE_ROWS.map((row) => (
                <div key={row.key}>
                  <dt className={CARD_TITLE}>{t(row.labelKey)}</dt>
                  <dd className="mt-1 text-sm leading-6 text-white/85">{t(tier.cells[row.key])}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>

      {/* Part B — real, illustrative, yours: three cards, never one sentence. */}
      <div className={`mt-6 grid gap-4 sm:grid-cols-2 ${real ? 'lg:grid-cols-3' : ''}`}>
        {real && (
          <article className="showcase-card p-5">
            <header>
              <span className={CARD_TITLE}>{t('pricingValue.realTitle')}</span>
            </header>
            <p className="mt-3 text-lg font-bold leading-snug">{t('handledProof.aggregateNote', { count: real.total })}</p>
            {real.last30d && (
              <p className="mt-1 text-sm text-white/70">{t('handledProof.aggregate30d', { count: real.last30d })}</p>
            )}
            <p className="mt-4 text-xs leading-5 text-white/55">{t('pricingValue.realFootnote')}</p>
          </article>
        )}

        <article className="showcase-card p-5" aria-label={t('handledProof.sampleBriefLabel')}>
          <header className="flex items-start justify-between gap-3">
            <span className={CARD_TITLE}>{t('pricingValue.sampleTitle')}</span>
            <SampleBadge>{t('handledProof.sampleBadge')}</SampleBadge>
          </header>
          <p className="mt-3 text-lg font-bold leading-snug">
            {t('handledProof.sampleBriefHeadline', { today: sample.today, clashes: sample.clashes, handled: sample.handled })}
          </p>
          <p className="mt-2 text-sm font-semibold text-white/90">{t('pricingValue.minutesHandedBack', { minutes: sample.minutes })}</p>
          <p className="mt-3 text-sm leading-6 text-white/70">{t('pricingValue.sampleBody')}</p>
          <p className="mt-3 text-xs leading-5 text-white/55">{t('pricingValue.estimateNote')}</p>
        </article>

        <article className="showcase-card p-5">
          <header>
            <span className={CARD_TITLE}>{t('pricingValue.yourNumbersTitle')}</span>
          </header>
          <p className="mt-3 text-sm leading-6 text-white/80">{t('pricingValue.yourNumbersBody')}</p>
        </article>
      </div>
    </section>
  );
}
