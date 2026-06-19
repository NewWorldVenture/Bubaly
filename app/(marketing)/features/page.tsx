import type { Metadata } from 'next';
import {
  CalendarDays,
  CheckCircle2,
  CheckSquare2,
  FolderHeart,
  GraduationCap,
  Heart,
  Home,
  HousePlus,
  ListPlus,
  ShoppingCart,
  Sparkles,
  UtensilsCrossed,
} from 'lucide-react';
import {
  CheckList,
  Container,
  FEATURE_TOPICS,
  FeaturePreviewCard,
  GradientText,
  IconOrb,
  MiniCalendar,
  PageWrap,
  Pill,
  SmallCtaBand,
  TrustStrip,
} from '@/components/marketing/visual-mocks';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Everything your family needs in one intelligent place.',
};

export default function FeaturesPage() {
  return (
    <PageWrap>
      <Container className="pb-14 pt-10 lg:pb-16">
        <section className="mx-auto max-w-5xl text-center">
          <Pill>All-in-one family operating system</Pill>
          <h1 className="mt-7 text-5xl font-black leading-[1.1] sm:text-6xl">
            Everything your family needs, <br />
            <GradientText>all in one intelligent place.</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-white/72">
            FamilyOS combines powerful tools with AI intelligence to help your family stay organized,
            connected, and ahead of what matters most.
          </p>
        </section>

        <section className="mt-12 grid gap-7 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
          {FEATURE_TOPICS.map(({ icon, title, tone }) => (
            <div key={title} className="text-center">
              <IconOrb icon={icon} tone={tone} />
              <h2 className="mx-auto mt-4 max-w-[150px] text-lg font-bold leading-7">{title}</h2>
            </div>
          ))}
        </section>

        <section className="mt-10 border-t border-white/8 pt-8 text-center">
          <h2 className="text-4xl font-black">Powerful features. Peaceful families.</h2>
          <p className="mt-4 text-lg text-white/68">Discover how FamilyOS makes everyday life easier.</p>
        </section>

        <section className="mt-8 grid gap-5 lg:grid-cols-4">
          <FeaturePreviewCard
            icon={CalendarDays}
            tone="violet"
            title="Smart Calendar"
            description="See everyone's schedule in one place. AI automatically adds events from emails, texts, and school updates."
          >
            <MiniCalendar />
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={CheckSquare2}
            tone="green"
            title="Tasks & Chores"
            description="Assign chores, track progress, and reward good habits. AI suggests tasks based on your family's routine."
          >
            <CheckList items={['Take out the trash', 'Water plants', 'Set the table', 'Load dishwasher']} />
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={UtensilsCrossed}
            tone="orange"
            title="Meal Planning"
            description="Plan meals for the week, automatically create grocery lists, and discover recipes your family will love."
          >
            <div className="space-y-3 text-sm">
              {['Garlic Butter Salmon', 'Chicken Tacos', 'Spaghetti Bolognese', 'Teriyaki Chicken'].map((meal, index) => (
                <div key={meal} className="grid grid-cols-[42px_1fr] gap-3">
                  <span className="text-white/50">{['Mon', 'Tue', 'Wed', 'Thu'][index]}</span>
                  <span>{meal}</span>
                </div>
              ))}
            </div>
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={ShoppingCart}
            tone="green"
            title="Grocery Lists"
            description="Smart lists that update automatically based on your meal plan and what you actually need."
          >
            <CheckList items={['Milk', 'Eggs', 'Chicken Breast', 'Broccoli', 'Avocados']} color="text-white/45" />
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={GraduationCap}
            tone="blue"
            title="School Hub"
            description="Keep track of homework, assignments, school events, important dates, and teacher communications."
          >
            <div className="space-y-3 text-sm">
              {['Math Homework', 'Science Project', 'Field Trip'].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <FolderHeart className="h-5 w-5 text-blue-400" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={Heart}
            tone="pink"
            title="Health & Medications"
            description="Never miss a dose or appointment. Get smart reminders and keep health info all in one place."
          >
            <div className="space-y-3 text-sm">
              {['Liam - Allergy Medication', 'Olivia - Vitamin D', 'Dentist Appointment'].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <span className="h-7 w-7 rounded-full bg-gradient-to-br from-amber-200 to-rose-300" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={Home}
            tone="green"
            title="Home Management"
            description="Track maintenance, warranties, important documents, and reminders to keep your home running smoothly."
          >
            <div className="space-y-3 text-sm">
              {['HVAC Filter Change', 'Garage Door Service', 'Water Heater Flush'].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <HousePlus className="h-5 w-5 text-white/55" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </FeaturePreviewCard>

          <FeaturePreviewCard
            icon={Sparkles}
            tone="violet"
            title="AI Family Assistant"
            description="Your AI sidekick that helps plan, organize, and keep your family ahead of everything."
          >
            <div className="space-y-3 text-sm">
              <div className="ml-auto w-fit rounded-lg bg-violet-600 px-3 py-2 text-xs">What&apos;s happening this week?</div>
              <div className="rounded-lg bg-white/[0.06] p-3 text-xs">You have 6 events this week, 2 chores due, and 1 appointment.</div>
              <div className="ml-auto w-fit rounded-lg bg-violet-600 px-3 py-2 text-xs">Plan dinners for the week</div>
              <div className="mx-auto mt-4 h-10 w-10 rounded-full border border-violet-300 bg-gradient-to-br from-cyan-300 to-violet-600 shadow-glow" />
            </div>
          </FeaturePreviewCard>
        </section>

        <div className="mt-8">
          <SmallCtaBand />
        </div>

        <TrustStrip />

        <section className="sr-only">
          <ListPlus />
          <CheckCircle2 />
        </section>
      </Container>
    </PageWrap>
  );
}
