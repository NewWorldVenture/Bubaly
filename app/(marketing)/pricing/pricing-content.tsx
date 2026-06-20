'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Crown, Shield } from 'lucide-react';
import {
  Container,
  GradientText,
  IconOrb,
  PageWrap,
  TrustStrip,
} from '@/components/marketing/visual-mocks';
import { cn } from '@/lib/utils/cn';
import { familiesNote } from '@/lib/marketing/format';
import { FAMILY_MONTHLY_CENTS, FAMILY_ANNUAL_CENTS } from '@/lib/constants/plans';

type BillingPeriod = 'monthly' | 'yearly';

const fmtUsd = (cents: number) =>
  (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// One real, purchasable plan — the same product wired to Stripe checkout.
const MONTHLY_DISPLAY = fmtUsd(FAMILY_MONTHLY_CENTS); // $9.99
const ANNUAL_PER_MONTH = fmtUsd(Math.round(FAMILY_ANNUAL_CENTS / 12)); // ~$8.00
const ANNUAL_TOTAL = fmtUsd(FAMILY_ANNUAL_CENTS); // $95.99
const ANNUAL_SAVINGS_PCT = Math.round(
  (1 - FAMILY_ANNUAL_CENTS / (FAMILY_MONTHLY_CENTS * 12)) * 100,
);

const FAMILY_FEATURES = [
  'Unlimited family members + caregivers',
  'Shared calendar, chores & grocery lists',
  'Meal planning & auto grocery lists',
  'Health, home & document vault',
  'Unlimited AI assistant',
  'Push & email notifications',
  '100 GB private document storage',
];

const INCLUDED = [
  'Secure & private (row-level isolation)',
  'Real-time sync across devices',
  'Works on web + installable PWA',
  'Ad-free, your data is never sold',
  'Encrypted at rest and in transit',
  'Cancel anytime — no contracts',
];

export function PricingContent({ familiesCount = 0 }: { familiesCount?: number }) {
  const [billing, setBilling] = useState<BillingPeriod>('yearly');
  const yearly = billing === 'yearly';

  return (
    <PageWrap>
      <Container className="pb-14 pt-10 lg:pb-16">
        <section className="mx-auto max-w-4xl text-center">
          <h1 className="text-5xl font-black leading-[1.08] sm:text-6xl">
            Simple pricing for <br />
            <GradientText>happier families.</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-white/72">
            One plan with everything included. Upgrade, downgrade, or cancel anytime. No long-term contracts.
          </p>
          <div className="mt-6 inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1 text-sm">
            <button
              type="button"
              onClick={() => setBilling('monthly')}
              aria-pressed={billing === 'monthly'}
              className={cn(
                'rounded-full px-6 py-2 font-bold transition',
                billing === 'monthly' ? 'bg-violet-600 text-white' : 'text-white/70',
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling('yearly')}
              aria-pressed={billing === 'yearly'}
              className={cn(
                'rounded-full px-6 py-2 font-bold transition',
                billing === 'yearly' ? 'bg-violet-600 text-white' : 'text-white/70',
              )}
            >
              Yearly
            </button>
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">
              Save {ANNUAL_SAVINGS_PCT}%
            </span>
          </div>
        </section>

        <section className="mt-9 flex justify-center">
          <article className="showcase-card relative flex w-full max-w-md flex-col rounded-2xl border-violet-400/80 p-8 shadow-glow">
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-4 py-1 text-[11px] font-black">
              EVERYTHING INCLUDED
            </span>
            <Crown className="h-10 w-10 text-yellow-400" />
            <h2 className="mt-5 text-2xl font-black">FamilyOS Family</h2>
            <p className="mt-3 text-sm leading-6 text-white/76">
              The complete AI-powered family operating system for your whole household.
            </p>
            <div className="mt-5 flex items-end gap-1">
              <span className="text-5xl font-black">{yearly ? ANNUAL_PER_MONTH : MONTHLY_DISPLAY}</span>
              <span className="pb-2 text-white/72">/month</span>
            </div>
            <p className="mt-2 text-xs text-white/60">
              {yearly ? `billed annually at ${ANNUAL_TOTAL}/yr` : 'billed monthly'}
            </p>
            <ul className="mt-7 flex-1 space-y-3 text-sm">
              {FAMILY_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-yellow-400" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Link
              href={`/signup?billing=${yearly ? 'annual' : 'monthly'}`}
              className="mt-8 inline-flex h-14 items-center justify-center rounded-xl border-none bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-base font-black text-white shadow-glow"
            >
              Get Started
            </Link>
            <p className="mt-3 text-center text-xs text-white/55">
              Choose monthly or annual billing at checkout.
            </p>
          </article>
        </section>

        <section className="showcase-panel mt-8 p-8">
          <h2 className="text-xl font-bold">Always included</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {INCLUDED.map((item) => (
              <div key={item} className="flex items-center gap-3 text-sm">
                <Shield className="h-5 w-5 shrink-0 text-white/70" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="showcase-card mt-7 flex flex-col gap-6 rounded-2xl p-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <IconOrb icon={Shield} className="h-16 w-16 rounded-xl" />
            <div>
              <h2 className="text-lg font-bold">Cancel anytime</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-white/68">
                Manage or cancel your subscription whenever you like from your billing settings.
                No contracts, no cancellation fees.
              </p>
            </div>
          </div>
          <Link href="/faq" className="inline-flex h-12 items-center justify-center rounded-xl border border-violet-400/50 px-8 text-sm font-bold text-violet-200">
            Learn More
          </Link>
        </section>

        <section className="mt-10">
          <h2 className="text-center text-3xl font-bold">
            Everything your family needs, <GradientText>in one plan</GradientText>
          </h2>
          <div className="mt-7 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {[
              ['One home base', 'Calendar, chores, meals, school, and health together instead of scattered across apps.'],
              ['AI that takes action', 'Plan meals, build grocery lists, and schedule events from a single plain-language request.'],
              ['Scan & capture', 'Turn school flyers and documents into calendar events and reminders automatically.'],
              ['Private by design', 'Row-level security and private storage keep every household fully isolated.'],
            ].map(([title, body]) => (
              <article key={title} className="showcase-card rounded-xl p-6">
                <h3 className="text-base font-bold">{title}</h3>
                <p className="mt-3 min-h-[82px] text-sm leading-6 text-white/82">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <TrustStrip familiesNote={familiesNote(familiesCount)} />

        <p className="border-t border-white/8 pt-7 text-center text-sm text-white/60">
          Questions? We&apos;re here to help. Visit our <a className="text-violet-300" href="/faq">Help Center</a> or <a className="text-violet-300" href="/contact">Contact Support</a>
        </p>
      </Container>
    </PageWrap>
  );
}
