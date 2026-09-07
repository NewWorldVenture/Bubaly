'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Zap, Crown, Sparkles, Lock, ArrowLeftRight, Archive, MonitorSmartphone, ShieldCheck, type LucideIcon } from 'lucide-react';
// From `primitives`, not `visual-mocks`: this is a client component, and
// `visual-mocks` imports `lib/i18n/server` → `next/headers`, which cannot be
// bundled for the browser.
import {
  Container,
  GradientText,
  PageWrap,
  TrustStrip,
} from '@/components/marketing/primitives';
import { PricingValueBlock, type PricingValueSample } from '@/components/marketing/pricing-value-block';
import { cn } from '@/lib/utils/cn';
import { familiesNote } from '@/lib/marketing/format';
import { HERO_OUTCOMES } from '@/lib/marketing/hero-outcomes';
import {
  VALUE_TIERS,
  formatPerDay,
  perDayCents,
  valueTier,
  type BillingPeriod,
  type HandledStatsLike,
  type ValueOutcome,
} from '@/lib/marketing/value';
import {
  BASIC_MONTHLY_CENTS,
  BASIC_ANNUAL_CENTS,
  PLUS_MONTHLY_CENTS,
  PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';
import { useTranslations } from '@/components/i18n/locale-provider';

type Period = BillingPeriod;

/** A published case study, already filtered and shaped by the server page. */
export type PricingCaseStudy = {
  id: string;
  title: string;
  customerName: string | null;
  summary: string | null;
  resultMetric: string | null;
  /** Only an admin can set case_studies.verified_at; the badge renders on nothing else. */
  verified: boolean;
};

const fmt = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

const basicSavings = Math.round((1 - BASIC_ANNUAL_CENTS / (BASIC_MONTHLY_CENTS * 12)) * 100);
const plusSavings  = Math.round((1 - PLUS_ANNUAL_CENTS  / (PLUS_MONTHLY_CENTS  * 12)) * 100);

// ── Feature lists ──────────────────────────────────────────────────────────
const FREE_FEATURES = [
  { section: 'Family Organization', items: ['Shared family calendar', 'Shared shopping lists', 'Shared to-do lists', 'Shared recipes', 'Family messenger', 'Family contact book'] },
  { section: 'Family Members',      items: ['Up to 5 family members'] },
  { section: 'Platforms',           items: ['Web', 'iPhone', 'Android', 'iPad'] },
  { section: 'Basic Features',      items: ['Calendar sync', 'Basic reminders', 'Shared notes', 'Shared photos', 'Shared documents'] },
  { section: 'AI',                  items: ['10 AI requests/month'] },
];

const BASIC_FEATURES = [
  { section: 'Unlimited Family Members', items: ['Parents', 'Kids', 'Grandparents', 'Caregivers'] },
  { section: 'Family Hub',               items: ['Chores', 'Rewards', 'Meal planning', 'Grocery planning', 'School hub', 'Sports hub'] },
  { section: 'Unlimited Storage',        items: ['Photos', 'Videos', 'Documents'] },
  { section: 'Kitchen Display Mode',     items: ['iPad', 'Android tablet', 'Browser', 'Smart display'] },
  { section: 'AI Features (Unlimited)', items: ['AI Daily Briefing', 'AI Meal Planning', 'AI Grocery Builder', 'AI Schedule Assistant'] },
  { section: 'Smart Imports',            items: ['Upload school flyers, PDFs, screenshots, photos', 'AI auto-creates calendar events, tasks & reminders'] },
];

const PLUS_FEATURES = [
  { section: 'AI Concierge', items: ['"What\'s happening today?"', '"What do the kids need?"', '"What forms are due?"', '"What\'s for dinner?"', '"Who can pick up Jackson?"'] },
  { section: 'AI School Assistant',  items: ['School emails', 'Permission slips', 'Assignments', 'Deadlines'] },
  { section: 'AI Sports Assistant',  items: ['Team schedules', 'Schedule changes', 'Game updates', 'Practice reminders'] },
  { section: 'AI Family Briefings',  items: ['Morning & evening daily briefing', 'Weekly: upcoming conflicts, school deadlines, financial reminders'] },
  { section: 'AI Family Command Center', items: ['Family readiness score', 'Schedule conflict detection', 'Family stress prediction', 'Transportation planning', 'Missing item detection'] },
  { section: 'Family Digital Twin',  items: ['Learns family preferences, routines, habits & activities', 'Proactively makes recommendations'] },
];

// ── Above-the-fold differentiators ──────────────────────────────────────────
// The highest-value Bubaly features, made easy to understand and find (vs. the
// market). Each is a real, shipped surface — this strip just raises visibility.
type HiTier = 'Family Basic' | 'Family+';
const HI_BADGE: Record<HiTier, { className: string; labelKey: string }> = {
  'Family Basic': { className: 'bg-blue-500/15 text-blue-300 ring-blue-400/30', labelKey: 'pricingValue.tierBasic' },
  'Family+': { className: 'bg-violet-500/15 text-violet-300 ring-violet-400/30', labelKey: 'pricingValue.tierPlus' },
};

// The six outcomes the homepage leads with (lib/marketing/hero-outcomes.ts),
// in the same order, each carrying the tier that delivers it — plus Kitchen
// Mode as the seventh tile. Nothing here is authored twice: the titles and
// bodies are the heroOutcomes.* keys the homepage rail renders, so a copy fix
// lands on both pages at once. `title` keeps the English for tests; the tile
// renders tr(titleKey).
type Highlight = { key: string; icon: LucideIcon; title: string; titleKey: string; descKey: string; tier: HiTier };
const OUTCOME_TIER: Record<string, HiTier> = {
  'heroOutcomes.runToday': 'Family Basic',
  'heroOutcomes.chores': 'Family Basic',
  'heroOutcomes.feedFamily': 'Family Basic',
  'heroOutcomes.school': 'Family+',
  'heroOutcomes.health': 'Family Basic',
  'heroOutcomes.home': 'Family+',
};
const SWITCH_HIGHLIGHTS: Highlight[] = [
  ...HERO_OUTCOMES.map((outcome) => ({
    key: outcome.titleKey,
    icon: outcome.icon,
    title: outcome.titleKey,
    titleKey: outcome.titleKey,
    descKey: outcome.bodyKey,
    tier: OUTCOME_TIER[outcome.titleKey] ?? ('Family Basic' as HiTier),
  })),
  { key: 'kitchenMode', icon: MonitorSmartphone, title: 'Kitchen Mode', titleKey: 'kitchenMode.eyebrow', descKey: 'kitchenMode.title', tier: 'Family Basic' },
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
        {SWITCH_HIGHLIGHTS.map(({ key, icon: Icon, titleKey, descKey, tier }) => (
          <div key={key} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-2">
              <Icon className="h-6 w-6 text-violet-300" aria-hidden />
              <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1', HI_BADGE[tier].className)}>
                {tr(HI_BADGE[tier].labelKey)}
              </span>
            </div>
            <p className="mt-3 text-sm font-bold">{tr(titleKey)}</p>
            <p className="mt-1 text-xs leading-relaxed text-white/65">{tr(descKey)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── How the free trial works ────────────────────────────────────────────────
const TRIAL_STEPS: { icon: React.ReactNode; title: string; desc: string }[] = [
  { icon: <Sparkles className="h-5 w-5 text-violet-300" />, title: 'Start free',
    desc: 'Full Family Basic access for 5 days — no credit card required.' },
  { icon: <Lock className="h-5 w-5 text-violet-300" />, title: 'After 5 days',
    desc: 'Your account locks. Log back in anytime and choose Family Basic or Family+ to unlock it all.' },
  { icon: <ArrowLeftRight className="h-5 w-5 text-violet-300" />, title: 'Switch anytime',
    desc: 'On Family+? Downgrade to Family Basic whenever you like — no need to start over.' },
  { icon: <Archive className="h-5 w-5 text-violet-300" />, title: 'Yours to keep',
    desc: 'Close your account anytime. We keep your data safe, so it’s all here if you come back.' },
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
              <p className="mt-3 text-sm font-bold">{s.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-white/65">{s.desc}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ── Plan card ──────────────────────────────────────────────────────────────
function PlanCard({
  name, goal, icon, price, priceSub, perDay, footnote, outcomes, cta, ctaHref, featured, featureSections, prelude, badge,
}: {
  name: string;
  goal: string;
  icon: React.ReactNode;
  price: string;
  priceSub: string;
  /** "≈ 28¢ a day" — rendered UNDER the monthly price, never instead of it; paid tiers only. */
  perDay?: string;
  /** A one-line reassurance under the price block (Family+: cancel or downgrade anytime). */
  footnote?: string;
  /** The outcome-first column: what stops landing on the family on this tier. */
  outcomes: ValueOutcome[];
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
        {price !== 'Free' && <span className="pb-1.5 text-white/60">/mo</span>}
      </div>
      {/* Under the monthly price, never instead of it — and only on the paid
          tiers, where a per-day figure means something. */}
      {perDay && <p className="mt-1 text-sm font-semibold text-white/80">{perDay}</p>}
      <p className="mt-1 min-h-[18px] text-xs text-white/50">{priceSub}</p>
      {footnote && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-white/60">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
          {footnote}
        </p>
      )}

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

      {outcomes.length > 0 && (
        <div className="mt-6 border-t border-white/10 pt-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/50">{tr('planOutcomes.heading')}</p>
          <ul className="mt-2 space-y-2">
            {outcomes.map((outcome) => (
              <li key={outcome.labelKey} className="flex items-start gap-2 text-sm font-medium text-white/90">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden />
                <span>{tr(outcome.labelKey)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 space-y-4 border-t border-white/10 pt-6">
        {prelude && <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">{prelude}</p>}
        {featureSections.map((fs) => (
          <div key={fs.section}>
            <p className="mb-1.5 text-xs font-bold text-white/70">{fs.section}</p>
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
  { key: 'free', label: '5-Day Trial', dot: 'bg-emerald-400' },
  { key: 'basic', label: 'Family Basic', dot: 'bg-blue-400' },
  { key: 'plus', label: 'Family+', dot: 'bg-violet-400' },
];
const TIER_RANK: Record<MatrixTier, number> = { free: 0, basic: 1, plus: 2 };

// Tier positioning: what each plan is for, in one line, from the same
// registry the value matrix reads (lib/marketing/value.ts). Family Basic keeps
// the factual replacement line — the competitors are NAMED, never priced —
// and Family+ is sold on fewer decisions landing on the family rather than on
// a category claim.
const POSITIONING_DOT: Record<MatrixTier, string> = {
  free: 'bg-emerald-400',
  basic: 'bg-blue-400',
  plus: 'bg-violet-400',
};
const TIER_POSITIONING = VALUE_TIERS.map((tier) => ({
  key: (tier.key === 'trial' ? 'free' : tier.key) as MatrixTier,
  label: tier.label,
  labelKey: tier.labelKey,
  positioningKey: tier.positioningKey,
}));

function PositioningCallouts() {
  const tr = useTranslations();
  return (
    <div className="mt-7 grid gap-3 sm:grid-cols-3">
      {TIER_POSITIONING.map((tier) => (
        <div key={tier.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <span className={cn('h-2 w-2 rounded-full', POSITIONING_DOT[tier.key])} /> {tr(tier.labelKey)}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/65">{tr(tier.positioningKey)}</p>
        </div>
      ))}
    </div>
  );
}

// ── Case studies ───────────────────────────────────────────────────────────
// At most two admin-published family stories, beside the value block. Nothing
// renders when an admin has published none — no placeholder, no invented
// family — and the "Verified outcome" badge follows case_studies.verified_at
// exactly as the homepage band does.
function CaseStudyCards({ caseStudies }: { caseStudies: PricingCaseStudy[] }) {
  const tr = useTranslations();
  const studies = caseStudies.slice(0, 2);
  if (studies.length === 0) return null;
  return (
    <section className="mt-6" aria-label={tr('socialProof.caseStudiesTitle')}>
      <h2 className="text-center text-lg font-semibold">{tr('socialProof.caseStudiesTitle')}</h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {studies.map((study) => (
          <li key={study.id} className="showcase-card flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold">{study.title}</h3>
              {study.verified && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-white/85">
                  <ShieldCheck className="h-3 w-3 text-emerald-400" aria-hidden />
                  {tr('socialProof.verifiedBadge')}
                </span>
              )}
            </div>
            {study.customerName && <p className="mt-1 text-xs text-white/55">{study.customerName}</p>}
            {study.summary && <p className="mt-3 flex-1 text-sm leading-6 text-white/75">{study.summary}</p>}
            {study.resultMetric && (
              <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/50">{tr('socialProof.resultLabel')} · {tr('socialProof.customerWords')}</p>
                <p className="mt-1 text-sm font-medium text-white/90">{study.resultMetric}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
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
                  <span className="inline-flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', t.dot)} />{t.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((sec) => (
              <FeatureMatrixSection key={sec.section} section={sec.section} items={sec.items} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FeatureMatrixSection({ section, items }: { section: string; items: { label: string; tier: MatrixTier }[] }) {
  return (
    <>
      <tr className="bg-white/[0.04]">
        <td colSpan={4} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/55">{section}</td>
      </tr>
      {items.map((it) => (
        <tr key={it.label} className="border-t border-white/[0.06]">
          <td className="px-4 py-2.5 text-white/85">{it.label}</td>
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
export function PricingContent({
  familiesCount = 0,
  featureMatrix = [],
  handledStats = { handledCompleted: 0, handled30d: 0 },
  sampleNumbers = { today: 0, clashes: 0, handled: 0, minutes: 0 },
  caseStudies = [],
  switching = null,
}: {
  familiesCount?: number;
  featureMatrix?: FeatureMatrix;
  /** Cross-family completed-run counts from public_handled_stats(); below the floor the REAL card is omitted. */
  handledStats?: HandledStatsLike;
  /** The fictional family's brief numbers, computed on the server by lib/marketing/handled-sample.ts. */
  sampleNumbers?: PricingValueSample;
  /** Admin-published case studies, already shaped by the server page. */
  caseStudies?: PricingCaseStudy[];
  /** The compact switching band, rendered by the server page and handed in (this file cannot import lib/i18n/server). */
  switching?: ReactNode;
}) {
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
  // Per-day framing (lib/marketing/value.ts): ceil-derived from the same plan
  // constants the price above it uses, so the line can never claim a cheaper
  // day than the family actually pays. Paid tiers only — the trial has no price.
  const basicPerDay = tr('pricingValue.perDay', { amount: formatPerDay(perDayCents(yearly ? BASIC_ANNUAL_CENTS : BASIC_MONTHLY_CENTS, period)) });
  const plusPerDay  = tr('pricingValue.perDay', { amount: formatPerDay(perDayCents(yearly ? PLUS_ANNUAL_CENTS : PLUS_MONTHLY_CENTS, period)) });
  const trialCopy = valueTier('trial');
  const basicCopy = valueTier('basic');
  const plusCopy  = valueTier('plus');

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

        {/* What you're paying for — the tier matrix and the three-source
            panel, directly above the plan cards so the value is read before
            the price. Case studies (at most two, admin-published) sit with it. */}
        <PricingValueBlock handled={handledStats} sample={sampleNumbers} />
        <CaseStudyCards caseStudies={caseStudies} />

        {/* Plan cards — responsive 1 / 2 / 3 columns */}
        <section className="mt-10 grid gap-4 sm:mt-12 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          <PlanCard
            name="5-Day Free Trial"
            goal={tr(trialCopy.goalKey)}
            icon={<Zap className="h-7 w-7 text-white/60" />}
            price="Free"
            priceSub="Family Basic for 5 days, then choose a plan"
            outcomes={trialCopy.outcomes}
            cta="Start your free trial"
            ctaHref="/signup"
            prelude="Your free trial includes Family Basic:"
            featureSections={FREE_FEATURES}
          />

          <PlanCard
            name="Family Basic"
            goal={tr(basicCopy.goalKey)}
            icon={<Crown className="h-7 w-7 text-yellow-400" />}
            price={basicPrice}
            priceSub={basicPriceSub}
            perDay={basicPerDay}
            outcomes={basicCopy.outcomes}
            cta="Start Family Basic"
            ctaHref={`/signup?plan=basic&billing=${period}`}
            featured
            badge="MOST POPULAR"
            prelude="Everything in your trial, plus:"
            featureSections={BASIC_FEATURES}
          />

          <PlanCard
            name="Family+"
            goal={tr(plusCopy.goalKey)}
            icon={<Sparkles className="h-7 w-7 text-violet-400" />}
            price={plusPrice}
            priceSub={plusPriceSub}
            perDay={plusPerDay}
            footnote={tr('pricingValue.cancelAnytime')}
            outcomes={plusCopy.outcomes}
            cta="Start Family+"
            ctaHref={`/signup?plan=plus&billing=${period}`}
            prelude="Everything in Family Basic, plus:"
            featureSections={PLUS_FEATURES}
          />
        </section>

        {/* How the 5-day free trial works — the model, in plain language. */}
        <HowTrialWorks />

        {/* Differentiators — the highest-value features, placed below the plan
            cards so pricing details lead the page. */}
        <WhySwitch />

        {/* Switching is the easy part — the compact band, rendered by the
            server page (it reads lib/i18n/server, which this client module
            must not) and handed in as a prop. */}
        {switching && (
          <section className="showcase-panel mt-8 p-5 sm:p-7">
            <h2 className="text-center text-2xl font-black">{tr('switching.title')}</h2>
            <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">{tr('switching.body')}</p>
            <div className="mt-6">{switching}</div>
          </section>
        )}

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
