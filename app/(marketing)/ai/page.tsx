import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import Link from 'next/link';
import {
  Sparkles, Calendar, UtensilsCrossed, ShoppingCart, CheckSquare, Bell, PiggyBank,
  FileText, ShieldCheck, Newspaper, Zap, Lock, SlidersHorizontal, ArrowRight,
  Sun, Sunset, Moon,
} from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';
import { Button } from '@/components/ui/button';
import { AiActionDemo } from '@/components/marketing/ai-showcase';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/ai', {
    title: t('ai.bubalyAiTheAssistantThat'),
    description: t('ai.descriptionOutcomes'),
  });
}

const DIFFERENTIATORS = [
  {
    icon: Zap,
    title: 'ai.itActsItDoesnT',
    body: 'ai.mostAssistantsHandYouA',
  },
  {
    icon: Lock,
    title: 'ai.privateToYourFamily',
    body: 'ai.everyActionIsScopedTo',
  },
  {
    icon: SlidersHorizontal,
    title: 'ai.alwaysInYourControl',
    body: 'ai.youStayTheParentSensitive',
  },
];

const CAPABILITIES = [
  { icon: Calendar, title: 'ai.calendarScheduling', body: 'ai.addEventsSpotConflictsAnd' },
  { icon: UtensilsCrossed, title: 'ai.mealsGroceries', body: 'ai.planTheWeekSDinners' },
  { icon: CheckSquare, title: 'ai.choresAllowance', body: 'ai.assignAgeAppropriateChoresSplit' },
  { icon: Bell, title: 'ai.remindersFollowUps', body: 'ai.neverDropTheInvisibleStuff' },
  { icon: PiggyBank, title: 'ai.moneyCoaching', body: 'ai.trackGoalsAndGetPlain' },
  { icon: FileText, title: 'ai.documentsPaperwork', body: 'ai.turnASchoolFlyerOr' },
  { icon: ShieldCheck, title: 'ai.familySafety', body: 'ai.screenUnknownCallersFlagRisky' },
  { icon: Newspaper, title: 'ai.weeklyBriefings', body: 'ai.oneCalmSummaryOfThe' },
];

const DAY = [
  {
    icon: Sun,
    when: 'ai.morning',
    what: 'ai.theFamilyBrief',
    body: 'ai.everyoneSUpEmmaHas',
  },
  {
    icon: Sunset,
    when: 'ai.midday',
    what: 'ai.paperworkHandled',
    body: 'ai.youSnapAPhotoOf',
  },
  {
    icon: Moon,
    when: 'ai.evening',
    what: 'ai.tomorrowPreSolved',
    body: 'ai.groceryRunNeededForThursday',
  },
];

export default async function AIPage() {
  const t = await getTranslations();
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden">
        <div className="ai-hero-glow pointer-events-none absolute inset-0" aria-hidden />
        <Section className="relative pt-20 text-center sm:pt-28">
          <span className="ai-orb mx-auto flex h-16 w-16 items-center justify-center">
            <Sparkles className="h-7 w-7 text-brand-text" />
          </span>

          <span className="mt-8 inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand-text">{t('ai.bubalyAi')}</span>

          <h1 className="mx-auto mt-5 max-w-4xl text-4xl font-bold tracking-tight sm:text-6xl">
            It doesn’t just answer.{' '}
            <span className="gradient-text-violet">{t('ai.itDoesTheWork')}</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted sm:text-xl">{t('ai.askInPlainLanguageAnd')}</p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup">
              <Button size="lg">{t('ai.startFree5Days')}{' '}<ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
            <Link
              href="#demo"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
            >{t('ai.seeItWork')}</Link>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-brand-text" />{' '}{t('ai.familyScopedPrivate')}</span>
            <span className="inline-flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-brand-text" />{' '}{t('ai.takesRealAction')}</span>
          </div>
        </Section>
      </div>

      {/* ── Ask → Act demo (the centerpiece) ─────────────────────────────── */}
      <Section id="demo" className="pt-4">
        <SectionHeading
          eyebrow={t('ai.askAct')}
          title={t('ai.sayItInPlainLanguage')}
          description={t('ai.pickAPromptBubalyReplies')}
        />
        <div className="mt-12">
          <AiActionDemo />
        </div>
      </Section>

      {/* ── Differentiators ──────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('ai.notAChatbotADoer')}
          title={t('ai.theDifferenceIsWhatHappens')}
        />
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {DIFFERENTIATORS.map((d) => (
            <div key={d.title} className="glass-card p-7 transition hover:-translate-y-0.5 hover:shadow-glow">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
                <d.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-5 text-lg font-semibold">{t(d.title)}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{t(d.body)}</p>
            </div>
          ))}
        </div>

        {/* How Bubaly decides what to do alone — the Trust Center holds the
            full statement, rendered from the same engine that enforces it. */}
        <div className="glass-card mt-6 flex flex-col gap-5 p-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
              <ShieldCheck className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <h3 className="text-lg font-semibold">{t('ai.howBubalyDecides')}</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('ai.howBubalyDecidesBody')}</p>
            </div>
          </div>
          <Link
            href="/security#ai-trust"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
          >
            {t('decisionsBand.readTrustCenter')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </Section>

      {/* ── Capabilities ─────────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('ai.oneAssistantTheWholeHousehold')}
          title={t('ai.everythingItCanTakeOff')}
          description={t('ai.bubalyReachesAcrossYourFamily')}
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="glass-card p-6 transition hover:-translate-y-0.5 hover:shadow-glow">
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
                <c.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{t(c.title)}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{t(c.body)}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── A day, handled ───────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow={t('ai.aTuesdayHandled')}
          title={t('ai.whatADayFeelsLike')}
          description={t('ai.itDoesnTWaitTo')}
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {DAY.map((d, i) => (
            <div key={d.when} className="relative glass-card p-7">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
                  <d.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-brand-text">{t(d.when)}</p>
                  <p className="text-base font-semibold">{t(d.what)}</p>
                </div>
                <span className="ml-auto text-sm font-bold text-muted">0{i + 1}</span>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted">{t(d.body)}</p>
            </div>
          ))}
        </div>
      </Section>

      <CTASection
        title={t('ai.meetTheAssistantThatActually')}
        subtitle="Set up your family in minutes and let Bubaly handle the logistics — free for 5 days, no credit card."
      />
      <MarketingAeoSection path="/ai" name={t('ai.bubalyAi')} description={t('ai.anAssistantThatTakesReal')} />
    </>
  );
}
