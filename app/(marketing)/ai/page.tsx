import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import Link from 'next/link';
import {
  Sparkles, Calendar, UtensilsCrossed, ShoppingCart, CheckSquare, Bell, PiggyBank,
  FileText, ShieldCheck, Newspaper, Zap, Lock, SlidersHorizontal, ArrowRight,
  Sun, Sunset, Moon, Cpu,
} from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';
import { Button } from '@/components/ui/button';
import { AiActionDemo } from '@/components/marketing/ai-showcase';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/ai', {
    title: 'Bubaly AI — the assistant that does the work',
    description:
      'Bubaly’s AI doesn’t just answer questions — it creates the events, chores, reminders, meal plans, grocery lists, and follow-ups that keep family life running. Ask in plain language; it takes real action inside your family’s data, privately and model-agnostically.',
  });
}

const DIFFERENTIATORS = [
  {
    icon: Zap,
    title: 'It acts, it doesn’t just answer',
    body: 'Most assistants hand you a suggestion and leave the work to you. Bubaly writes the actual records — the event lands on the calendar, the chore is assigned, the reminder is set — then tells you exactly what it did.',
  },
  {
    icon: Lock,
    title: 'Private to your family',
    body: 'Every action is scoped to your household by the same row-level security that protects the rest of Bubaly. Your family’s life never trains a public model and is never visible to another family.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Always in your control',
    body: 'You stay the parent. Sensitive actions — money moves, anything touching the kids — route through approval, and every action is logged and reversible. Nothing happens behind your back.',
  },
];

const CAPABILITIES = [
  { icon: Calendar, title: 'Calendar & scheduling', body: 'Add events, spot conflicts, and get leave-by nudges that account for drive time.' },
  { icon: UtensilsCrossed, title: 'Meals & groceries', body: 'Plan the week’s dinners and turn them into an aisle-sorted, pantry-aware list.' },
  { icon: CheckSquare, title: 'Chores & allowance', body: 'Assign age-appropriate chores, split them fairly, and tie them to points or pay.' },
  { icon: Bell, title: 'Reminders & follow-ups', body: 'Never drop the invisible stuff — filters, forms, RSVPs, birthdays, refills.' },
  { icon: PiggyBank, title: 'Money coaching', body: 'Track goals and get plain-language answers about where the family budget stands.' },
  { icon: FileText, title: 'Documents & paperwork', body: 'Turn a school flyer or permission slip into the events and to-dos it really means.' },
  { icon: ShieldCheck, title: 'Family safety', body: 'Screen unknown callers, flag risky contacts, and keep an eye out for the kids.' },
  { icon: Newspaper, title: 'Weekly briefings', body: 'One calm summary of the week ahead — what matters, what’s new, what to prep.' },
];

const DAY = [
  {
    icon: Sun,
    when: 'Morning',
    what: 'The family brief',
    body: '“Everyone’s up: Emma has a math test, the plumber comes at 2, and dinner’s covered. Leave by 7:40 to beat the school drop-off line.”',
  },
  {
    icon: Sunset,
    when: 'Midday',
    what: 'Paperwork, handled',
    body: 'You snap a photo of a field-trip form. Bubaly reads it, adds the trip to the calendar, sets a permission-slip reminder, and flags the $12 fee.',
  },
  {
    icon: Moon,
    when: 'Evening',
    what: 'Tomorrow, pre-solved',
    body: '“Grocery run needed for Thursday’s tacos, Jack’s library book is due, and the vacation fund just hit 68%. Want me to reorder the essentials?”',
  },
];

export default function AIPage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden">
        <div className="ai-hero-glow pointer-events-none absolute inset-0" aria-hidden />
        <Section className="relative pt-20 text-center sm:pt-28">
          <span className="ai-orb mx-auto flex h-16 w-16 items-center justify-center">
            <Sparkles className="h-7 w-7 text-brand-text" />
          </span>

          <span className="mt-8 inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand-text">
            Bubaly AI
          </span>

          <h1 className="mx-auto mt-5 max-w-4xl text-4xl font-bold tracking-tight sm:text-6xl">
            It doesn’t just answer.{' '}
            <span className="gradient-text-violet">It does the work.</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted sm:text-xl">
            Ask in plain language and Bubaly takes real action inside your family’s life — creating
            the events, chores, reminders, meal plans, and lists that would otherwise sit on your
            mental to-do list. The invisible work, done.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup">
              <Button size="lg">
                Start free — 5 days <ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
            <Link
              href="#demo"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
            >
              See it work
            </Link>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-brand-text" /> Family-scoped &amp; private</span>
            <span className="inline-flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-brand-text" /> Takes real action</span>
            <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-brand-text" /> Model-agnostic</span>
          </div>
        </Section>
      </div>

      {/* ── Ask → Act demo (the centerpiece) ─────────────────────────────── */}
      <Section id="demo" className="pt-4">
        <SectionHeading
          eyebrow="Ask → Act"
          title="Say it in plain language. Watch it get done."
          description="Pick a prompt — Bubaly replies and creates the real records, the same cards your family sees inside the app."
        />
        <div className="mt-12">
          <AiActionDemo />
        </div>
      </Section>

      {/* ── Differentiators ──────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow="Not a chatbot — a doer"
          title="The difference is what happens after you ask"
        />
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {DIFFERENTIATORS.map((d) => (
            <div key={d.title} className="glass-card p-7 transition hover:-translate-y-0.5 hover:shadow-glow">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
                <d.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-5 text-lg font-semibold">{d.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{d.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Capabilities ─────────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow="One assistant, the whole household"
          title="Everything it can take off your plate"
          description="Bubaly reaches across your family’s calendar, lists, money, documents, and safety — so a single ask can touch every corner of family life."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="glass-card p-6 transition hover:-translate-y-0.5 hover:shadow-glow">
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
                <c.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{c.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── A day, handled ───────────────────────────────────────────────── */}
      <Section className="pt-0">
        <SectionHeading
          eyebrow="A Tuesday, handled"
          title="What a day feels like with Bubaly in it"
          description="It doesn’t wait to be asked. Bubaly works in the background and surfaces the right thing at the right moment."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {DAY.map((d, i) => (
            <div key={d.when} className="relative glass-card p-7">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
                  <d.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-brand-text">{d.when}</p>
                  <p className="text-base font-semibold">{d.what}</p>
                </div>
                <span className="ml-auto text-sm font-bold text-muted/60">0{i + 1}</span>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted">{d.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <CTASection
        title="Meet the assistant that actually does things"
        subtitle="Set up your family in minutes and let Bubaly handle the logistics — free for 5 days, no credit card."
      />
      <MarketingAeoSection path="/ai" name="Bubaly AI" description="An assistant that takes real action inside your family life." />
    </>
  );
}
