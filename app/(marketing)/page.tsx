import {
  CalendarDays,
  CheckSquare2,
  Folder,
  GraduationCap,
  Heart,
  Sparkles,
  UtensilsCrossed,
} from 'lucide-react';
import {
  Container,
  FEATURE_RAIL,
  FamilyAiPanel,
  GradientText,
  IconOrb,
  OutlineLink,
  PageWrap,
  Pill,
  PrimaryLink,
  ProductMockup,
  SocialProofLine,
  TestimonialBand,
} from '@/components/marketing/visual-mocks';

export default function HomePage() {
  return (
    <PageWrap>
      <Container className="pb-16 pt-16 lg:pb-20 lg:pt-20">
        <section className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <Pill icon={CalendarDays}>Your family. Organized. Connected. Stress-free.</Pill>
            <h1 className="mt-7 max-w-2xl text-5xl font-black leading-[1.08] sm:text-6xl lg:text-7xl">
              Run your family like a <GradientText>calm, connected</GradientText> team.
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-white/78">
              FamilyOS is the all-in-one family operating system that brings schedules, chores, meals,
              school, health, and more into one simple, beautiful app.
            </p>
            <div className="mt-9 flex flex-col gap-4 sm:flex-row">
              <PrimaryLink href="/signup">Get Started Free</PrimaryLink>
              <OutlineLink href="/how-it-works">See How It Works</OutlineLink>
            </div>
            <div className="mt-10">
              <SocialProofLine />
            </div>
          </div>
          <ProductMockup />
        </section>

        <section className="mt-20 border-t border-white/8 pt-9">
          <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-6">
            {FEATURE_RAIL.map(({ icon, title, body, tone }) => (
              <div key={title} className="text-center">
                <IconOrb icon={icon} tone={tone} />
                <h3 className="mt-5 text-lg font-bold">{title}</h3>
                <p className="mx-auto mt-2 max-w-[180px] text-sm leading-6 text-white/68">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-16">
          <FamilyAiPanel />
        </div>

        <div className="mt-8">
          <TestimonialBand />
        </div>

        <section className="sr-only">
          <h2>FamilyOS modules</h2>
          <ul>
            {[CalendarDays, CheckSquare2, UtensilsCrossed, GraduationCap, Heart, Folder, Sparkles].map((Icon, index) => (
              <li key={index}>
                <Icon /> Built for busy families.
              </li>
            ))}
          </ul>
        </section>
      </Container>
    </PageWrap>
  );
}
