import type { Metadata } from 'next';
import {
  Calendar, CheckSquare, UtensilsCrossed, ShoppingCart, GraduationCap, Trophy,
  HeartPulse, Home, FolderLock, StickyNote, Target, Sparkles, Bell, CreditCard,
} from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Every module FamilyOS gives your household — calendar, chores, meals, grocery, school, sports, health, home, documents, notes, goals, and an AI assistant.',
};

const MODULES = [
  { icon: Calendar, title: 'Shared calendar', description: 'A single source of truth for events, appointments, and recurring activities — color-coded per family member.' },
  { icon: CheckSquare, title: 'Chores & rewards', description: 'Assign and schedule chores, let kids complete them, approve with one tap, and track points toward rewards.' },
  { icon: UtensilsCrossed, title: 'Meal planning', description: 'Plan the week, save favorite recipes, and turn any meal plan into a grocery list automatically.' },
  { icon: ShoppingCart, title: 'Grocery lists', description: 'Real-time shared lists with categories. Everyone sees updates the instant an item is checked off.' },
  { icon: GraduationCap, title: 'School', description: 'Track school events, holidays, exams, and parent meetings per child in one place.' },
  { icon: Trophy, title: 'Sports & activities', description: 'Practices, games, and tournaments with recurrence — never miss a Tuesday soccer again.' },
  { icon: HeartPulse, title: 'Health & medication', description: 'Medication schedules with day-of-week timing and appointment reminders for the whole family.' },
  { icon: Home, title: 'Home maintenance', description: 'Track home assets and recurring maintenance like HVAC filters, with smart due-date reminders.' },
  { icon: FolderLock, title: 'Document vault', description: 'Private, encrypted-at-rest storage with signed URLs and expiry reminders for IDs, insurance, and more.' },
  { icon: StickyNote, title: 'Notes & lists', description: 'Shared notes and checklists for everything that doesn’t fit a box — pinned to the top when it matters.' },
  { icon: Target, title: 'Family goals', description: 'Set shared goals, track progress, and celebrate together when you hit them.' },
  { icon: Sparkles, title: 'AI assistant', description: 'An assistant that takes real action: creates events, chores, reminders, meal plans, and grocery items.' },
  { icon: Bell, title: 'Smart notifications', description: 'Timely push and email nudges for due chores, meds, events, and expiring documents.' },
  { icon: CreditCard, title: 'Roles & billing', description: 'Six built-in roles with the right access for each member, plus subscription-ready billing.' },
];

export default function FeaturesPage() {
  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow="Features"
          title="Everything your family juggles, in one calm place"
          description="FamilyOS replaces the scattered apps, group texts, and sticky notes with one warm, intelligent system."
        />
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <FeatureCard key={m.title} {...m} />
          ))}
        </div>
      </Section>
      <CTASection />
    </>
  );
}
