import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, CircleDot, Monitor, ShoppingCart, Tablet } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { SampleBadge } from '@/components/marketing/primitives';
import { CTASection } from '@/components/marketing/cta';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getTranslations } from '@/lib/i18n/server';
import {
  CERTIFIED_DEVICES, DEVICE_SETUP_STEPS, DEVICE_TIERS, PROGRAM_DISCLAIMER_KEY, devicesInTier,
} from '@/lib/marketing/certified-devices';
import {
  BUBALY_NEEDS, COMPARE_FAIRNESS_KEY, DEDICATED_NEEDS, DISPLAY_COMPARE_ROWS, type DisplayNeed,
} from '@/lib/marketing/display-compare';

// The public page for the family display: "a shared family screen on the tablet
// you already own".
//
// Two catalogs drive it — lib/marketing/certified-devices.ts (what runs it) and
// lib/marketing/display-compare.ts (what a family has to buy or do, either way).
// Both are pure and both are keyed, so this file holds layout and no copy.
//
// The mocked wall further down is fiction and wears the sample badge every
// illustrative element on this site wears. The device tiers are a compatibility
// list, and the disclaimer under them says so in as many words: no partnership,
// no certification, nobody paid to be there.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/family-display', {
    title: t('marketingDisplay.metaTitle'),
    description: t('marketingDisplay.metaDescription'),
  });
}

const TIER_LABEL: Record<(typeof DEVICE_TIERS)[number], string> = {
  recommended: 'marketingDisplay.tierRecommended',
  compatible: 'marketingDisplay.tierCompatible',
};

const TIER_BLURB: Record<(typeof DEVICE_TIERS)[number], string> = {
  recommended: 'marketingDisplay.tierRecommendedBlurb',
  compatible: 'marketingDisplay.tierCompatibleBlurb',
};

const NEED_ICON = {
  'already-have': Check,
  optional: CircleDot,
  buy: ShoppingCart,
} as const;

const NEED_LABEL = {
  'already-have': 'marketingDisplay.needAlreadyHave',
  optional: 'marketingDisplay.needOptional',
  buy: 'marketingDisplay.needBuy',
} as const;

function NeedList({ needs, label, t }: { needs: readonly DisplayNeed[]; label: string; t: (key: string) => string }) {
  return (
    <div className="glass-card p-6">
      <h3 className="text-lg font-semibold">{label}</h3>
      <ul className="mt-4 space-y-3">
        {needs.map((need) => {
          const Icon = NEED_ICON[need.kind];
          return (
            <li key={need.id} className="flex items-start gap-3 text-sm">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" aria-hidden />
              <span className="min-w-0">
                <span>{t(need.labelKey)}</span>
                <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
                  {t(NEED_LABEL[need.kind])}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function FamilyDisplayPage() {
  const t = await getTranslations();

  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow={t('marketingDisplay.eyebrow')}
          title={t('marketingDisplay.title')}
          description={t('marketingDisplay.subtitle')}
        />
      </Section>

      {/* An illustration of the wall. Fiction, and badged as fiction. */}
      <Section className="pt-0">
        <div className="glass-card mx-auto max-w-3xl p-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-muted">{t('marketingDisplay.mockCaption')}</p>
            <SampleBadge>{t('handledProof.sampleBadge')}</SampleBadge>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              { id: 'schedule', titleKey: 'marketingDisplay.mockScheduleTitle', bodyKey: 'marketingDisplay.mockScheduleBody' },
              { id: 'ask', titleKey: 'marketingDisplay.mockAskTitle', bodyKey: 'marketingDisplay.mockAskBody' },
              { id: 'handled', titleKey: 'marketingDisplay.mockHandledTitle', bodyKey: 'marketingDisplay.mockHandledBody' },
            ].map((tile) => (
              <div key={tile.id} className="rounded-2xl border border-border bg-surface/60 p-4 text-left">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t(tile.titleKey)}</p>
                <p className="mt-2 text-sm">{t(tile.bodyKey)}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Setup — the same six steps the in-app guide walks through. */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('marketingDisplay.setupEyebrow')}
          title={t('marketingDisplay.setupTitle')}
          description={t('marketingDisplay.setupSubtitle')}
        />
        <ol className="mx-auto mt-10 max-w-3xl space-y-3">
          {DEVICE_SETUP_STEPS.map((step, i) => (
            <li key={step.id} className="flex gap-3 rounded-2xl border border-border bg-surface/50 p-4">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-sm font-bold text-brand-text">
                {i + 1}
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold">{t(step.labelKey)}</h3>
                <p className="mt-1 text-sm text-muted">{t(step.bodyKey)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* The compatibility list. */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('marketingDisplay.devicesEyebrow')}
          title={t('marketingDisplay.devicesTitle')}
          description={t('marketingDisplay.devicesSubtitle')}
        />
        <div className="mt-10 space-y-10">
          {DEVICE_TIERS.map((tier) => (
            <div key={tier}>
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <Tablet className="h-5 w-5 text-brand-text" aria-hidden /> {t(TIER_LABEL[tier])}
              </h3>
              <p className="mt-1 text-sm text-muted">{t(TIER_BLURB[tier])}</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {devicesInTier(tier, CERTIFIED_DEVICES).map((device) => (
                  <div key={device.id} className="glass-card p-5">
                    <h4 className="font-semibold">{t(device.nameKey)}</h4>
                    <p className="mt-2 text-sm text-muted">{t(device.noteKey)}</p>
                    <dl className="mt-3 space-y-1 text-xs text-muted">
                      <div className="flex gap-2">
                        <dt className="font-medium">{t('marketingDisplay.minOs')}</dt>
                        <dd>{t(device.minOsKey)}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-medium">{t('marketingDisplay.browser')}</dt>
                        <dd>{t(device.browserKey)}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-xs text-muted">{t(device.standNoteKey)}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-3xl rounded-2xl border border-border bg-surface/50 p-4 text-sm text-muted">
          {t(PROGRAM_DISCLAIMER_KEY)}
        </p>
      </Section>

      {/* What a family has to buy or do, either way. */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('marketingDisplay.compareEyebrow')}
          title={t('marketingDisplay.compareTitle')}
          description={t('marketingDisplay.compareSubtitle')}
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <NeedList needs={BUBALY_NEEDS} label={t('marketingDisplay.needsBubaly')} t={t} />
          <NeedList needs={DEDICATED_NEEDS} label={t('marketingDisplay.needsDedicated')} t={t} />
        </div>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-3 pr-4 font-semibold">{t('marketingDisplay.colAspect')}</th>
                <th scope="col" className="py-3 pr-4 font-semibold">{t('marketingDisplay.colBubaly')}</th>
                <th scope="col" className="py-3 font-semibold">{t('marketingDisplay.colDedicated')}</th>
              </tr>
            </thead>
            <tbody>
              {DISPLAY_COMPARE_ROWS.map((row) => (
                <tr key={row.id} className="border-b border-border/60 align-top">
                  <th scope="row" className="py-3 pr-4 font-medium">{t(row.aspectKey)}</th>
                  <td className="py-3 pr-4 text-muted">{t(row.bubalyKey)}</td>
                  <td className="py-3 text-muted">{t(row.dedicatedKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-sm text-muted">{t(COMPARE_FAIRNESS_KEY)}</p>
      </Section>

      {/* Signed in already? The in-app guide has the self-check. */}
      <Section className="pt-0">
        <div className="glass-card mx-auto flex max-w-3xl flex-col items-center gap-4 p-7 text-center sm:flex-row sm:text-left">
          <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
            <Monitor className="h-7 w-7" aria-hidden />
          </span>
          <div className="flex-1">
            <h2 className="text-2xl font-bold tracking-tight">{t('marketingDisplay.alreadyTitle')}</h2>
            <p className="mt-2 text-sm text-muted">{t('marketingDisplay.alreadyBody')}</p>
          </div>
          <Link
            href="/display/setup"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
          >
            {t('marketingDisplay.alreadyLink')} <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </Section>

      <CTASection title={t('marketingDisplay.ctaTitle')} subtitle={t('marketingDisplay.ctaSubtitle')} />
      <MarketingAeoSection
        path="/family-display"
        name={t('marketingDisplay.aeoName')}
        description={t('marketingDisplay.aeoDescription')}
      />
    </>
  );
}
