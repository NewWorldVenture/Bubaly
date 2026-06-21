'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Zap, Crown, Sparkles } from 'lucide-react';
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

// ── Main component ─────────────────────────────────────────────────────────
export function PricingContent({ familiesCount = 0 }: { familiesCount?: number }) {
  const [period, setPeriod] = useState<Period>('yearly');
  const yearly = period === 'yearly';

  const basicPrice    = yearly ? fmt(Math.round(BASIC_ANNUAL_CENTS / 12)) : fmt(BASIC_MONTHLY_CENTS);
  const basicPriceSub = yearly ? `billed ${fmt(BASIC_ANNUAL_CENTS)}/yr · save ${basicSavings}%` : 'billed monthly';
  const plusPrice     = yearly ? fmt(Math.round(PLUS_ANNUAL_CENTS / 12))  : fmt(PLUS_MONTHLY_CENTS);
  const plusPriceSub  = yearly ? `billed ${fmt(PLUS_ANNUAL_CENTS)}/yr · save ${plusSavings}%`  : 'billed monthly';

  return (
    <PageWrap>
      <Container className="pb-16 pt-10">
        {/* Hero */}
        <section className="mx-auto max-w-3xl text-center">
          <h1 className="text-5xl font-black leading-[1.08] sm:text-6xl">
            FamilyOS Pricing
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-white/65">
            Start free. Upgrade when your family is ready.
          </p>

          {/* Billing toggle */}
          <div className="mt-7 inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1 text-sm">
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
              <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">
                Save up to {basicSavings}%
              </span>
            )}
          </div>
        </section>

        {/* Plan cards — 3 columns */}
        <section className="mt-10 grid gap-5 lg:grid-cols-3">
          <PlanCard
            name="FamilyOS Free"
            goal="Become the default family organizer."
            icon={<Zap className="h-7 w-7 text-white/60" />}
            price="Free"
            priceSub="No credit card required"
            cta="Get started free"
            ctaHref="/signup"
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
            prelude="Everything in Free, plus:"
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

        {/* Smart Imports callout */}
        <section className="showcase-panel mt-8 p-7">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
            <div className="shrink-0 text-3xl">📸</div>
            <div>
              <h2 className="font-bold">Smart Imports — the feature most competitors don&apos;t offer well</h2>
              <p className="mt-1 text-sm text-white/65">
                Snap a school flyer, upload a PDF, or share a screenshot. FamilyOS AI automatically creates calendar events, tasks, and reminders — no manual entry.
              </p>
            </div>
          </div>
        </section>

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
