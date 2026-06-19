import type { Metadata } from 'next';
import { UserPlus, Users, CalendarPlus, Sparkles } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'How it works',
  description: 'Get your whole household running on FamilyOS in four simple steps.',
};

const STEPS = [
  { icon: UserPlus, title: 'Create your family', body: 'Sign up in seconds and set up your household. You become the family admin with full control.' },
  { icon: Users, title: 'Invite everyone', body: 'Send invites to your spouse, teens, kids, and caregivers. Each person gets exactly the right level of access.' },
  { icon: CalendarPlus, title: 'Add your world', body: 'Drop in school schedules, sports practices, chores, meals, and meds — or just ask the AI to do it for you.' },
  { icon: Sparkles, title: 'Let the AI run point', body: 'Ask “summarize our week” or “plan dinners and build the grocery list.” It takes action, not just notes.' },
];

export default function HowItWorksPage() {
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="How it works"
          title="From chaos to calm in four steps"
          description="Most families are fully set up in under ten minutes."
        />
      </Section>
      <Section className="pt-0">
        <ol className="mx-auto max-w-3xl space-y-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="glass-card flex gap-5 p-6">
              <div className="flex flex-col items-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-brand-fg shadow-glow">
                  <s.icon className="h-6 w-6" />
                </div>
                {i < STEPS.length - 1 && <div className="mt-2 w-px flex-1 bg-border" />}
              </div>
              <div className="pb-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-brand">Step {i + 1}</p>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>
      <CTASection />
    </>
  );
}
