import Link from 'next/link';
import {
  Calendar, CheckSquare, UtensilsCrossed, ShoppingCart, HeartPulse, Home,
  FolderLock, Sparkles, Bell, Shield, ArrowRight, Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section, SectionHeading, FeatureCard, Eyebrow } from '@/components/marketing/sections';

const FEATURES = [
  { icon: Calendar, title: 'Shared calendar', description: 'Every practice, appointment, and school event in one synced view the whole family trusts.' },
  { icon: CheckSquare, title: 'Chores & rewards', description: 'Assign chores, let kids check them off, approve with a tap, and track points.' },
  { icon: UtensilsCrossed, title: 'Meal planning', description: 'Plan the week’s dinners and auto-build a grocery list from the ingredients.' },
  { icon: ShoppingCart, title: 'Grocery lists', description: 'Shared, real-time lists that update the moment anyone checks something off.' },
  { icon: HeartPulse, title: 'Health & meds', description: 'Medication schedules and appointment reminders so nothing slips.' },
  { icon: Home, title: 'Home maintenance', description: 'Track assets like the HVAC and never miss a filter change again.' },
  { icon: FolderLock, title: 'Document vault', description: 'Secure, private storage for the documents that matter, with expiry reminders.' },
  { icon: Sparkles, title: 'AI assistant', description: 'Ask “summarize our week” or “add soccer every Tuesday” — it actually does it.' },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <Section className="pt-20 text-center sm:pt-28">
        <div className="mx-auto max-w-3xl">
          <Eyebrow>Pennyworth for families</Eyebrow>
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
            Run your family like a{' '}
            <span className="gradient-text">calm, connected team</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted sm:text-xl">
            FamilyOS is an AI chief of staff for busy households. Calendar, chores, meals, grocery,
            school, health, home, and documents — in one warm, intelligent place.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup">
              <Button size="lg" className="w-full sm:w-auto">
                Get started free <ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
            <Link href="/how-it-works">
              <Button size="lg" variant="secondary" className="w-full sm:w-auto">
                See how it works
              </Button>
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted">
            Free 14-day trial · No credit card · Cancel anytime
          </p>
        </div>

        {/* Floating preview card */}
        <div className="mx-auto mt-16 max-w-4xl">
          <div className="glass-card overflow-hidden p-2 shadow-glow">
            <div className="rounded-xl bg-bg/60 p-6 text-left">
              <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted">Good morning</p>
                  <p className="text-lg font-semibold">Here’s your family today</p>
                </div>
                <Sparkles className="h-6 w-6 text-brand" />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {[
                  { label: '3 events', sub: 'Soccer · Dentist · Recital', icon: Calendar },
                  { label: '5 chores', sub: '2 awaiting approval', icon: CheckSquare },
                  { label: 'Taco night', sub: 'Grocery list ready', icon: UtensilsCrossed },
                ].map((c) => (
                  <div key={c.label} className="rounded-xl border border-border bg-surface/60 p-4">
                    <c.icon className="h-5 w-5 text-brand" />
                    <p className="mt-2 font-semibold">{c.label}</p>
                    <p className="text-xs text-muted">{c.sub}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Features */}
      <Section id="features">
        <SectionHeading
          eyebrow="Everything in one place"
          title="One calm home for everything your family juggles"
          description="No more scattered apps, group texts, and sticky notes. FamilyOS brings it together — and an AI assistant keeps it moving."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </Section>

      {/* Social proof */}
      <Section className="py-12">
        <div className="glass-card mx-auto max-w-3xl p-8 text-center">
          <div className="flex justify-center gap-1 text-warning">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} className="h-5 w-5 fill-current" />
            ))}
          </div>
          <blockquote className="mt-4 text-xl font-medium">
            “It’s like having a household manager. The mental load just… lifted. The whole family
            finally runs on the same page.”
          </blockquote>
          <p className="mt-4 text-sm text-muted">— A very relieved parent of three</p>
        </div>
      </Section>

      {/* Trust / security strip */}
      <Section className="py-12">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            { icon: Shield, title: 'Private by design', body: 'Row-level security guarantees no family ever sees another’s data.' },
            { icon: Bell, title: 'Never miss a thing', body: 'Smart reminders for chores, meds, events, and expiring documents.' },
            { icon: Sparkles, title: 'AI that takes action', body: 'It doesn’t just chat — it creates events, chores, and lists for you.' },
          ].map((i) => (
            <div key={i.title} className="flex gap-4">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                <i.icon className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-semibold">{i.title}</h3>
                <p className="mt-1 text-sm text-muted">{i.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* CTA */}
      <Section>
        <div className="glass-card relative overflow-hidden p-10 text-center sm:p-16">
          <div className="relative z-10">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Bring the calm home
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-muted">
              Set up your family in minutes. Invite everyone. Let the AI handle the rest.
            </p>
            <Link href="/signup" className="mt-8 inline-block">
              <Button size="lg">
                Start your free trial <ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
