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
  DeviceShowcase,
  FEATURE_RAIL,
  FamilyAiPanel,
  GradientText,
  HeroPhoneMockup,
  IconOrb,
  PageWrap,
  Pill,
  PlatformBadges,
  PrimaryLink,
  SocialProofLine,
  TestimonialBand,
  WatchDemoLink,
} from '@/components/marketing/visual-mocks';

export default function HomePage() {
  return (
    <PageWrap>
      {/* ── Hero ── */}
      <Container className="max-w-[1180px] pb-0 pt-10 sm:pt-14 lg:pt-8">
        <section className="grid items-center gap-12 lg:min-h-[690px] lg:grid-cols-[1.08fr_.92fr] lg:gap-10">

          {/* Left */}
          <div className="order-1 text-center lg:text-left">
            <Pill icon={Sparkles}>AI-Powered Family Command Center</Pill>

            <h1 className="mt-6 text-[clamp(3rem,11vw,4.25rem)] font-black leading-[1.02] tracking-[-0.04em] lg:text-[4.65rem]">
              Everything your<br />
              family needs.<br />
              <GradientText>In one place.</GradientText>
            </h1>

            <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-white/70 sm:text-lg sm:leading-8 lg:mx-0">
              FamilyOS is your AI-powered Operating System for family life. Stay organized, connected, and ahead of what matters most.
            </p>

            <div className="mt-8 flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-center lg:justify-start">
              <PrimaryLink href="/signup">Start Free Trial</PrimaryLink>
              <WatchDemoLink href="/how-it-works">Watch Demo</WatchDemoLink>
            </div>

            <div className="mt-8 flex justify-center lg:justify-start">
              <PlatformBadges />
            </div>

            <div className="mt-8 flex justify-center lg:justify-start">
              <SocialProofLine />
            </div>
          </div>

          {/* Right — phone mockup */}
          <div className="order-2 flex justify-center overflow-hidden py-4 lg:justify-end lg:overflow-visible lg:py-0">
            <HeroPhoneMockup className="w-full max-w-[300px] sm:max-w-[340px] lg:max-w-[350px]" />
          </div>
        </section>
      </Container>

      {/* ── Tagline divider ── */}
      <div className="mt-16 border-y border-white/8 bg-white/[0.018] py-7 text-center lg:mt-4">
        <p className="text-xl font-semibold text-white/80 sm:text-2xl">
          Your entire family, perfectly organized
        </p>
      </div>

      {/* ── Feature rail ── */}
      <Container className="max-w-[1180px] pb-5 pt-12 sm:pt-14">
        <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
          {FEATURE_RAIL.map(({ icon, title, body, tone }) => (
            <div key={title} className="group flex flex-col items-center text-center">
              <IconOrb icon={icon} tone={tone} className="transition group-hover:scale-110" />
              <h3 className="mt-4 text-sm font-bold">{title}</h3>
              <p className="mx-auto mt-2 max-w-[160px] text-xs leading-5 text-white/55">{body}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ── AI Family Assistant ── */}
      <Container className="max-w-[1180px] pb-4 pt-10">
        <FamilyAiPanel />
      </Container>

      {/* ── Testimonials ── */}
      <Container className="max-w-[1180px] pb-4 pt-5">
        <TestimonialBand />
      </Container>

      {/* ── Device showcase ── */}
      <Container className="max-w-[1180px] pb-16 pt-0 sm:pb-20">
        <DeviceShowcase />
      </Container>

      {/* Hidden SEO content */}
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
    </PageWrap>
  );
}
