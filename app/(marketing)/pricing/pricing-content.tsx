'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Zap, Crown, Sparkles, Lock, ArrowLeftRight, Archive, PlayCircle, Loader2 } from 'lucide-react';
import { startDemoAction } from '@/app/(marketing)/demo/actions';
import {
  Container,
  GradientText,
  PageWrap,
  TrustStrip,
} from '@/components/marketing/visual-mocks';
import { cn } from '@/lib/utils/cn';
import { familiesNote } from '@/lib/marketing/format';
import {
  BASIC_MONTHLY_CENTS,
  BASIC_ANNUAL_CENTS,
  PLUS_MONTHLY_CENTS,
  PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';

type Period = 'monthly' | 'yearly';

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
type HiTier = 'Free' | 'Family Basic' | 'Family+';
const HI_BADGE: Record<HiTier, string> = {
  'Free': 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
  'Family Basic': 'bg-blue-500/15 text-blue-300 ring-blue-400/30',
  'Family+': 'bg-violet-500/15 text-violet-300 ring-violet-400/30',
};

const SWITCH_HIGHLIGHTS: { emoji: string; title: string; desc: string; tier: HiTier }[] = [
  { emoji: '🛒', title: 'Shopping & Lists', tier: 'Free',
    desc: 'Shared shopping and grocery lists the whole family keeps in sync — front and center.' },
  { emoji: '📥', title: 'AI Family Inbox & Front Desk', tier: 'Family+',
    desc: 'One place for calls, emails, forms, school notes and appointments — Bubaly reads them and acts.' },
  { emoji: '📸', title: 'Smart Imports', tier: 'Family Basic',
    desc: 'Snap a school flyer, PDF or screenshot — AI creates the calendar events, tasks and reminders.' },
  { emoji: '🖥️', title: 'Kitchen Mode', tier: 'Family Basic',
    desc: 'Turn any tablet or smart display into a family command center on the counter.' },
  { emoji: '👛', title: 'Family Wallet & Allowance', tier: 'Free',
    desc: 'Allowances, chores-to-rewards and family money — built in, not a separate app.' },
  { emoji: '🩺', title: 'Health, Meds & Records', tier: 'Family Basic',
    desc: 'Medications, appointments and a secure medical-records locker where competitors are weak.' },
  { emoji: '🛟', title: 'Emergency Hub', tier: 'Family+',
    desc: 'Critical info, documents and contacts ready the moment your family needs them.' },
  { emoji: '🚗', title: 'Transportation & Rides', tier: 'Family+',
    desc: 'Who’s picking up whom — rides, carpools and pickups planned for you by AI.' },
];

function WhySwitch() {
  return (
    <section className="mt-12">
      <h2 className="text-center text-2xl font-black">Why families switch to Bubaly</h2>
      <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">
        The highest-value things Bubaly does that most family apps don’t — in plain language.
      </p>
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SWITCH_HIGHLIGHTS.map((h) => (
          <div key={h.title} className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl" aria-hidden>{h.emoji}</span>
              <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1', HI_BADGE[h.tier])}>
                {h.tier}
              </span>
            </div>
            <p className="mt-3 text-sm font-bold">{h.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-white/65">{h.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── How the free trial works ────────────────────────────────────────────────
const TRIAL_STEPS: { icon: React.ReactNode; title: string; desc: string }[] = [
  { icon: <Sparkles className="h-5 w-5 text-violet-300" />, title: 'Start free',
    desc: 'Full access to everything for 5 days — no credit card required.' },
  { icon: <Lock className="h-5 w-5 text-violet-300" />, title: 'After 5 days',
    desc: 'Your account locks. Log back in anytime and choose Family Basic or Family+ to unlock it all.' },
  { icon: <ArrowLeftRight className="h-5 w-5 text-violet-300" />, title: 'Switch anytime',
    desc: 'On Family+? Downgrade to Family Basic whenever you like — no need to start over.' },
  { icon: <Archive className="h-5 w-5 text-violet-300" />, title: 'Yours to keep',
    desc: 'Close your account anytime. We keep your data safe, so it’s all here if you come back.' },
];

function HowTrialWorks() {
  return (
    <section className="mt-10">
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <h2 className="text-center text-xl font-black sm:text-2xl">How your free trial works</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">
          Five days on the house — then pick the plan that fits your family. No surprises.
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
/** The one-click, no-signup demo submit button (server action). */
function TryDemoButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-brand text-sm font-bold text-white shadow-glow transition hover:opacity-90 disabled:opacity-70"
    >
      {pending
        ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting your demo…</>
        : <><PlayCircle className="h-5 w-5" /> Login Now to Try Me</>}
    </button>
  );
}

/** The compact "Demo Account" card that floats to the left of the hero title:
 *  one click → a fully-seeded Family+ demo for 5 minutes. */
function TestAccountCard() {
  return (
    <article className="relative w-full overflow-hidden rounded-2xl border border-emerald-400/40 bg-gradient-to-br from-emerald-500/[0.12] to-white/[0.03] p-5 text-left ring-1 ring-emerald-400/20">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-400/30">
          <Zap className="h-6 w-6 text-emerald-400" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-black">Demo Account</h2>
            <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">
              Free · 5-min demo
            </span>
          </div>
          <p className="mt-0.5 text-xs text-white/60">
            No card needed — logs you straight into full Family+.
          </p>
        </div>
      </div>

      <form action={startDemoAction}>
        <TryDemoButton />
      </form>
    </article>
  );
}

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
  return (
    <article className={cn(
      'relative flex flex-col rounded-2xl p-7',
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

// Competitor-positioning callouts (how each tier stacks up vs the market).
const TIER_POSITIONING: { key: MatrixTier; label: string; dot: string; line: string }[] = [
  { key: 'free', label: '5-Day Free Trial', dot: 'bg-emerald-400',
    line: 'Unlock the full Bubaly experience free for 5 days — every feature, no credit card. After that, choose Family Basic or Family+ to keep going.' },
  { key: 'basic', label: 'Family Basic', dot: 'bg-blue-400',
    line: 'A direct replacement for Cozi Gold, FamilyWall Premium, OurHome, FamCal, and Skylight — at one family price.' },
  { key: 'plus', label: 'Family+', dot: 'bg-violet-400',
    line: 'Category creator: your family’s AI Chief of Staff — beyond a traditional organizer.' },
];

function PositioningCallouts() {
  return (
    <div className="mt-7 grid gap-3 sm:grid-cols-3">
      {TIER_POSITIONING.map((t) => (
        <div key={t.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <span className={cn('h-2 w-2 rounded-full', t.dot)} /> {t.label}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/65">{t.line}</p>
        </div>
      ))}
    </div>
  );
}

function FeatureMatrixTable({ matrix }: { matrix: FeatureMatrix }) {
  if (matrix.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="text-center text-2xl font-black">Every feature, by plan</h2>
      <p className="mx-auto mt-2 max-w-xl text-center text-sm text-white/60">
        Your 5-day free trial includes everything. After that, a check means the feature is included on that plan (and every plan above it).
      </p>
      <PositioningCallouts />
      <div className="mt-7 overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="px-4 py-3 text-left font-bold">Feature</th>
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
export function PricingContent({ familiesCount = 0, featureMatrix = [] }: { familiesCount?: number; featureMatrix?: FeatureMatrix }) {
  const [period, setPeriod] = useState<Period>('yearly');
  const yearly = period === 'yearly';
  const router = useRouter();

  // Keep the tier/feature grid live: an admin change to /admin/tier-features
  // revalidates this page, and re-fetching on an interval + on tab focus means
  // an already-open pricing page reflects the change automatically.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 20_000);
    const onFocus = () => router.refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [router]);

  const basicPrice    = yearly ? fmt(Math.round(BASIC_ANNUAL_CENTS / 12)) : fmt(BASIC_MONTHLY_CENTS);
  const basicPriceSub = yearly ? `billed ${fmt(BASIC_ANNUAL_CENTS)}/yr · save ${basicSavings}%` : 'billed monthly';
  const plusPrice     = yearly ? fmt(Math.round(PLUS_ANNUAL_CENTS / 12))  : fmt(PLUS_MONTHLY_CENTS);
  const plusPriceSub  = yearly ? `billed ${fmt(PLUS_ANNUAL_CENTS)}/yr · save ${plusSavings}%`  : 'billed monthly';

  return (
    <PageWrap>
      <Container className="pb-16 pt-10">
        {/* Hero with the Demo Account card floated to its left, vertically
            centered beside the title. Three columns: [card | hero+toggle |
            spacer] keep the hero optically centered. On mobile it collapses to a
            single column — hero first, then the demo card. */}
        <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto_1fr]">
          {/* Demo Account card — left column. */}
          <div className="order-2 w-full justify-self-center lg:order-1 lg:max-w-sm lg:justify-self-start">
            <TestAccountCard />
          </div>

          {/* Hero + billing toggle — center column. */}
          <section className="order-1 mx-auto max-w-2xl text-center lg:order-2">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300/80">
              Less Managing Life. More Living It.
            </p>
            <h1 className="mt-3 text-5xl font-black leading-[1.08] sm:text-6xl">
              Bubaly Pricing
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg text-white/65">
              Try everything free for 5 days — no credit card required. After that, keep it all with Family Basic or Family+.
            </p>

            <div className="mt-7 flex justify-center">
              <div className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1 text-sm">
                <button
                  onClick={() => setPeriod('monthly')}
                  className={cn('rounded-full px-6 py-2 font-bold transition', period === 'monthly' ? 'bg-violet-600 text-brand-fg' : 'text-white/65 hover:text-white')}
                >
                  Monthly
                </button>
                <button
                  onClick={() => setPeriod('yearly')}
                  className={cn('rounded-full px-6 py-2 font-bold transition', period === 'yearly' ? 'bg-violet-600 text-brand-fg' : 'text-white/65 hover:text-white')}
                >
                  Yearly
                </button>
                {yearly && (
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                    Save up to {basicSavings}%
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* Right spacer — keeps the hero optically centered on desktop. */}
          <div className="hidden lg:block" aria-hidden />
        </div>

        {/* Plan cards — 3 columns */}
        <section className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <PlanCard
            name="5-Day Free Trial"
            goal="Experience all of Bubaly — free, no credit card."
            icon={<Zap className="h-7 w-7 text-white/60" />}
            price="Free"
            priceSub="for 5 days, then choose a plan"
            cta="Start your free trial"
            ctaHref="/signup"
            prelude="Your trial includes:"
            featureSections={FREE_FEATURES}
          />

          <PlanCard
            name="Family Basic"
            goal="The best family organizer on earth."
            icon={<Crown className="h-7 w-7 text-yellow-400" />}
            price={basicPrice}
            priceSub={basicPriceSub}
            cta="Start Family Basic"
            ctaHref={`/signup?plan=basic&billing=${period}`}
            featured
            badge="MOST POPULAR"
            prelude="Everything in your trial, plus:"
            featureSections={BASIC_FEATURES}
          />

          <PlanCard
            name="Family+"
            goal="The Family Chief of Staff."
            icon={<Sparkles className="h-7 w-7 text-violet-400" />}
            price={plusPrice}
            priceSub={plusPriceSub}
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

        {/* Smart Imports callout */}
        <section className="showcase-panel mt-8 p-7">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
            <div className="shrink-0 text-3xl">📸</div>
            <div>
              <h2 className="font-bold">Smart Imports — the feature most competitors don&apos;t offer well</h2>
              <p className="mt-1 text-sm text-white/65">
                Snap a school flyer, upload a PDF, or share a screenshot. Bubaly AI automatically creates calendar events, tasks, and reminders — no manual entry.
              </p>
            </div>
          </div>
        </section>

        <FeatureMatrixTable matrix={featureMatrix} />

        <TrustStrip familiesNote={familiesNote(familiesCount)} />

        <p className="border-t border-white/8 pt-7 text-center text-sm text-white/55">
          Questions? Visit our{' '}
          <a className="text-violet-300 hover:underline" href="/faq">Help Center</a>
          {' '}or{' '}
          <a className="text-violet-300 hover:underline" href="/contact">Contact Support</a>
        </p>
      </Container>
    </PageWrap>
  );
}
