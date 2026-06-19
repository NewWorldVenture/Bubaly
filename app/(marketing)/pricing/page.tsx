import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CheckCircle2,
  Crown,
  Home,
  Lock,
  MonitorSmartphone,
  Shield,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import {
  Container,
  GradientText,
  IconOrb,
  PageWrap,
  Rating,
  TrustStrip,
} from '@/components/marketing/visual-mocks';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple pricing for happier families.',
};

const PLANS = [
  {
    name: 'Free',
    icon: Sparkles,
    price: '$0',
    sub: 'Perfect for trying FamilyOS',
    color: 'text-violet-400',
    cta: 'Get Started Free',
    featured: false,
    features: ['1 Family', 'Up to 5 Members', 'Shared Calendar', 'Chores & Tasks', 'Grocery Lists', 'Notes & Documents (1 GB)', 'Basic AI Assistant (10 uses/mo)', 'Mobile & Web Access'],
  },
  {
    name: 'Plus',
    icon: UsersRound,
    price: '$6.99',
    sub: 'More features for growing families',
    color: 'text-emerald-400',
    cta: 'Start Plus Plan',
    featured: false,
    features: ['Up to 10 Members', 'Meal Planning', 'School & Activities', 'Home Management', 'Reminders & Notifications', 'Documents (10 GB)', 'AI Assistant (Unlimited)', 'Priority Support'],
  },
  {
    name: 'Family',
    icon: Crown,
    price: '$12.99',
    sub: 'The complete AI-powered family OS',
    color: 'text-yellow-400',
    cta: 'Start Family Plan',
    featured: true,
    features: ['Unlimited Members', 'AI Family Chief of Staff', 'Smart Scheduling', 'Health & Medications', 'Advanced Reports', 'Documents (100 GB)', 'Custom Categories', 'Priority Support'],
  },
  {
    name: 'Family+',
    icon: Home,
    price: '$19.99',
    sub: 'For larger families & advanced needs',
    color: 'text-blue-400',
    cta: 'Start Family+ Plan',
    featured: false,
    features: ['Multi-Home Support', 'Advanced AI Automations', 'Expense Tracker', 'Caregiver Access', 'Audit & Activity Logs', 'Documents (1 TB)', 'API Access', 'Dedicated Support'],
  },
] as const;

const INCLUDED = ['Secure & Private', 'Real-time Sync', 'Mobile & Web Access', 'iOS & Android Apps', 'Ad-Free Experience', 'Data Encryption', 'Cancel Anytime'];

export default function PricingPage() {
  return (
    <PageWrap>
      <Container className="pb-14 pt-10 lg:pb-16">
        <section className="mx-auto max-w-4xl text-center">
          <h1 className="text-5xl font-black leading-[1.08] sm:text-6xl">
            Simple pricing for <br />
            <GradientText>happier families.</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-white/72">
            Choose the plan that works for your family. Upgrade, downgrade, or cancel anytime. No long-term contracts.
          </p>
          <div className="mt-6 inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1 text-sm">
            <span className="rounded-full bg-violet-600 px-6 py-2 font-bold text-white">Monthly</span>
            <span className="px-4 py-2 text-white/70">Yearly</span>
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">Save 20%</span>
          </div>
        </section>

        <section className="mt-9 grid gap-5 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <PricingCard key={plan.name} plan={plan} />
          ))}
        </section>

        <section className="showcase-panel mt-8 overflow-hidden">
          <div className="grid grid-cols-[1.3fr_repeat(4,1fr)] text-center">
            <div className="p-8 text-left">
              <h2 className="text-xl font-bold">All plans include</h2>
              <div className="mt-7 space-y-5 text-sm">
                {INCLUDED.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-white/70" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            {PLANS.map((plan) => (
              <div key={plan.name} className={cn('relative p-8', plan.featured && 'rounded-2xl border border-violet-400/50 bg-white/[0.035]')}>
                {plan.featured && (
                  <span className="absolute -top-0 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-3 py-1 text-[10px] font-black">
                    MOST POPULAR
                  </span>
                )}
                <h3 className="text-lg font-bold">{plan.name}</h3>
                <div className="mt-7 space-y-5">
                  {INCLUDED.map((item) => (
                    <CheckCircle2 key={item} className={cn('mx-auto h-5 w-5', plan.color)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="showcase-card mt-7 flex flex-col gap-6 rounded-2xl p-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-6">
            <IconOrb icon={Shield} className="h-16 w-16 rounded-xl" />
            <div>
              <h2 className="text-lg font-bold">14-Day Happiness Guarantee</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-white/68">
                If FamilyOS does not make your family life easier, we will refund your payment. No questions asked.
              </p>
            </div>
          </div>
          <Link href="/faq" className="inline-flex h-12 items-center justify-center rounded-xl border border-violet-400/50 px-8 text-sm font-bold text-violet-200">
            Learn More
          </Link>
        </section>

        <section className="mt-10">
          <h2 className="text-center text-3xl font-bold">
            Loved by <GradientText>10,000+</GradientText> families
          </h2>
          <div className="mt-7 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {['FamilyOS has become the heart of our family.', 'The AI Assistant saves me hours every week.', 'Finally, an app that brings everything together in one place.', 'The school flyer scanner is a game changer.'].map((quote, index) => (
              <article key={quote} className="showcase-card rounded-xl p-6">
                <Rating />
                <p className="mt-4 min-h-[82px] text-sm leading-6 text-white/82">&quot;{quote}&quot;</p>
                <p className="mt-4 text-sm font-bold">{['Sarah J.', 'Michael T.', 'Jessica L.', 'David R.'][index]}</p>
                <p className="text-xs text-white/55">{['Mom of 3', 'Dad of 2', 'Mom of 4', 'Dad of 3'][index]}</p>
              </article>
            ))}
          </div>
        </section>

        <TrustStrip />

        <p className="border-t border-white/8 pt-7 text-center text-sm text-white/60">
          Questions? We&apos;re here to help. Visit our <a className="text-violet-300" href="/faq">Help Center</a> or <a className="text-violet-300" href="/contact">Contact Support</a>
        </p>
      </Container>
    </PageWrap>
  );
}

function PricingCard({ plan }: { plan: (typeof PLANS)[number] }) {
  const Icon = plan.icon;
  return (
    <article className={cn('showcase-card relative flex min-h-[560px] flex-col rounded-2xl p-8', plan.featured && 'border-violet-400/80 shadow-glow')}>
      {plan.featured && (
        <span className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-4 py-1 text-[11px] font-black">
          MOST POPULAR
        </span>
      )}
      <Icon className={cn('h-10 w-10', plan.color)} />
      <h2 className="mt-5 text-2xl font-black">{plan.name}</h2>
      <p className="mt-3 min-h-[48px] text-sm leading-6 text-white/76">{plan.sub}</p>
      <div className="mt-5 flex items-end gap-1">
        <span className="text-5xl font-black">{plan.price}</span>
        <span className="pb-2 text-white/72">/month</span>
      </div>
      <ul className="mt-7 flex-1 space-y-3 text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-center gap-3">
            <CheckCircle2 className={cn('h-5 w-5', plan.color)} />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Link
        href={`/signup?plan=${plan.name.toLowerCase().replace('+', 'plus')}`}
        className={cn(
          'mt-8 inline-flex h-14 items-center justify-center rounded-xl border border-violet-400/65 px-5 text-base font-black text-violet-200',
          plan.featured && 'border-none bg-gradient-to-r from-blue-500 to-violet-600 text-white shadow-glow',
        )}
      >
        {plan.cta}
      </Link>
    </article>
  );
}
