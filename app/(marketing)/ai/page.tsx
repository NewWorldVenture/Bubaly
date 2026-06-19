import type { Metadata } from 'next';
import { Sparkles, Calendar, CheckSquare, ShoppingCart, Bell, UtensilsCrossed } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'Family AI Assistant',
  description: 'Meet your household’s AI chief of staff. It doesn’t just answer — it creates events, chores, reminders, meal plans, and grocery lists for you.',
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
          title="An AI chief of staff for your household"
          description="Ask in plain language. FamilyOS takes real action in your family’s data — securely, within your family only."
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
            your household by the same row-level security that protects the rest of FamilyOS.
          </p>
          <h3 className="mt-6 text-lg font-semibold">Model-agnostic by design</h3>
          <p className="mt-2 text-sm text-muted">
            FamilyOS uses a provider abstraction, so it can run on Claude, GPT, Gemini, or local
            models — and switch without changing how your family experiences it.
          </p>
        </div>
      </Section>
      <CTASection title="Meet your family’s assistant" subtitle="Try it free for 14 days." />
    </>
  );
}
