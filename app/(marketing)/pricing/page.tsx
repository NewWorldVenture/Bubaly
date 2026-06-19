import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { PLANS } from '@/lib/constants/plans';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple, family-friendly pricing. Start free, upgrade when you’re ready. No credit card to begin.',
};

export default function PricingPage() {
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple pricing for the whole family"
          description="Start free for 14 days. No credit card required. Cancel anytime."
        />
      </Section>
      <Section className="pt-0">
        <div className="grid gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={cn(
                'glass-card flex flex-col p-7',
                plan.featured && 'ring-2 ring-brand shadow-glow',
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                {plan.featured && <Badge tone="brand">Most popular</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">{plan.tagline}</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-bold">
                  {plan.priceMonthly === 0 ? 'Free' : `$${(plan.priceMonthly / 100).toFixed(0)}`}
                </span>
                {plan.priceMonthly > 0 && <span className="text-muted">/month</span>}
              </div>
              <p className="mt-1 text-xs text-muted">
                {plan.seats === 'Unlimited' ? 'Unlimited members' : `Up to ${plan.seats} members`}
              </p>
              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href={`/signup?plan=${plan.id}`} className="mt-7">
                <Button variant={plan.featured ? 'primary' : 'secondary'} className="w-full">
                  {plan.priceMonthly === 0 ? 'Start free' : `Choose ${plan.name}`}
                </Button>
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          All plans include row-level security, encrypted document storage, and the AI assistant.
        </p>
      </Section>
    </>
  );
}
