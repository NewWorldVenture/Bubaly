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
import { getPublicStats } from '@/lib/marketing/stats';
import { familiesHeadline } from '@/lib/marketing/format';

export default async function HomePage() {
  const { families } = await getPublicStats();
  return (
    <PageWrap>
      <Container className="pb-16 pt-14 sm:pt-16 lg:pb-24 lg:pt-24">
        <section className="grid items-center gap-12 lg:grid-cols-[0.92fr_1.08fr] lg:gap-16">
          <div>
            <Pill icon={CalendarDays}>The operating system for family life</Pill>
            <h1 className="mt-6 max-w-2xl text-[2.6rem] font-bold leading-[1.05] sm:text-6xl lg:text-7xl">
              Run your family like a <GradientText>calm, connected</GradientText> team.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-white/65 sm:text-lg sm:leading-8">
              One beautiful place for schedules, chores, meals, school, health, and an AI assistant
              that actually does the work — so the whole household stays effortlessly in sync.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-4">
              <PrimaryLink href="/signup">Get Started Free</PrimaryLink>
              <OutlineLink href="/how-it-works">See How It Works</OutlineLink>
            </div>
            <div className="mt-9">
              <SocialProofLine text={familiesHeadline(families)} />
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
