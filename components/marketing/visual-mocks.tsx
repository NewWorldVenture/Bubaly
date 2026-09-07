import Image from 'next/image';
import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
// Re-exported so the many server consumers of this module keep one import.
// They LIVE in `primitives.tsx` because client components need them too, and
// this file imports `lib/i18n/server` — which pulls `next/headers` into any
// bundle that reaches it. See the note at the top of that file.
import { Container, GradientText, IconOrb, PageWrap, TrustStrip } from './primitives';

export { Container, GradientText, IconOrb, PageWrap, TrustStrip };
import {
  Apple,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
  Circle,
  CloudSun,
  Folder,
  GraduationCap,
  Heart,
  Home,
  Mail,
  Monitor,
  PlayCircle,
  Shield,
  Sparkles,
  Tablet,
  TriangleAlert,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { AssistantConversation } from '@/components/marketing/homepage-interactions';
import { cn } from '@/lib/utils/cn';




export function Pill({
  children,
  icon: Icon = Sparkles,
  className,
}: {
  children: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white/90', className)}>
      <Icon className="h-3.5 w-3.5 text-blue-400" />
      {children}
    </span>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 px-7 text-sm font-semibold text-brand-fg shadow-glow transition hover:-translate-y-0.5 hover:brightness-110"
    >
      {children}
    </Link>
  );
}

export function WatchDemoLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-12 items-center justify-center gap-2.5 rounded-lg border border-white/15 bg-white/[0.025] px-7 text-sm font-semibold text-white transition hover:bg-white/[0.07]"
    >
      <PlayCircle className="h-5 w-5 fill-white/20" />
      {children}
    </Link>
  );
}

export function OutlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-14 items-center justify-center gap-2 rounded-xl border border-white/18 bg-white/[0.025] px-7 text-base font-bold text-white transition hover:bg-white/[0.07]"
    >
      <PlayCircle className="h-5 w-5" />
      {children}
    </Link>
  );
}


const FACE_POSITIONS = ['54% 34%', '67% 38%', '79% 31%', '91% 40%', '72% 36%'] as const;

function FaceAvatar({ index, className }: { index: number; className?: string }) {
  return (
    <span
      className={cn('block overflow-hidden rounded-full bg-[#111b28] bg-no-repeat', className)}
      style={{
        backgroundImage: "url('/images/family-ai-lifestyle.png')",
        backgroundPosition: FACE_POSITIONS[index % FACE_POSITIONS.length],
        backgroundSize: '620% auto',
      }}
      aria-hidden="true"
    />
  );
}

export async function PlatformBadges() {
  const t = await getTranslations();
  // Platform names are product names, not copy — iOS and Android read the same
  // in every language. "Designed for" is the only translatable word here.
  const platforms = [
    { icon: Apple, label: 'iOS' },
    { icon: Bot, label: t('visualMocks.android') },
    { icon: Monitor, label: 'Web' },
    { icon: Tablet, label: t('visualMocks.tablet') },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="w-full text-[10px] text-white/55">{t('visualMocks.designedFor')}</span>
      {platforms.map(({ icon: Icon, label }) => (
        <span key={label} className="flex items-center gap-1.5 text-[10px] text-white/55">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
          {label}
        </span>
      ))}
    </div>
  );
}

export async function HeroPhoneMockup({ className }: { className?: string }) {
  const t = await getTranslations();
  const schedule = [
    { time: '8:00 AM', title: t('visualMocks.dentistAppointment'), person: t('visualMocks.emma'), avatar: 3, color: 'bg-rose-400' },
    { time: '9:30 AM', title: t('visualMocks.dadFlightToChicago'), person: t('visualMocks.mike'), avatar: 0, color: 'bg-blue-400' },
    { time: '3:00 PM', title: t('visualMocks.jacksonSoccerPractice'), person: t('visualMocks.jackson'), avatar: 1, color: 'bg-emerald-400' },
    { time: '5:00 PM', title: t('visualMocks.groceryPickup'), person: 'H-E-B', avatar: 2, color: 'bg-orange-400' },
    { time: '7:00 PM', title: t('visualMocks.familyDinner'), person: t('visualMocks.theJohnsons'), avatar: 4, color: 'bg-violet-400' },
  ];

  return (
    <div aria-hidden="true" className={cn('dark relative mx-auto isolate', className)}>
      <div className="pointer-events-none absolute -inset-16 -z-20 rounded-full bg-violet-600/25 blur-[70px]" />
      <div className="pointer-events-none absolute -right-36 top-[24%] -z-10 h-80 w-80 rounded-full border-[3px] border-violet-500/85 shadow-[0_0_65px_rgba(124,77,255,0.82),inset_0_0_65px_rgba(124,77,255,0.3)] sm:-right-48 sm:h-[430px] sm:w-[430px]" />

      {/* Phone shell */}
      <div className="hero-phone-float relative mx-auto w-[278px] rounded-[3.2rem] bg-[linear-gradient(145deg,#8b8d90_0%,#34363a_24%,#111317_58%,#77797c_100%)] p-[6px] shadow-[0_46px_90px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.15)] sm:w-[306px]">
        <span className="absolute -left-[9px] top-28 h-16 w-1.5 rounded-l bg-[#4f5155]" />
        <span className="absolute -right-[9px] top-40 h-20 w-1.5 rounded-r bg-[#4f5155]" />
        {/* Screen */}
        <div className="flex min-h-[570px] flex-col overflow-hidden rounded-[2.8rem] bg-[#080e18] sm:min-h-[620px]">
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 pt-4 pb-2">
            <span className="text-[11px] font-semibold text-white">9:41</span>
            <div className="h-5 w-20 rounded-full bg-black" />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-white/60">●●●</span>
            </div>
          </div>

          <div className="flex flex-1 flex-col px-5 pb-4">
            {/* Greeting */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-bold text-white">{t('visualMocks.goodMorningSarah')}{' '}<span className="text-amber-300">☀</span></p>
                <p className="text-[10px] text-white/55">{t('visualMocks.thursdayMay16')}</p>
              </div>
              <div className="relative shrink-0">
                <FaceAvatar index={2} className="h-9 w-9 border border-white/20" />
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#090f1a] bg-emerald-400" />
              </div>
            </div>

            {/* AI Daily Briefing badge */}
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.045] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-400" />
                <span className="text-[11px] font-semibold text-white">{t('visualMocks.aiDailyBriefing')}</span>
              </div>
              <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[9px] font-bold text-white">New</span>
            </div>

            {/* Stats row */}
            <div className="mt-3 grid grid-cols-4 gap-1.5">
              {[
                { icon: CalendarDays, value: '5', label: t('visualMocks.eventsToday'), color: 'text-violet-400' },
                { icon: CheckSquare2, value: '3', label: t('visualMocks.tasksDue'), color: 'text-emerald-400' },
                { icon: TriangleAlert, value: '2', label: t('visualMocks.conflicts'), color: 'text-rose-400' },
                { icon: CloudSun, value: '72°', label: t('visualMocks.partlyCloudy'), color: 'text-blue-400' },
              ].map(({ icon: Icon, value, label, color }) => (
                <div key={label} className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-1 py-2 text-center">
                  <Icon className={cn('mx-auto mb-1 h-3.5 w-3.5', color)} />
                  <p className={cn('text-[13px] font-bold', color)}>{value}</p>
                  <p className="mt-0.5 text-[8px] leading-tight text-white/55">{label}</p>
                </div>
              ))}
            </div>

            {/* Today's Schedule */}
            <div className="mt-4 flex-1">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-bold text-white">Today&apos;s Schedule</p>
                <span className="text-[9px] text-violet-400">{t('visualMocks.viewAll')}</span>
              </div>
              <div className="space-y-3.5">
                {schedule.map(({ time, title, person, avatar, color }) => (
                  <div key={title} className="flex items-center gap-2.5">
                    <span className={cn('shrink-0 rounded-full p-[2px]', color)}><FaceAvatar index={avatar} className="h-6 w-6" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-semibold text-white">{title}</p>
                      <p className="text-[9px] text-white/55">{person}</p>
                    </div>
                    <span className="shrink-0 text-[9px] text-white/55">{time}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom nav */}
            <div className="mt-auto flex items-end justify-around border-t border-white/8 pt-3 text-[7px] text-white/55">
              <span className="flex flex-col items-center gap-1 text-violet-400"><Home className="h-4 w-4" />{t('visualMocks.home')}</span>
              <span className="flex flex-col items-center gap-1"><CalendarDays className="h-4 w-4" />{t('visualMocks.calendar')}</span>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 text-brand-fg">
                <span className="text-lg font-bold leading-none">+</span>
              </span>
              <span className="flex flex-col items-center gap-1"><CheckSquare2 className="h-4 w-4" />{t('visualMocks.tasks')}</span>
              <span className="flex flex-col items-center gap-1"><Circle className="h-4 w-4" />{t('visualMocks.more')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export async function ProductMockup() {
  const t = await getTranslations();
  const schedule = [
    ['8:00 AM', 'School Drop-off'],
    ['10:00 AM', 'Math Meeting'],
    ['4:30 PM', 'Soccer Practice'],
    ['7:00 PM', t('visualMocks.familyDinner')],
  ];
  const chores = ['Tidy Living Room', 'Take Out Trash', 'Feed the Dog'];
  const meals = ['Honey Garlic Chicken', 'Taco Tuesday', 'Salmon & Veggies'];

  return (
    <div className="dark relative mx-auto w-full max-w-[760px] pt-8 lg:pt-0">
      <div className="showcase-card relative ml-auto w-[88%] rounded-[2rem] border-neutral-700/80 bg-[#080d14] p-4 shadow-2xl">
        <div className="h-[10px] rounded-t-[1.5rem] border border-white/10 bg-black/50" />
        <div className="mt-3 grid min-h-[460px] grid-cols-[120px_1fr] gap-4 rounded-2xl bg-[#0b121d] p-4">
          <aside className="space-y-2 border-r border-white/8 pr-3">
            <div className="mb-5 flex items-center gap-2 text-xs font-bold">
              <Sparkles className="h-4 w-4 text-violet-400" />{' '}{t('visualMocks.bubaly')}</div>
            {[t('visualMocks.home'), t('visualMocks.calendar'), t('visualMocks.chores'), 'Meals', 'School', 'Sports', 'Health', 'Documents', 'AI Assistant'].map((item, index) => (
              <div key={item} className={cn('rounded-lg px-3 py-2 text-[11px] text-white/65', index === 0 && 'bg-violet-600 text-white')}>
                {item}
              </div>
            ))}
          </aside>
          <main>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold">{t('visualMocks.welcomeBackSarah')}</h3>
              <div className="flex gap-2">
                <span className="h-7 w-7 rounded-full bg-amber-300" />
                <span className="h-7 w-7 rounded-full bg-cyan-300" />
                <span className="h-7 w-7 rounded-full bg-violet-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <MiniPanel title={t('visualMocks.todaySSchedule')}>
                {schedule.map(([time, label]) => (
                  <div key={label} className="flex justify-between border-b border-white/5 py-2 text-xs">
                    <span className="text-white/50">{time}</span>
                    <span>{label}</span>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title={t('visualMocks.upcoming')}>
                {['Math Test', 'Doctor Appointment', 'Field Trip'].map((item) => (
                  <div key={item} className="py-2 text-xs">
                    <p className="font-semibold">{item}</p>
                    <p className="text-white/55">{t('visualMocks.thisWeek')}</p>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title={t('visualMocks.chores')}>
                {chores.map((item) => (
                  <div key={item} className="flex items-center gap-2 py-2 text-xs">
                    <span className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-200 to-rose-300" />
                    <span className="flex-1">{item}</span>
                    <Circle className="h-4 w-4 text-white/55" />
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title={t('visualMocks.mealPlan')}>
                {meals.map((item) => (
                  <div key={item} className="flex items-center gap-2 py-2 text-xs">
                    <UtensilsCrossed className="h-4 w-4 text-orange-400" />
                    <span>{item}</span>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title={t('visualMocks.groceryList')}>
                {['Milk', 'Eggs', 'Bread', 'Avocados'].map((item) => (
                  <div key={item} className="flex items-center gap-2 py-1.5 text-xs text-white/70">
                    <Circle className="h-3.5 w-3.5" /> {item}
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title={t('visualMocks.familyAiAssistant')}>
                <div className="grid min-h-28 place-items-center">
                  <div className="glow-dot h-12 w-12" />
                </div>
              </MiniPanel>
            </div>
          </main>
        </div>
      </div>
      <PhoneMockup className="absolute -right-2 bottom-0 hidden w-[210px] lg:block" />
      <div className="mx-auto h-5 w-[72%] rounded-b-full bg-gradient-to-r from-transparent via-white/35 to-transparent blur-sm" />
    </div>
  );
}

export async function PhoneMockup({ className }: { className?: string }) {
  const t = await getTranslations();
  const items = ['School Drop-off', 'Math Meeting', 'Soccer Practice', t('visualMocks.familyDinner')];
  return (
    <div className={cn('dark rounded-[2rem] border-[6px] border-neutral-800 bg-black p-2 shadow-2xl', className)}>
      <div className="rounded-[1.45rem] bg-[#09111d] p-4">
        <div className="mb-5 flex items-center justify-between text-[10px] font-bold">
          <span>9:41</span>
          <span className="h-3 w-12 rounded-full bg-black" />
        </div>
        <h4 className="text-lg font-bold">{t('visualMocks.hiSarah')}</h4>
        <MiniPanel title={t('visualMocks.today')} className="mt-4 p-3">
          {items.map((item, index) => (
            <div key={item} className="flex justify-between border-l-2 border-violet-500 py-1.5 pl-2 text-[10px]">
              <span>{item}</span>
              <span className="text-white/55">{['8:00 AM', '10:00 AM', '4:30 PM', '7:00 PM'][index]}</span>
            </div>
          ))}
        </MiniPanel>
        <MiniPanel title={t('visualMocks.chores')} className="mt-3 p-3">
          {['Tidy Living Room', 'Take Out Trash'].map((item) => (
            <div key={item} className="flex items-center justify-between py-1.5 text-[10px]">
              <span>{item}</span>
              <Circle className="h-3 w-3 text-white/55" />
            </div>
          ))}
        </MiniPanel>
        <div className="mt-4 flex items-center justify-around text-[9px] text-white/50">
          <Home className="h-4 w-4 text-violet-400" />
          <CalendarDays className="h-4 w-4" />
          <span className="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-white">+</span>
          <CheckSquare2 className="h-4 w-4" />
          <Circle className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

export async function MiniPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  const t = await getTranslations();
  return (
    <div className={cn('rounded-xl border border-white/8 bg-white/[0.045] p-4', className)}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-bold">{title}</p>
        <span className="text-[10px] text-violet-300">{t('visualMocks.viewAll')}</span>
      </div>
      {children}
    </div>
  );
}

export async function FamilyAiPanel() {
  const t = await getTranslations();
  // The heading splits into a lead-in and an emphasised TAIL, not three pieces
  // around a middle. English "Your [AI Family] Assistant" puts the accent in
  // the middle, which no other language here reproduces — French wants "Votre
  // assistant familial IA" and German "Dein KI-Familienassistent". Two keys let
  // each language put the break where its own grammar puts it; three would have
  // forced English word order onto all of them.
  return (
    <section className="showcase-panel overflow-hidden p-5 sm:p-8 lg:p-9">
      <div className="grid items-stretch gap-8 lg:grid-cols-[300px_1fr] lg:gap-8">
        <div className="flex flex-col justify-center lg:px-2">
          <h2 className="text-3xl font-bold leading-tight sm:text-4xl">
            {t('visualMocks.aiPanelTitleBefore')} <GradientText>{t('visualMocks.aiPanelTitleAccent')}</GradientText>
          </h2>
          <p className="mt-5 text-base leading-7 text-white/72 sm:text-lg sm:leading-8">
            {t('visualMocks.aiPanelBody')}
          </p>
          <ul className="mt-6 space-y-3 text-sm text-white/86">
            {['visualMocks.aiPanelBullet1', 'visualMocks.aiPanelBullet2', 'visualMocks.aiPanelBullet3', 'visualMocks.aiPanelBullet4'].map((key) => (
              <li key={key} className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-violet-400" /> {t(key)}
              </li>
            ))}
          </ul>
          <Link href="/ai" className="mt-7 inline-flex w-fit rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-7 py-3.5 text-sm font-bold text-brand-fg shadow-glow transition hover:-translate-y-0.5 hover:brightness-110">
            {t('visualMocks.tryTheAiAssistant')}
          </Link>
        </div>
        <div className="dark relative min-h-[420px] overflow-hidden rounded-2xl border border-white/10 bg-[#080e18] sm:min-h-[450px]">
          <Image
            src="/images/family-ai-lifestyle.png"
            alt={t('visualMocks.familyLifestyleAlt')}
            fill
            priority
            sizes="(max-width: 1024px) 100vw, 760px"
            className="object-cover object-[62%_center] lg:object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#06101d] via-transparent to-black/10 lg:bg-gradient-to-r lg:from-[#07111e] lg:via-[#07111e]/70 lg:to-transparent" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_35%,transparent_0%,rgba(3,9,17,0.08)_44%,rgba(3,9,17,0.55)_100%)]" />
          <AssistantConversation />
        </div>
      </div>
    </section>
  );
}

export async function FamilyMomentsBand({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations();
  const moments = [
    [t('visualMocks.momentMorning'), t('visualMocks.momentMorningBody')],
    [t('visualMocks.momentAfterSchool'), t('visualMocks.momentAfterSchoolBody')],
    [t('visualMocks.momentWeekend'), t('visualMocks.momentWeekendBody')],
  ];
  return (
    <section className={cn('showcase-panel p-6 sm:p-8 lg:p-9', compact && 'p-6 lg:p-8')}>
      <div className="grid gap-7 lg:grid-cols-[270px_1fr]">
        <h2 className="text-3xl font-bold leading-tight sm:text-[2rem]">{t('visualMocks.builtForTheMomentsThat')}{' '}<GradientText>{t('visualMocks.familyLifeMoving')}</GradientText>
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {moments.map(([title, body]) => (
            <article key={title} className="showcase-card rounded-xl p-5">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <h3 className="mt-3 text-sm font-semibold text-white/90">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-white/68">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export async function DeviceShowcase() {
  const t = await getTranslations();
  // Device names are product names — the same word in every language.
  const devices = ['iPhone', 'Android', 'iPad', 'Web App'] as const;

  return (
    <section className="py-10 sm:py-12">
      <h2 className="mb-8 text-center text-xl font-semibold sm:text-2xl">
        {t('visualMocks.oneSeamlessExperience')}
      </h2>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
        {devices.map((device) => (
          <div key={device} className="device-card group flex flex-col items-center gap-3">
            <div aria-hidden="true" className="dark"><DeviceArtwork device={device} /></div>
            <span className="text-sm font-medium text-[rgb(var(--canvas-fg)/0.75)] transition group-hover:text-[rgb(var(--canvas-fg))]">{device}</span>
          </div>
        ))}
      </div>

      <div className="mt-10 grid gap-5 pt-2 sm:grid-cols-3">
        {[
          { icon: Shield, text: t('visualMocks.encryptedInTransitAndAt') },
          { icon: Shield, text: t('visualMocks.familyScopedAccessControls') },
          { icon: Heart, text: t('visualMocks.yourDataYourFamily') },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center justify-center gap-2 text-sm text-[rgb(var(--canvas-fg)/0.65)]">
            <Icon className="h-5 w-5 text-emerald-400" />
            {text}
          </div>
        ))}
      </div>

    </section>
  );
}

type DeviceName = 'iPhone' | 'Android' | 'iPad' | 'Web App' | 'Apple Watch' | 'Smart Display';

async function ScheduleScreen() {
  const t = await getTranslations();
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[inherit] bg-[#080e18] p-2">
      <div className="flex items-center justify-between">
        <span className="text-[6px] font-bold text-white">{t('visualMocks.bubaly')}</span>
        <span className="h-2 w-2 rounded-full bg-gradient-to-br from-blue-400 to-violet-500" />
      </div>
      <div className="mt-1.5 rounded-md bg-gradient-to-r from-violet-500/20 to-blue-500/20 px-1.5 py-1">
        <div className="flex items-center gap-1">
          <Sparkles className="h-2.5 w-2.5 text-violet-400" />
          <span className="text-[5px] font-semibold text-white">3 events today</span>
        </div>
      </div>
      <div className="mt-1.5 flex-1 space-y-1">
        {[
          { time: '8:00', title: t('visualMocks.dentistAppt'), color: 'bg-rose-400' },
          { time: '3:30', title: t('visualMocks.soccer'), color: 'bg-emerald-400' },
          { time: '6:00', title: t('visualMocks.familyDinner'), color: 'bg-violet-400' },
        ].map(({ time, title, color }) => (
          <div key={title} className="flex items-center gap-1 rounded-sm bg-white/[0.05] p-1">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color)} />
            <span className="text-[4.5px] text-white/50">{time}</span>
            <span className="truncate text-[4.5px] font-medium text-white/80">{title}</span>
          </div>
        ))}
      </div>
      <div className="mt-auto flex justify-around border-t border-white/[0.08] pt-1.5">
        {[Home, CalendarDays, CheckSquare2].map((Icon, i) => (
          <Icon key={i} className={cn('h-2.5 w-2.5', i === 0 ? 'text-violet-400' : 'text-white/30')} />
        ))}
      </div>
    </div>
  );
}

async function TasksScreen() {
  const t = await getTranslations();
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[inherit] bg-[#080e18] p-2">
      <div className="flex items-center justify-between">
        <span className="text-[6px] font-bold text-white">{t('visualMocks.bubaly')}</span>
        <span className="h-2 w-2 rounded-full bg-gradient-to-br from-blue-400 to-violet-500" />
      </div>
      <p className="mt-1.5 text-[5px] font-semibold text-white/70">Today&apos;s Tasks</p>
      <div className="mt-1 flex-1 space-y-1">
        {[
          { text: t('visualMocks.packLunches'), done: true },
          { text: t('visualMocks.walkTheDog'), done: true },
          { text: t('visualMocks.groceryPickup2'), done: false },
          { text: t('visualMocks.startLaundry'), done: false },
        ].map(({ text, done }) => (
          <div key={text} className="flex items-center gap-1 rounded-sm bg-white/[0.05] p-1">
            {done ? (
              <CheckCircle2 className="h-2 w-2 shrink-0 text-emerald-400" />
            ) : (
              <Circle className="h-2 w-2 shrink-0 text-white/25" />
            )}
            <span className={cn('text-[4.5px]', done ? 'text-white/55 line-through' : 'text-white/80')}>{text}</span>
          </div>
        ))}
      </div>
      <div className="mt-auto flex justify-around border-t border-white/[0.08] pt-1.5">
        {[Home, CalendarDays, CheckSquare2].map((Icon, i) => (
          <Icon key={i} className={cn('h-2.5 w-2.5', i === 2 ? 'text-emerald-400' : 'text-white/30')} />
        ))}
      </div>
    </div>
  );
}

async function DashboardScreen() {
  const t = await getTranslations();
  return (
    <div className="h-full w-full overflow-hidden rounded-[inherit] bg-[#080e18] p-2">
      <div className="flex items-center justify-between">
        <span className="text-[6px] font-bold text-white">{t('visualMocks.bubaly')}</span>
        <span className="h-2 w-2 rounded-full bg-gradient-to-br from-blue-400 to-violet-500" />
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1">
        {[
          { value: '5', label: t('visualMocks.events'), color: 'text-violet-400' },
          { value: '3', label: t('visualMocks.tasks'), color: 'text-emerald-400' },
          { value: '72°', label: t('visualMocks.weather'), color: 'text-blue-400' },
          { value: '2', label: t('visualMocks.alerts'), color: 'text-rose-400' },
        ].map(({ value, label, color }) => (
          <div key={label} className="rounded-md bg-white/[0.06] px-0.5 py-1 text-center">
            <p className={cn('text-[7px] font-bold', color)}>{value}</p>
            <p className="text-[4px] text-white/55">{label}</p>
          </div>
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className="space-y-0.5">
          <p className="text-[5px] font-semibold text-white/60">{t('visualMocks.schedule')}</p>
          {[
            { title: t('visualMocks.dentist800'), color: 'bg-rose-400' },
            { title: t('visualMocks.soccer330'), color: 'bg-emerald-400' },
            { title: t('visualMocks.dinner600'), color: 'bg-violet-400' },
          ].map(({ title, color }) => (
            <div key={title} className="flex items-center gap-1 rounded-sm bg-white/[0.04] px-1 py-0.5">
              <span className={cn('h-1 w-1 shrink-0 rounded-full', color)} />
              <span className="text-[4px] text-white/70">{title}</span>
            </div>
          ))}
        </div>
        <div className="space-y-0.5">
          <p className="text-[5px] font-semibold text-white/60">{t('visualMocks.tasks')}</p>
          {[
            { text: t('visualMocks.packLunches'), done: true },
            { text: t('visualMocks.walkDog'), done: true },
            { text: t('visualMocks.groceries'), done: false },
          ].map(({ text, done }) => (
            <div key={text} className="flex items-center gap-1 rounded-sm bg-white/[0.04] px-1 py-0.5">
              <span className={cn('h-1 w-1 shrink-0 rounded-full', done ? 'bg-emerald-400' : 'bg-white/20')} />
              <span className={cn('text-[4px]', done ? 'text-white/55' : 'text-white/70')}>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

async function WebAppScreen() {
  const t = await getTranslations();
  return (
    <div className="h-full w-full overflow-hidden rounded-[inherit] bg-[#080e18] p-1">
      <div className="flex h-full gap-0.5">
        <div className="flex w-3.5 shrink-0 flex-col items-center gap-1.5 rounded-sm bg-white/[0.06] py-1.5">
          {[Home, CalendarDays, CheckSquare2, UtensilsCrossed].map((Icon, i) => (
            <Icon key={i} className={cn('h-1.5 w-1.5', i === 0 ? 'text-violet-400' : 'text-white/30')} />
          ))}
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[4.5px] font-bold text-white">{t('visualMocks.dashboard')}</span>
            <span className="h-1 w-1 rounded-full bg-gradient-to-br from-blue-400 to-violet-500" />
          </div>
          <div className="mt-0.5 grid grid-cols-3 gap-0.5 px-0.5">
            {[
              { v: '5', l: t('visualMocks.events'), c: 'text-violet-400' },
              { v: '3', l: t('visualMocks.tasks'), c: 'text-emerald-400' },
              { v: '72°', l: t('visualMocks.weather'), c: 'text-blue-400' },
            ].map(({ v, l, c }) => (
              <div key={l} className="rounded-sm bg-white/[0.06] py-0.5 text-center">
                <p className={cn('text-[5px] font-bold', c)}>{v}</p>
                <p className="text-[3px] text-white/55">{l}</p>
              </div>
            ))}
          </div>
          <div className="mt-0.5 space-y-[2px] px-0.5">
            {[t('visualMocks.dentist800'), t('visualMocks.soccer330'), t('visualMocks.dinner600')].map((item, i) => (
              <div key={item} className="flex items-center gap-0.5 rounded-sm bg-white/[0.04] px-0.5 py-[2px]">
                <span className={cn('h-1 w-1 shrink-0 rounded-full', i === 0 ? 'bg-rose-400' : i === 1 ? 'bg-emerald-400' : 'bg-violet-400')} />
                <span className="text-[3.5px] text-white/70">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

async function DeviceArtwork({ device }: { device: DeviceName }) {
  const t = await getTranslations();
  if (device === 'iPhone' || device === t('visualMocks.android')) {
    return (
      <div className={cn('device-art relative h-32 w-[70px] rounded-[17px] border-[4px] border-[rgb(var(--device-bezel))] bg-black p-1 shadow-2xl sm:h-36 sm:w-[78px]', device === t('visualMocks.android') && 'rounded-[13px]')}>
        {device === 'iPhone' ? <ScheduleScreen /> : <TasksScreen />}
        <span className={cn('absolute left-1/2 top-1.5 -translate-x-1/2 bg-black', device === 'iPhone' ? 'h-2 w-7 rounded-full' : 'h-2 w-2 rounded-full')} />
      </div>
    );
  }

  if (device === 'iPad') {
    return (
      <div className="device-art h-28 w-[132px] rounded-xl border-[5px] border-[rgb(var(--device-bezel))] bg-black p-1.5 shadow-2xl sm:h-32 sm:w-[148px]">
        <DashboardScreen />
      </div>
    );
  }

  if (device === 'Web App') {
    return (
      <div className="device-art flex h-32 w-full max-w-[160px] flex-col justify-center sm:h-36">
        <div className="h-[92px] rounded-lg border-[4px] border-[rgb(var(--device-bezel))] bg-black p-1 shadow-2xl sm:h-[104px]">
          <WebAppScreen />
        </div>
        <div className="mx-auto h-3 w-8 bg-[rgb(var(--device-bezel))]" />
        <div className="mx-auto h-1.5 w-16 rounded-full bg-[rgb(var(--device-accent))]" />
      </div>
    );
  }

  if (device === 'Apple Watch') {
    return (
      <div className="device-art flex h-32 flex-col items-center justify-center sm:h-36">
        <div className="h-8 w-9 rounded-t-lg bg-[rgb(var(--device-band))]" />
        <div className="relative h-[66px] w-[62px] rounded-[17px] border-[4px] border-[rgb(var(--device-accent))] bg-black p-1 shadow-2xl">
          <div className="flex h-full flex-col items-center justify-center rounded-xl bg-[#0b1320] px-1">
            <span className="text-[11px] font-bold tracking-tight text-white">9:41</span>
            <div className="mt-1 flex items-center gap-2">
              <div className="text-center">
                <CloudSun className="mx-auto h-2.5 w-2.5 text-blue-400" />
                <span className="text-[4px] text-white/50">72°</span>
              </div>
              <div className="text-center">
                <Heart className="mx-auto h-2.5 w-2.5 text-rose-400" />
                <span className="text-[4px] text-white/50">65</span>
              </div>
            </div>
            <div className="mt-1 w-full rounded bg-violet-500/25 px-1 py-0.5 text-center">
              <span className="text-[4px] font-medium text-violet-300">{t('visualMocks.dentist800')}</span>
            </div>
          </div>
        </div>
        <div className="h-8 w-9 rounded-b-lg bg-[rgb(var(--device-band))]" />
      </div>
    );
  }

  return (
    <div className="device-art flex h-32 w-full max-w-[160px] flex-col items-center justify-center sm:h-36">
      <div className="relative h-[92px] w-full overflow-hidden rounded-xl border-[5px] border-[rgb(var(--device-bezel))] bg-black shadow-2xl sm:h-[104px]">
        <Image src="/images/family-ai-lifestyle.png" alt={t('visualMocks.bubalySmartDisplay')} fill sizes="160px" className="object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent" />
        <span className="absolute bottom-2 left-2 text-[7px] font-bold text-white">{t('visualMocks.goodEveningFamily')}</span>
      </div>
      <div className="h-3 w-8 bg-[rgb(var(--device-bezel))]" />
      <div className="h-1.5 w-16 rounded-full bg-[rgb(var(--device-accent))]" />
    </div>
  );
}


export function FeaturePreviewCard({
  icon,
  tone,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  tone: 'violet' | 'green' | 'orange' | 'blue' | 'pink';
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <article className="showcase-card rounded-2xl p-6">
      <div className="flex items-center gap-3">
        <IconOrb icon={Icon} tone={tone} className="h-11 w-11 rounded-xl" />
        <h3 className="text-lg font-bold">{title}</h3>
      </div>
      <p className="mt-5 min-h-[88px] text-sm leading-6 text-white/75">{description}</p>
      <div className="mt-5 rounded-xl border border-white/8 bg-white/[0.035] p-4">{children}</div>
    </article>
  );
}

export async function MiniCalendar() {
  const t = await getTranslations();
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between text-white/75">
        <span>{t('visualMocks.may2024')}</span>
        <span>+</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[9px] text-white/55">
        {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d) => <span key={d}>{d}</span>)}
        {Array.from({ length: 28 }).map((_, index) => (
          <span key={index} className={cn('rounded-md py-1', [8, 9, 10, 14].includes(index) && 'bg-violet-600/50 text-white')}>
            {index + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CheckList({ items, color = 'text-emerald-400' }: { items: string[]; color?: string }) {
  return (
    <div className="space-y-3 text-sm">
      {items.map((item, index) => (
        <div key={item} className="flex items-center gap-3">
          {index < 2 ? <CheckCircle2 className={cn('h-5 w-5', color)} /> : <Circle className="h-5 w-5 text-white/55" />}
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

export async function SmallCtaBand() {
  const t = await getTranslations();
  return (
    <section className="showcase-card grid items-center gap-6 rounded-2xl p-8 lg:grid-cols-[1fr_auto_auto] lg:p-10">
      <div className="flex items-center gap-6">
        <IconOrb icon={Sparkles} className="hidden h-16 w-16 sm:inline-flex" />
        <div>
          <h2 className="text-2xl font-bold">{t('visualMocks.oneAppEveryPart')}</h2>
          <p className="mt-2 max-w-2xl text-white/68">
            {t('visualMocks.oneAppEveryPartBody')}
          </p>
        </div>
      </div>
      <PrimaryLink href="/signup">{t('visualMocks.getStartedFree')}</PrimaryLink>
      <OutlineLink href="/how-it-works">{t('visualMocks.seeHowItWorks')}</OutlineLink>
    </section>
  );
}

/**
 * The Bubaly brand manifesto — an editorial, emotional closing statement. Centered
 * long-form copy with the key beats emphasized and the tagline as the payoff.
 */
export async function ManifestoBand() {
  const t = await getTranslations();
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-b from-violet-500/[0.06] via-transparent to-blue-500/[0.05] px-6 py-14 sm:px-10 sm:py-20">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <div className="mx-auto max-w-3xl text-center">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{t('visualMocks.ourManifesto')}</span>

        <p className="mx-auto mt-6 max-w-2xl text-balance text-xl font-medium leading-snug text-white/75 sm:text-2xl sm:leading-snug">
          {t('visualMocks.manifestoLead')}
        </p>

        <p className="mt-7 text-3xl font-extrabold tracking-tight sm:text-5xl">
          {t('visualMocks.manifestoLifeMeant')} <GradientText>{t('visualMocks.manifestoLived')}</GradientText>.
        </p>

        <p className="mx-auto mt-8 max-w-2xl text-base leading-7 text-white/65 sm:text-lg sm:leading-8">
          {t('visualMocks.manifestoBody')}
        </p>

        <p className="mx-auto mt-6 max-w-xl text-base font-semibold leading-7 text-white/80 sm:text-lg">
          {t('visualMocks.manifestoBecause')}
        </p>

        <div className="mt-10">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-white/55">{t('visualMocks.ourMissionIsSimple')}</p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
            {t('visualMocks.lessManagingLife')} <GradientText>{t('visualMocks.moreLivingIt')}</GradientText>
          </p>
        </div>
      </div>
    </section>
  );
}

// `title` and `body` are CATALOGUE KEYS, not copy. They used to be English
// literals, which is why the homepage feature rail stayed English on a French
// page while the nav around it translated: a string that never reaches the
// catalogue cannot be translated by filling the catalogue.
export const FEATURE_RAIL = [
  { icon: CalendarDays, title: 'featureRail.sharedCalendar', body: 'featureRail.sharedCalendarBody', tone: 'violet', href: '/features#smart-calendar' },
  { icon: CheckSquare2, title: 'featureRail.choresRewards', body: 'featureRail.choresRewardsBody', tone: 'green', href: '/features#tasks-chores' },
  { icon: UtensilsCrossed, title: 'featureRail.mealPlanning', body: 'featureRail.mealPlanningBody', tone: 'orange', href: '/features#meal-planning' },
  { icon: GraduationCap, title: 'featureRail.schoolSports', body: 'featureRail.schoolSportsBody', tone: 'blue', href: '/features#school-hub' },
  { icon: Heart, title: 'featureRail.healthReminders', body: 'featureRail.healthRemindersBody', tone: 'pink', href: '/features#health-medications' },
  { icon: Folder, title: 'featureRail.documentsNotes', body: 'featureRail.documentsNotesBody', tone: 'violet', href: '/features#home-management' },
] as const;

export const FEATURE_TOPICS = [
  { icon: CalendarDays, title: 'visualMocks.organizeSchedules', tone: 'violet' },
  { icon: CheckSquare2, title: 'visualMocks.manageTasks', tone: 'green' },
  { icon: UtensilsCrossed, title: 'visualMocks.planMeals', tone: 'orange' },
  { icon: GraduationCap, title: 'visualMocks.stayOnTopOfSchool', tone: 'blue' },
  { icon: Heart, title: 'visualMocks.healthWellness', tone: 'pink' },
  { icon: Home, title: 'visualMocks.homeManagement', tone: 'blue' },
  { icon: Sparkles, title: 'visualMocks.aiFamilyAssistant', tone: 'violet' },
] as const;

export const WORK_STEPS = [
  [Sparkles, 'Create Your Family', 'Set up your household in minutes and invite family members.'],
  [Mail, 'Add or Forward Anything', 'Forward emails, snap photos of flyers, or add events, tasks, and lists.'],
  [Sparkles, 'AI Gets to Work', 'Our AI reads, understands, and organizes everything into the right places.'],
  [UsersIcon, 'Everyone Stays in Sync', 'Calendars, tasks, reminders, and updates are shared in real time.'],
  [Check, 'Life Runs Smoother', 'Bubaly helps you plan ahead, avoid chaos, and enjoy more time together.'],
] as const;

function UsersIcon({ className }: { className?: string }) {
  return <Home className={className} />;
}
