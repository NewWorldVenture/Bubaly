'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Zap, Crown, Sparkles, Lock, ArrowLeftRight, Archive } from 'lucide-react';
// From `primitives`, not `visual-mocks`: this is a client component, and
// `visual-mocks` imports `lib/i18n/server` → `next/headers`, which cannot be
// bundled for the browser.
import {
  Container,
  GradientText,
  PageWrap,
  TrustStrip,
} from '@/components/marketing/primitives';
import { cn } from '@/lib/utils/cn';
import { familiesNote } from '@/lib/marketing/format';
import {
  BASIC_MONTHLY_CENTS,
  BASIC_ANNUAL_CENTS,
  PLUS_MONTHLY_CENTS,
  PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';
import { useTranslations } from '@/components/i18n/locale-provider';

type Period = 'monthly' | 'yearly';

const fmt = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

const basicSavings = Math.round((1 - BASIC_ANNUAL_CENTS / (BASIC_MONTHLY_CENTS * 12)) * 100);
const plusSavings  = Math.round((1 - PLUS_ANNUAL_CENTS  / (PLUS_MONTHLY_CENTS  * 12)) * 100);

// ── Feature lists ──────────────────────────────────────────────────────────
const FREE_FEATURES = [
  { section: 'pricingContent.familyOrganization', items: ['pricingContent.sharedFamilyCalendar', 'pricingContent.sharedShoppingLists', 'pricingContent.sharedToDoLists', 'pricingContent.sharedRecipes', 'pricingContent.familyMessenger', 'pricingContent.familyContactBook'] },
  { section: 'pricingContent.familyMembers',      items: ['pricingContent.upTo5FamilyMembers'] },
  { section: 'pricingContent.platforms',           items: ['Web', 'iPhone', 'pricingContent.android', 'iPad'] },
  { section: 'pricingContent.basicFeatures',      items: ['pricingContent.calendarSync', 'pricingContent.basicReminders', 'pricingContent.sharedNotes', 'pricingContent.sharedPhotos', 'pricingContent.sharedDocuments'] },
  { section: 'AI',                  items: ['10 AI requests/month'] },
];

const BASIC_FEATURES = [
  { section: 'pricingContent.unlimitedFamilyMembers', items: ['pricingContent.parents', 'pricingContent.kids', 'pricingContent.grandparents', 'pricingContent.caregivers'] },
  { section: 'pricingContent.familyHub',               items: ['pricingContent.chores', 'pricingContent.rewards', 'pricingContent.mealPlanning', 'pricingContent.groceryPlanning', 'pricingContent.schoolHub', 'pricingContent.sportsHub'] },
  { section: 'pricingContent.unlimitedStorage',        items: ['pricingContent.photos', 'pricingContent.videos', 'pricingContent.documents'] },
  { section: 'pricingContent.kitchenDisplayMode',     items: ['iPad', 'pricingContent.androidTablet', 'pricingContent.browser', 'pricingContent.smartDisplay'] },
  { section: 'AI Features (Unlimited)', items: ['pricingContent.aiDailyBriefing', 'pricingContent.aiMealPlanning', 'pricingContent.aiGroceryBuilder', 'pricingContent.aiScheduleAssistant'] },
  { section: 'pricingContent.smartImports',            items: ['pricingContent.uploadSchoolFlyersPdfsScreenshots', 'pricingContent.aiAutoCreatesCalendarEvents'] },
];

const PLUS_FEATURES = [
  { section: 'pricingContent.aiConcierge', items: ['pricingContent.whatSHappeningToday', 'pricingContent.whatDoTheKidsNeed', 'pricingContent.whatFormsAreDue', 'pricingContent.whatSForDinner', 'pricingContent.whoCanPickUpJackson'] },
  { section: 'pricingContent.aiSchoolAssistant',  items: ['pricingContent.schoolEmails', 'pricingContent.permissionSlips', 'pricingContent.assignments', 'pricingContent.deadlines'] },
  { section: 'pricingContent.aiSportsAssistant',  items: ['pricingContent.teamSchedules', 'pricingContent.scheduleChanges', 'pricingContent.gameUpdates', 'pricingContent.practiceReminders'] },
  { section: 'pricingContent.aiFamilyBriefings',  items: ['pricingContent.morningEveningDailyBriefing', 'pricingContent.weeklyUpcomingConflictsSchoolDeadlines'] },
  { section: 'pricingContent.aiFamilyCommandCenter', items: ['pricingContent.familyReadinessScore', 'pricingContent.scheduleConflictDetection', 'pricingContent.familyStressPrediction', 'pricingContent.transportationPlanning', 'pricingContent.missingItemDetection'] },
  { section: 'pricingContent.familyDigitalTwin',  items: ['pricingContent.learnsFamilyPreferencesRoutinesHabits', 'pricingContent.proactivelyMakesRecommendations'] },
];

// ── Above-the-fold differentiators ──────────────────────────────────────────
// The highest-value Bubaly features, made easy to understand and find (vs. the
// market). Each is a real, shipped surface — this strip just raises visibility.
type HiTier = 'Free' | 'Family Basic' | 'Family+';
// HiTier doubles as a lookup key and as the badge's visible label, so the
// members stay identifiers and the display text lives here.
const HI_TIER_LABEL: Record<HiTier, string> = {
  'Free': 'pricingContent.free',
  'Family Basic': 'pricingContent.familyBasic',
  'Family+': 'pricingContent.familyPlus',
};

const HI_BADGE: Record<HiTier, string> = {
  'Free': 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
  'Family Basic': 'bg-blue-500/15 text-blue-300 ring-blue-400/30',
  'Family+': 'bg-violet-500/15 text-violet-300 ring-violet-400/30',
};

const SWITCH_HIGHLIGHTS: { emoji: string; title: string; desc: string; tier: HiTier }[] = [
  { emoji: '🛒', title: 'pricingContent.shoppingLists', tier: 'Free',
    desc: 'pricingContent.sharedShoppingAndGroceryLists' },
  { emoji: '📥', title: 'pricingContent.aiFamilyInboxFrontDesk', tier: 'Family+',
    desc: 'pricingContent.onePlaceForCallsEmails' },
  { emoji: '📸', title: 'pricingContent.smartImports', tier: 'Family Basic',
    desc: 'pricingContent.snapASchoolFlyerPdf' },
  { emoji: '🖥️', title: 'pricingContent.kitchenMode', tier: 'Family Basic',
    desc: 'pricingContent.turnAnyTabletOrSmart' },
  { emoji: '👛', title: 'pricingContent.familyWalletAllowance', tier: 'Free',
    desc: 'pricingContent.allowancesChoresToRewardsAnd' },
  { emoji: '🩺', title: 'pricingContent.healthMedsRecords', tier: 'Family Basic',
    desc: 'pricingContent.medicationsAppointmentsAndASecure' },
  { emoji: '🛟', title: 'pricingContent.emergencyHub', tier: 'Family+',
    desc: 'pricingContent.criticalInfoDocumentsAndContacts' },
  { emoji: '🚗', title: 'pricingContent.transportationRides', tier: 'Family+',
    desc: 'pricingContent.whoSPickingUpWhom' },
];

function WhySwitch() {
  const tr = useTranslations();
  return (
    <section className="mt-12">
      <h2 className="text-center text-2xl font-black">{tr('pricingPricingContent.whyFamiliesSwitchToBubaly')}</h2>
      <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">
        {tr('pricingPricingContent.theHighestValueThingsBubalyDoes')}
      </p>
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SWITCH_HIGHLIGHTS.map((h) => (
          <div key={h.title} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl" aria-hidden>{h.emoji}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1', HI_BADGE[h.tier])}>
                {tr(HI_TIER_LABEL[h.tier])}
              </span>
            </div>
            <p className="mt-3 text-sm font-bold">{tr(h.title)}</p>
            <p className="mt-1 text-xs leading-relaxed text-white/65">{tr(h.desc)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── How the free trial works ────────────────────────────────────────────────
const TRIAL_STEPS: { icon: React.ReactNode; title: string; desc: string }[] = [
  { icon: <Sparkles className="h-5 w-5 text-violet-300" />, title: 'pricingContent.startFree',
    desc: 'pricingContent.fullFamilyBasicAccessFor' },
  { icon: <Lock className="h-5 w-5 text-violet-300" />, title: 'pricingContent.after5Days',
    desc: 'pricingContent.yourAccountLocksLogBack' },
  { icon: <ArrowLeftRight className="h-5 w-5 text-violet-300" />, title: 'pricingContent.switchAnytime',
    desc: 'pricingContent.onFamilyDowngradeToFamily' },
  { icon: <Archive className="h-5 w-5 text-violet-300" />, title: 'pricingContent.yoursToKeep',
    desc: 'pricingContent.closeYourAccountAnytimeWe' },
];

function HowTrialWorks() {
  const tr = useTranslations();
  return (
    <section className="mt-10">
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <h2 className="text-center text-xl font-black sm:text-2xl">{tr('pricingPricingContent.howYourFreeTrialWorks')}</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">
          {tr('pricingPricingContent.fiveDaysOnTheHouseThen')}
        </p>
        <ol className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TRIAL_STEPS.map((s, i) => (
            <li key={s.title} className="relative flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <span className="absolute right-3 top-3 text-xs font-black text-white/25">{i + 1}</span>
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/12 ring-1 ring-violet-400/25">{s.icon}</span>
              <p className="mt-3 text-sm font-bold">{tr(s.title)}</p>
              <p className="mt-1 text-xs leading-relaxed text-white/65">{tr(s.desc)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ── Plan card ──────────────────────────────────────────────────────────────
function PlanCard({
  name, goal, icon, price, priceSub, cta, ctaHref, featured, featureSections, prelude, badge,
}: {
  name: string;
  goal: string;
  icon: React.ReactNode;
  price: string;
  priceSub: string;
  cta: string;
  ctaHref: string;
  featured?: boolean;
  badge?: string;
  prelude?: string;
  featureSections: { section: string; items: string[] }[];
}) {
  const tr = useTranslations();
  return (
    <article className={cn(
      'relative flex flex-col rounded-2xl p-5 sm:p-7',
      featured
        ? 'showcase-card border-violet-400/80 shadow-glow ring-1 ring-violet-400/40'
        : 'border border-white/10 bg-white/[0.04]',
    )}>
      {badge && (
        <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-violet-600 px-4 py-1 text-[11px] font-black tracking-wide text-brand-fg">
          {badge}
        </span>
      )}
      <div className="flex items-center gap-3">
        {icon}
        <h2 className="text-xl font-black">{name}</h2>
      </div>
      <p className="mt-2 text-sm text-white/60">{goal}</p>

      <div className="mt-5 flex items-end gap-1">
        <span className="text-4xl font-black">{price}</span>
        {price !== tr('pricingContent.free') && <span className="pb-1.5 text-white/60">/mo</span>}
      </div>
      <p className="mt-1 min-h-[18px] text-xs text-white/50">{priceSub}</p>

      <Link
        href={ctaHref}
        className={cn(
          'mt-5 inline-flex h-12 items-center justify-center rounded-xl text-sm font-bold transition',
          featured
            ? 'bg-gradient-to-r from-blue-500 to-violet-600 text-brand-fg shadow-glow hover:opacity-90'
            : 'border border-white/20 text-white hover:bg-white/10',
        )}
      >
        {cta}
      </Link>

      <div className="mt-6 space-y-4 border-t border-white/10 pt-6">
        {prelude && <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">{prelude}</p>}
        {featureSections.map((fs) => (
          <div key={tr(fs.section)}>
            <p className="mb-1.5 text-xs font-bold text-white/70">{tr(fs.section)}</p>
            <ul className="space-y-1.5">
              {fs.items.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-white/80">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </article>
  );
}

// ── Admin-controlled feature matrix ──────────────────────────────────────────
type MatrixTier = 'free' | 'basic' | 'plus';
type FeatureMatrix = { section: string; items: { label: string; tier: MatrixTier }[] }[];

const TIER_COL: { key: MatrixTier; label: string; dot: string }[] = [
  { key: 'free', label: 'pricingContent.fiveDayTrial', dot: 'bg-emerald-400' },
  { key: 'basic', label: 'pricingContent.familyBasic', dot: 'bg-blue-400' },
  { key: 'plus', label: 'pricingContent.familyPlus', dot: 'bg-violet-400' },
];
const TIER_RANK: Record<MatrixTier, number> = { free: 0, basic: 1, plus: 2 };

// Competitor-positioning callouts (how each tier stacks up vs the market).
const TIER_POSITIONING: { key: MatrixTier; label: string; dot: string; line: string }[] = [
  { key: 'free', label: 'pricingContent.fiveDayFreeTrial', dot: 'bg-emerald-400',
    line: 'pricingContent.getFullFamilyBasicFree' },
  { key: 'basic', label: 'pricingContent.familyBasic', dot: 'bg-blue-400',
    line: 'pricingContent.aDirectReplacementForCozi' },
  { key: 'plus', label: 'pricingContent.familyPlus', dot: 'bg-violet-400',
    line: 'pricingContent.categoryCreatorYourFamilyS' },
];

function PositioningCallouts() {
  const tr = useTranslations();
  return (
    <div className="mt-7 grid gap-3 sm:grid-cols-3">
      {TIER_POSITIONING.map((t) => (
        <div key={t.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <span className={cn('h-2 w-2 rounded-full', t.dot)} /> {tr(t.label)}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/65">{tr(t.line)}</p>
        </div>
      ))}
    </div>
  );
}

function FeatureMatrixTable({ matrix }: { matrix: FeatureMatrix }) {
  const tr = useTranslations();
  if (matrix.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="text-center text-2xl font-black">{tr('pricingPricingContent.everyFeatureByPlan')}</h2>
      <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">{tr('pricingContent.your5DayFreeTrial')}</p>
      <PositioningCallouts />
      <div className="mt-7 overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="px-4 py-3 text-left font-bold">{tr('pricingPricingContent.feature')}</th>
              {TIER_COL.map((t) => (
                <th key={t.key} className="px-4 py-3 text-center font-bold">
                  <span className="inline-flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', t.dot)} />{tr(t.label)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((sec) => (
              <FeatureMatrixSection key={tr(sec.section)} section={tr(sec.section)} items={sec.items} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FeatureMatrixSection({ section, items }: { section: string; items: { label: string; tier: MatrixTier }[] }) {
  const tr = useTranslations();
  return (
    <>
      <tr className="bg-white/[0.04]">
        <td colSpan={4} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/55">{section}</td>
      </tr>
      {items.map((it) => (
        <tr key={tr(it.label)} className="border-t border-white/[0.06]">
          <td className="px-4 py-2.5 text-white/85">{tr(it.label)}</td>
          {TIER_COL.map((t) => (
            <td key={t.key} className="px-4 py-2.5 text-center">
              {TIER_RANK[t.key] >= TIER_RANK[it.tier]
                ? <Check className="mx-auto h-4 w-4 text-emerald-400" />
                : <span className="text-white/20">—</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export function PricingContent({ familiesCount = 0, featureMatrix = [] }: { familiesCount?: number; featureMatrix?: FeatureMatrix }) {
  const tr = useTranslations();
  const [period, setPeriod] = useState<Period>('yearly');
  const yearly = period === 'yearly';
  const router = useRouter();

  // Keep the tier/feature grid live after an admin edits /admin/tier-features.
  //
  // This used to also poll every 20 seconds, unconditionally and forever. On a
  // PUBLIC page that is expensive in a way that is easy to miss: each refresh
  // re-renders the server tree, and this route's render awaits getPublicStats()
  // and getResolvedFeatureTiers() — so one open tab was ~8,600 Supabase queries
  // a day, whether or not anyone was looking at it, and crawlers and abandoned
  // tabs all counted. Tier pricing changes maybe monthly; polling it three times
  // a minute buys nothing that returning to the tab does not.
  //
  // Refreshing when the tab becomes visible covers the real case (admin edits,
  // then someone looks at the page), and the throttle stops an alt-tab habit
  // from turning into its own poll.
  useEffect(() => {
    let lastRefresh = 0;
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastRefresh < 60_000) return;
      lastRefresh = now;
      router.refresh();
    };
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [router]);

  const basicPrice    = yearly ? fmt(Math.round(BASIC_ANNUAL_CENTS / 12)) : fmt(BASIC_MONTHLY_CENTS);
  const basicPriceSub = yearly ? `billed ${fmt(BASIC_ANNUAL_CENTS)}/yr · save ${basicSavings}%` : 'billed monthly';
  const plusPrice     = yearly ? fmt(Math.round(PLUS_ANNUAL_CENTS / 12))  : fmt(PLUS_MONTHLY_CENTS);
  const plusPriceSub  = yearly ? `billed ${fmt(PLUS_ANNUAL_CENTS)}/yr · save ${plusSavings}%`  : 'billed monthly';

  return (
    <PageWrap>
      <Container className="pb-12 pt-8 sm:pb-16 sm:pt-10">
        {/* The hero used to share a 3-column grid with the demo card, which took
            column 1 and pushed the title into columns 2-3. With the card gone the
            grid has nothing left to align, so the hero is a plain centered block —
            no empty column, no off-centre title. Fully fluid (clamp type, no fixed
            widths). */}
        <section className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300/80 sm:text-sm">
            {tr('pricingPricingContent.lessManagingLifeMoreLivingIt')}
          </p>
          <h1 className="mt-3 font-black leading-[1.05] text-[clamp(2.25rem,6vw,3.75rem)]">
            {tr('pricingPricingContent.bubalyPricing')}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-white/65 sm:mt-5 sm:text-lg">
            {tr('pricingPricingContent.getFullFamilyBasicAccessFree')}
          </p>

          <div className="mt-6 flex justify-center sm:mt-7">
            <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1 text-sm">
              <button
                onClick={() => setPeriod('monthly')}
                className={cn('inline-flex items-center justify-center rounded-full px-5 py-2 font-bold transition coarse:min-h-11 sm:px-6', period === 'monthly' ? 'bg-violet-600 text-brand-fg' : 'text-white/65 hover:text-white')}
              >
                {tr('pricingPricingContent.monthly')}
              </button>
              <button
                onClick={() => setPeriod('yearly')}
                className={cn('inline-flex items-center justify-center rounded-full px-5 py-2 font-bold transition coarse:min-h-11 sm:px-6', period === 'yearly' ? 'bg-violet-600 text-brand-fg' : 'text-white/65 hover:text-white')}
              >
                {tr('pricingPricingContent.yearly')}
              </button>
              {yearly && (
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                  {tr('pricingPricingContent.saveUpTo')} {basicSavings}%
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Plan cards — responsive 1 / 2 / 3 columns */}
        <section className="mt-10 grid gap-4 sm:mt-12 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          <PlanCard
            name="5-Day Free Trial"
            goal={tr('pricingContent.fullFamilyBasicAccessFree')}
            icon={<Zap className="h-7 w-7 text-white/60" />}
            price={tr('pricingContent.free')}
            priceSub={tr('pricingContent.familyBasicFor5Days')}
            cta={tr('pricingContent.startYourFreeTrial')}
            ctaHref="/signup"
            prelude={tr('pricingContent.yourFreeTrialIncludesFamily')}
            featureSections={FREE_FEATURES}
          />

          <PlanCard
            name={tr('pricingContent.familyBasic')}
            goal={tr('pricingContent.theBestFamilyOrganizerOn')}
            icon={<Crown className="h-7 w-7 text-yellow-400" />}
            price={basicPrice}
            priceSub={basicPriceSub}
            cta={tr('pricingContent.startFamilyBasic')}
            ctaHref={`/signup?plan=basic&billing=${period}`}
            featured
            badge="MOST POPULAR"
            prelude={tr('pricingContent.everythingInYourTrialPlus')}
            featureSections={BASIC_FEATURES}
          />

          <PlanCard
            name="Family+"
            goal={tr('pricingContent.theFamilyChiefOfStaff')}
            icon={<Sparkles className="h-7 w-7 text-violet-400" />}
            price={plusPrice}
            priceSub={plusPriceSub}
            cta={tr('pricingContent.startFamily')}
            ctaHref={`/signup?plan=plus&billing=${period}`}
            prelude={tr('pricingContent.everythingInFamilyBasicPlus')}
            featureSections={PLUS_FEATURES}
          />
        </section>

        {/* How the 5-day free trial works — the model, in plain language. */}
        <HowTrialWorks />

        {/* Differentiators — the highest-value features, placed below the plan
            cards so pricing details lead the page. */}
        <WhySwitch />

        {/* Smart Imports callout */}
        <section className="showcase-panel mt-8 p-5 sm:p-7">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
            <div className="shrink-0 text-3xl">📸</div>
            <div>
              <h2 className="font-bold">{tr('pricingPricingContent.smartImportsTheFeatureMostCompetitors')}</h2>
              <p className="mt-1 text-sm text-white/65">{tr('pricingContent.snapASchoolFlyerUpload')}</p>
            </div>
          </div>
        </section>

        <FeatureMatrixTable matrix={featureMatrix} />

        <TrustStrip
          familiesNote={familiesNote(tr, familiesCount)}
          privateTitle={tr('trustStrip.privateByDesign')}
          privateBody={tr('trustStrip.familyScopedAccessControls')}
          responsiveTitle={tr('trustStrip.responsiveByDesign')}
          responsiveBody={tr('trustStrip.webIosAndAndroidLayouts')}
          updatesTitle={tr('trustStrip.sharedUpdates')}
          updatesBody={tr('trustStrip.familyChangesStayInSync')}
          communityTitle={tr('trustStrip.familyCommunity')}
        />

        <p className="border-t border-white/8 pt-7 text-center text-sm text-white/55">
          {tr('pricingPricingContent.questionsVisitOur')}{' '}
          <a className="text-violet-300 hover:underline" href="/faq">{tr('pricingPricingContent.helpCenter')}</a>
          {' '}or{' '}
          <a className="text-violet-300 hover:underline" href="/contact">{tr('pricingPricingContent.contactSupport')}</a>
        </p>
      </Container>
    </PageWrap>
  );
}
