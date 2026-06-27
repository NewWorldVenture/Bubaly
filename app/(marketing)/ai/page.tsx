import type { Metadata } from 'next';
import {
  Sparkles, Calendar, CheckSquare, ShoppingCart, Bell, UtensilsCrossed,
  Phone, Mail, MessageSquare, FileText, CalendarClock, BookHeart, Sun, Gauge, Zap,
} from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

// The Family Front Desk concierge — mirrors the in-app /dashboard/front-desk hub
// so the public story matches the product.
const CONCIERGE = [
  { icon: Phone, title: 'AI Phone Concierge', description: 'Answers calls, schedules appointments, routes requests, and escalates only when it’s really you they need.' },
  { icon: Mail, title: 'AI Email Concierge', description: 'Reads email, extracts the actions, files documents, and updates your calendars and task lists.' },
  { icon: MessageSquare, title: 'AI SMS Concierge', description: 'Handles texts from schools, coaches, and service providers with the same intelligence as your calls.' },
  { icon: FileText, title: 'AI Document Concierge', description: 'Understands permission slips, medical forms, invoices, and registrations — and files them automatically.' },
  { icon: CalendarClock, title: 'AI Scheduling Agent', description: 'Negotiates meeting and appointment times across each person’s calendar based on real availability.' },
  { icon: Zap, title: 'AI Automation Engine', description: 'Converts every inbound message into the right task, event, reminder, shopping item, or archived record.' },
  { icon: BookHeart, title: 'AI Family Memory', description: 'A searchable timeline of every interaction, document, event, and decision — so nothing is ever lost.' },
  { icon: Sun, title: 'AI Personal Assistant', description: 'Delivers each family member a personalized daily briefing instead of making them go digging.' },
  { icon: Gauge, title: 'AI Executive Dashboard', description: 'Shows parents only what needs a decision today, with one-tap approval for the routine stuff.' },
];

export const metadata: Metadata = {
  title: 'Family AI Assistant',
  description: 'Meet your household’s AI chief of staff. It doesn’t just answer — it creates events, chores, reminders, meal plans, and grocery lists for you, so you spend less time managing life and more time living it.',
};

const PROMPTS = [
  { icon: Calendar, text: '“Add soccer practice every Tuesday at 5pm.”' },
  { icon: UtensilsCrossed, text: '“Create a dinner plan for this week.”' },
  { icon: ShoppingCart, text: '“Build a grocery list from our meal plan.”' },
  { icon: CheckSquare, text: '“Create chores for the kids this weekend.”' },
  { icon: Bell, text: '“Remind us to change the HVAC filter in 90 days.”' },
  { icon: Sparkles, text: '“Summarize our week.”' },
];

export default function AIPage() {
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="AI assistant"
          title="Your family’s AI Front Desk & Chief of Staff"
          description="Ask in plain language. Bubaly takes real action in your family’s data — securely, within your family only — so you spend less time managing life and more time living it."
        />
      </Section>
      <Section className="pt-0">
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
          {PROMPTS.map((p) => (
            <div key={p.text} className="glass-card flex items-center gap-4 p-5">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                <p.icon className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">{p.text}</p>
            </div>
          ))}
        </div>

        <div className="glass-card mx-auto mt-10 max-w-3xl p-7">
          <h3 className="text-lg font-semibold">It takes action, not just notes</h3>
          <p className="mt-2 text-sm text-muted">
            When you ask the assistant to add an event or build a list, it actually creates those
            records in your family’s database — then confirms what it did. Everything stays scoped to
            your household by the same row-level security that protects the rest of Bubaly.
          </p>
          <h3 className="mt-6 text-lg font-semibold">Model-agnostic by design</h3>
          <p className="mt-2 text-sm text-muted">
            Bubaly uses a provider abstraction, so it can run on Claude, GPT, Gemini, or local
            models — and switch without changing how your family experiences it.
          </p>
        </div>
      </Section>
      {/* Family Front Desk — the full concierge */}
      <Section className="pt-4">
        <SectionHeading
          eyebrow="Your Family Front Desk"
          title="One front desk for your whole family"
          description="Bubaly answers, reads, files, schedules, and remembers — so the invisible work of family life is handled before it reaches you."
        />
        <div className="mx-auto mt-12 grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CONCIERGE.map((c) => (
            <FeatureCard key={c.title} icon={c.icon} title={c.title} description={c.description} />
          ))}
        </div>
      </Section>

      <CTASection title="Meet your family’s assistant" subtitle="Try it free for 14 days." />
    </>
  );
}
