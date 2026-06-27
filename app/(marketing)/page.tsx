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
  LessMoreBand,
  ManifestoBand,
  PageWrap,
  Pill,
  PlatformBadges,
  PrimaryLink,
  TestimonialBand,
  WatchDemoLink,
} from '@/components/marketing/visual-mocks';

export default async function HomePage() {
  return (
    <PageWrap>
      {/* ── Hero ── */}
      <Container className="max-w-[1440px] px-5 pb-0 pt-10 sm:px-8 sm:pt-12 lg:px-10 lg:pt-5">
        <section className="grid items-center gap-12 lg:min-h-[650px] lg:grid-cols-[1.05fr_.95fr] lg:gap-8">

          {/* Left */}
          <div className="order-1 text-center lg:text-left">
            <Pill icon={Sparkles}>The AI Operating System for Family Life</Pill>

            <h1 className="mt-6 text-[clamp(3rem,11vw,4.1rem)] font-extrabold leading-[1.03] tracking-[-0.038em] lg:text-[4.25rem]">
              Less Managing<br />
              Life.<br />
              <GradientText>More Living It.</GradientText>
            </h1>

            <p className="mx-auto mt-5 max-w-[520px] text-[15px] leading-6 text-white/70 sm:text-base sm:leading-7 lg:mx-0">
              Bubaly quietly handles the invisible work of family life—calls, emails, forms, scheduling, and reminders—so you can spend less time managing life and more time living it.
            </p>

            <div className="mt-7 flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-center lg:justify-start">
              <PrimaryLink href="/signup">Start Free Trial</PrimaryLink>
              <WatchDemoLink href="/how-it-works">Watch Demo</WatchDemoLink>
            </div>
            <div className="mt-6 flex justify-center lg:justify-start">
              <PlatformBadges />
            </div>
          </div>

          {/* Right — phone mockup */}
          <div className="order-2 flex justify-center overflow-hidden py-4 lg:justify-end lg:overflow-visible lg:py-0">
            <HeroPhoneMockup className="w-full max-w-[278px] sm:max-w-[306px] lg:max-w-[320px]" />
          </div>
        </section>
      </Container>

      {/* ── Tagline divider ── */}
      <div className="mt-12 border-y border-white/[0.06] bg-white/[0.012] py-5 text-center lg:mt-2">
        <p className="text-lg font-semibold text-white/80 sm:text-xl">
          The invisible work of family life, quietly handled
        </p>
      </div>

      {/* ── Feature rail ── */}
      <Container className="max-w-[1440px] px-5 pb-4 pt-10 sm:px-8 sm:pt-12 lg:px-10">
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
          {FEATURE_RAIL.map(({ icon, title, body, tone }) => (
            <div key={title} className="group flex flex-col items-center text-center">
              <IconOrb icon={icon} tone={tone} className="h-14 w-14 transition group-hover:scale-105 [&>svg]:h-6 [&>svg]:w-6" />
              <h3 className="mt-3 text-xs font-semibold">{title}</h3>
              <p className="mx-auto mt-2 max-w-[160px] text-xs leading-5 text-white/55">{body}</p>
            </div>
          ))}
        </div>
      </Container>

      {/* ── Less Managing Life. More Living It. ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-10 sm:px-8 sm:pt-12 lg:px-10">
        <LessMoreBand />
      </Container>

      {/* ── AI Family Assistant ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-8 sm:px-8 lg:px-10">
        <FamilyAiPanel />
      </Container>

      {/* ── Testimonials ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-4 sm:px-8 lg:px-10">
        <TestimonialBand />
      </Container>

      {/* ── Brand manifesto ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-10 sm:px-8 sm:pt-12 lg:px-10">
        <ManifestoBand />
      </Container>

      {/* ── Device showcase ── */}
      <Container className="max-w-[1440px] px-5 pb-12 pt-0 sm:px-8 sm:pb-16 lg:px-10">
        <DeviceShowcase />
      </Container>

      {/* Hidden SEO content */}
      <section className="sr-only">
        <h2>Bubaly — the AI Operating System for family life</h2>
        <p>
          Bubaly helps families spend less time managing life and more time living it. Every call
          answered, every email understood, every form processed, every appointment coordinated, every
          reminder remembered, every routine simplified — so your family can focus on what matters most.
        </p>
        <ul>
          {[CalendarDays, CheckSquare2, UtensilsCrossed, GraduationCap, Heart, Folder, Sparkles].map((Icon, index) => (
            <li key={index}>
              <Icon /> Less managing life, more living it.
            </li>
          ))}
        </ul>
      </section>
    </PageWrap>
  );
}
