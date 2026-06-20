import Image from 'next/image';
import Link from 'next/link';
import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
  Circle,
  Folder,
  GraduationCap,
  Heart,
  Home,
  Mail,
  PlayCircle,
  Shield,
  ShoppingCart,
  Sparkles,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { AssistantConversation } from '@/components/marketing/homepage-interactions';
import { cn } from '@/lib/utils/cn';

export function PageWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('soft-grid-bg min-h-dvh overflow-x-clip text-canvas', className)}>{children}</div>;
}

export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto max-w-[1360px] px-6 sm:px-10 lg:px-12', className)}>{children}</div>;
}

export function GradientText({ children }: { children: React.ReactNode }) {
  return <span className="gradient-text-violet">{children}</span>;
}

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
      className="inline-flex h-14 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-8 text-base font-bold text-white shadow-glow transition hover:scale-[1.02] hover:brightness-110"
    >
      {children}
    </Link>
  );
}

export function WatchDemoLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-14 items-center justify-center gap-2.5 rounded-xl border border-white/18 bg-white/[0.025] px-8 text-base font-bold text-white transition hover:bg-white/[0.07]"
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

export function IconOrb({
  icon: Icon,
  tone = 'violet',
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'violet' | 'green' | 'orange' | 'blue' | 'pink';
  className?: string;
}) {
  const tones = {
    violet: 'text-violet-400 bg-violet-500/12',
    green: 'text-emerald-400 bg-emerald-500/12',
    orange: 'text-orange-400 bg-orange-500/12',
    blue: 'text-blue-400 bg-blue-500/12',
    pink: 'text-rose-400 bg-rose-500/12',
  };

  return (
    <span className={cn('icon-orb h-16 w-16', tones[tone], className)}>
      <Icon className="h-8 w-8" />
    </span>
  );
}

export function AvatarStack() {
  const people = ['SJ', 'DM', 'AL', 'PK', 'CJ'];
  return (
    <div className="flex -space-x-2">
      {people.map((person, index) => (
        <span
          key={person}
          className={cn(
            'grid h-10 w-10 place-items-center rounded-full border-2 border-[#07101a] text-xs font-bold text-white',
            ['bg-rose-300', 'bg-amber-300', 'bg-cyan-300', 'bg-emerald-300', 'bg-violet-300'][index],
          )}
        >
          {person}
        </span>
      ))}
    </div>
  );
}

export function SocialProofLine({ text = 'Loved by families everywhere' }: { text?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <AvatarStack />
      <p className="text-sm text-white/80">{text}</p>
    </div>
  );
}

export function PlatformBadges() {
  const platforms = [
    { icon: '🍎', label: 'iOS' },
    { icon: '🤖', label: 'Android' },
    { icon: '🖥️', label: 'Web' },
    { icon: '📱', label: 'Tablet' },
    { icon: '📺', label: 'TV' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs text-white/45">Available on</span>
      {platforms.map(({ icon, label }) => (
        <span key={label} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/70">
          <span>{icon}</span>
          {label}
        </span>
      ))}
    </div>
  );
}

export function HeroPhoneMockup({ className }: { className?: string }) {
  const schedule = [
    { time: '8:00 AM', title: 'Dentist Appointment', person: 'Emma', color: 'bg-rose-400' },
    { time: '9:30 AM', title: 'Dad Flight to Chicago', person: 'Mike', color: 'bg-blue-400' },
    { time: '3:00 PM', title: 'Jackson Soccer Practice', person: 'Jackson', color: 'bg-emerald-400' },
    { time: '5:00 PM', title: 'Grocery Pickup', person: 'H-E-B', color: 'bg-orange-400' },
    { time: '7:00 PM', title: 'Family Dinner', person: 'The Johnsons', color: 'bg-violet-400' },
  ];

  return (
    <div className={cn('dark relative mx-auto isolate', className)}>
      <div className="pointer-events-none absolute -inset-12 -z-20 rounded-full bg-violet-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-28 top-[22%] -z-10 h-72 w-72 rounded-full border-[3px] border-violet-500/75 shadow-[0_0_55px_rgba(124,77,255,0.72),inset_0_0_55px_rgba(124,77,255,0.28)] sm:-right-40 sm:h-96 sm:w-96" />

      {/* Phone shell */}
      <div className="hero-phone-float relative mx-auto w-[286px] rotate-[3deg] rounded-[3rem] border-[7px] border-neutral-700 bg-black shadow-[0_40px_80px_rgba(0,0,0,0.9),inset_0_0_0_1px_rgba(255,255,255,0.22)] sm:w-[320px]">
        {/* Screen */}
        <div className="overflow-hidden rounded-[2.4rem] bg-[#090f1a]">
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 pt-4 pb-2">
            <span className="text-[11px] font-semibold text-white">9:41</span>
            <div className="h-4 w-20 rounded-full bg-black" />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-white/60">●●●</span>
            </div>
          </div>

          <div className="px-5 pb-5">
            {/* Greeting */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[15px] font-bold text-white">Good Morning, Sarah! 👋</p>
                <p className="text-[10px] text-white/45">Thursday, May 16</p>
              </div>
              <div className="relative">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-400 to-blue-500" />
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#090f1a] bg-emerald-400" />
              </div>
            </div>

            {/* AI Daily Briefing badge */}
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.045] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-400" />
                <span className="text-[11px] font-semibold text-white">AI Daily Briefing</span>
              </div>
              <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[9px] font-bold text-white">New</span>
            </div>

            {/* Stats row */}
            <div className="mt-3 grid grid-cols-4 gap-1.5">
              {[
                { value: '5', label: 'Events Today', color: 'text-violet-400' },
                { value: '3', label: 'Tasks Due', color: 'text-emerald-400' },
                { value: '2', label: 'Conflicts', color: 'text-rose-400' },
                { value: '72°', label: 'Party Cloudy', color: 'text-blue-400' },
              ].map(({ value, label, color }) => (
                <div key={label} className="rounded-lg border border-white/6 bg-white/[0.035] p-2 text-center">
                  <p className={cn('text-[13px] font-bold', color)}>{value}</p>
                  <p className="mt-0.5 text-[8px] leading-tight text-white/45">{label}</p>
                </div>
              ))}
            </div>

            {/* Today's Schedule */}
            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-bold text-white">Today&apos;s Schedule</p>
                <span className="text-[9px] text-violet-400">View all</span>
              </div>
              <div className="space-y-2">
                {schedule.map(({ time, title, person, color }) => (
                  <div key={title} className="flex items-center gap-2.5">
                    <span className={cn('h-6 w-6 shrink-0 rounded-full', color)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-semibold text-white">{title}</p>
                      <p className="text-[9px] text-white/45">{person}</p>
                    </div>
                    <span className="shrink-0 text-[9px] text-white/40">{time}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom nav */}
            <div className="mt-4 flex items-center justify-around border-t border-white/8 pt-3">
              <Home className="h-5 w-5 text-violet-400" />
              <CalendarDays className="h-5 w-5 text-white/35" />
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 text-white">
                <span className="text-lg font-bold leading-none">+</span>
              </span>
              <CheckSquare2 className="h-5 w-5 text-white/35" />
              <Circle className="h-5 w-5 text-white/35" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProductMockup() {
  const schedule = [
    ['8:00 AM', 'School Drop-off'],
    ['10:00 AM', 'Math Meeting'],
    ['4:30 PM', 'Soccer Practice'],
    ['7:00 PM', 'Family Dinner'],
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
              <Sparkles className="h-4 w-4 text-violet-400" /> FamilyOS
            </div>
            {['Home', 'Calendar', 'Chores', 'Meals', 'School', 'Sports', 'Health', 'Documents', 'AI Assistant'].map((item, index) => (
              <div key={item} className={cn('rounded-lg px-3 py-2 text-[11px] text-white/65', index === 0 && 'bg-violet-600 text-white')}>
                {item}
              </div>
            ))}
          </aside>
          <main>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold">Welcome back, Sarah!</h3>
              <div className="flex gap-2">
                <span className="h-7 w-7 rounded-full bg-amber-300" />
                <span className="h-7 w-7 rounded-full bg-cyan-300" />
                <span className="h-7 w-7 rounded-full bg-violet-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <MiniPanel title="Today's Schedule">
                {schedule.map(([time, label]) => (
                  <div key={label} className="flex justify-between border-b border-white/5 py-2 text-xs">
                    <span className="text-white/50">{time}</span>
                    <span>{label}</span>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title="Upcoming">
                {['Math Test', 'Doctor Appointment', 'Field Trip'].map((item) => (
                  <div key={item} className="py-2 text-xs">
                    <p className="font-semibold">{item}</p>
                    <p className="text-white/45">This week</p>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title="Chores">
                {chores.map((item) => (
                  <div key={item} className="flex items-center gap-2 py-2 text-xs">
                    <span className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-200 to-rose-300" />
                    <span className="flex-1">{item}</span>
                    <Circle className="h-4 w-4 text-white/35" />
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title="Meal Plan">
                {meals.map((item) => (
                  <div key={item} className="flex items-center gap-2 py-2 text-xs">
                    <UtensilsCrossed className="h-4 w-4 text-orange-400" />
                    <span>{item}</span>
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title="Grocery List">
                {['Milk', 'Eggs', 'Bread', 'Avocados'].map((item) => (
                  <div key={item} className="flex items-center gap-2 py-1.5 text-xs text-white/70">
                    <Circle className="h-3.5 w-3.5" /> {item}
                  </div>
                ))}
              </MiniPanel>
              <MiniPanel title="Family AI Assistant">
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

export function PhoneMockup({ className }: { className?: string }) {
  const items = ['School Drop-off', 'Math Meeting', 'Soccer Practice', 'Family Dinner'];
  return (
    <div className={cn('dark rounded-[2rem] border-[6px] border-neutral-800 bg-black p-2 shadow-2xl', className)}>
      <div className="rounded-[1.45rem] bg-[#09111d] p-4">
        <div className="mb-5 flex items-center justify-between text-[10px] font-bold">
          <span>9:41</span>
          <span className="h-3 w-12 rounded-full bg-black" />
        </div>
        <h4 className="text-lg font-bold">Hi, Sarah</h4>
        <MiniPanel title="Today" className="mt-4 p-3">
          {items.map((item, index) => (
            <div key={item} className="flex justify-between border-l-2 border-violet-500 py-1.5 pl-2 text-[10px]">
              <span>{item}</span>
              <span className="text-white/45">{['8:00 AM', '10:00 AM', '4:30 PM', '7:00 PM'][index]}</span>
            </div>
          ))}
        </MiniPanel>
        <MiniPanel title="Chores" className="mt-3 p-3">
          {['Tidy Living Room', 'Take Out Trash'].map((item) => (
            <div key={item} className="flex items-center justify-between py-1.5 text-[10px]">
              <span>{item}</span>
              <Circle className="h-3 w-3 text-white/35" />
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

export function MiniPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-white/8 bg-white/[0.045] p-4', className)}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-bold">{title}</p>
        <span className="text-[10px] text-violet-300">View all</span>
      </div>
      {children}
    </div>
  );
}

export function FamilyAiPanel() {
  return (
    <section className="showcase-panel overflow-hidden p-5 sm:p-8 lg:p-9">
      <div className="grid items-stretch gap-8 lg:grid-cols-[300px_1fr] lg:gap-8">
        <div className="flex flex-col justify-center lg:px-2">
          <h2 className="text-3xl font-bold leading-tight sm:text-4xl">
            Your <GradientText>AI Family</GradientText> Assistant
          </h2>
          <p className="mt-5 text-base leading-7 text-white/72 sm:text-lg sm:leading-8">
            Your built-in family assistant helps you plan, organize, and stay ahead of what matters most.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-white/86">
            {['Create schedules instantly', 'Plan meals and generate grocery lists', 'Get reminders and helpful suggestions', 'Answers tailored to your family'].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-violet-400" /> {item}
              </li>
            ))}
          </ul>
          <Link href="/ai" className="mt-7 inline-flex w-fit rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-7 py-3.5 text-sm font-bold shadow-glow transition hover:-translate-y-0.5 hover:brightness-110">
            Try the AI Assistant
          </Link>
        </div>
        <div className="dark relative min-h-[420px] overflow-hidden rounded-2xl border border-white/10 bg-[#080e18] sm:min-h-[450px]">
          <Image
            src="/images/family-ai-lifestyle.png"
            alt="A family enjoying time together with FamilyOS"
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

export function TestimonialBand({ compact = false }: { compact?: boolean }) {
  const benefits = [
    ['One calm home base', 'Calendar, chores, meals, school, health, and documents live together — not scattered across a dozen apps and group chats.'],
    ['An assistant that acts', 'Ask in plain language and FamilyOS plans meals, builds grocery lists, and schedules events — then writes them straight to your family data.'],
    ['Private by design', 'Row-level security isolates every family, documents live in private storage, and the assistant can never read another household.'],
  ];
  return (
    <section className={cn('showcase-panel p-8 lg:p-12', compact && 'p-6 lg:p-8')}>
      <div className="grid gap-7 lg:grid-cols-[280px_1fr]">
        <h2 className="text-4xl font-bold leading-tight">
          Built for the way <GradientText>families actually live</GradientText>
        </h2>
        <div className="grid gap-5 md:grid-cols-3">
          {benefits.map(([title, body]) => (
            <article key={title} className="showcase-card rounded-xl p-6">
              <h3 className="text-base font-bold">{title}</h3>
              <p className="mt-3 text-sm leading-6 text-white/88">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function DeviceShowcase() {
  const devices = ['iPhone', 'Android', 'iPad', 'Web App', 'Apple Watch', 'Smart Display'] as const;

  return (
    <section className="py-12 sm:py-16">
      <h2 className="mb-9 text-center text-2xl font-bold sm:text-3xl">
        One seamless experience across all your devices
      </h2>

      {/* Device grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
        {devices.map((device) => (
          <div key={device} className="device-card group flex flex-col items-center gap-3">
            <div className="dark"><DeviceArtwork device={device} /></div>
            <span className="text-sm font-medium text-white/75 transition group-hover:text-white">{device}</span>
          </div>
        ))}
      </div>

      {/* Security badges */}
      <div className="mt-12 grid gap-5 border-t border-white/8 pt-8 sm:grid-cols-3">
        {[
          { icon: Shield, text: 'Bank-level security' },
          { icon: Shield, text: 'End-to-end encrypted' },
          { icon: Heart, text: 'Your data, your family' },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center justify-center gap-2 text-sm text-white/65">
            <Icon className="h-5 w-5 text-emerald-400" />
            {text}
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-2xl border border-white/5 bg-white/[0.025] px-5 py-7">
        <p className="text-center text-sm text-white/70">
          Row-level security on every table · Private document storage · You stay in control of your data
        </p>
      </div>
    </section>
  );
}

type DeviceName = 'iPhone' | 'Android' | 'iPad' | 'Web App' | 'Apple Watch' | 'Smart Display';

function MiniAppScreen({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('h-full w-full overflow-hidden rounded-[inherit] bg-[#09111d] p-2', compact && 'p-1.5')}>
      <div className="flex items-center justify-between">
        <span className={cn('font-bold text-white', compact ? 'text-[4px]' : 'text-[6px]')}>FamilyOS</span>
        <span className="h-2 w-2 rounded-full bg-gradient-to-br from-blue-400 to-violet-500" />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {[CalendarDays, CheckSquare2, ShoppingCart].map((Icon, index) => (
          <span key={index} className="grid aspect-square place-items-center rounded-sm bg-white/[0.07]">
            <Icon className={cn(index === 0 ? 'text-violet-400' : index === 1 ? 'text-emerald-400' : 'text-orange-400', compact ? 'h-2 w-2' : 'h-3 w-3')} />
          </span>
        ))}
      </div>
      <div className="mt-2 space-y-1">
        {[55, 82, 68].map((width, index) => (
          <span key={width} className="flex items-center gap-1 rounded-sm bg-white/[0.045] p-1">
            <span className={cn('rounded-full', index === 0 ? 'bg-blue-400' : index === 1 ? 'bg-rose-400' : 'bg-emerald-400', compact ? 'h-1 w-1' : 'h-1.5 w-1.5')} />
            <span className="h-0.5 rounded-full bg-white/30" style={{ width: `${width}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}

function DeviceArtwork({ device }: { device: DeviceName }) {
  if (device === 'iPhone' || device === 'Android') {
    return (
      <div className={cn('device-art relative h-32 w-[70px] rounded-[17px] border-[4px] border-[#333742] bg-black p-1 shadow-2xl sm:h-36 sm:w-[78px]', device === 'Android' && 'rounded-[13px]')}>
        <MiniAppScreen />
        <span className={cn('absolute left-1/2 top-1.5 -translate-x-1/2 bg-black', device === 'iPhone' ? 'h-2 w-7 rounded-full' : 'h-2 w-2 rounded-full')} />
      </div>
    );
  }

  if (device === 'iPad') {
    return (
      <div className="device-art h-28 w-[132px] rounded-xl border-[5px] border-[#333742] bg-black p-1.5 shadow-2xl sm:h-32 sm:w-[148px]">
        <MiniAppScreen />
      </div>
    );
  }

  if (device === 'Web App') {
    return (
      <div className="device-art flex h-32 w-full max-w-[160px] flex-col justify-center sm:h-36">
        <div className="h-[92px] rounded-lg border-[4px] border-[#333742] bg-black p-1 shadow-2xl sm:h-[104px]">
          <MiniAppScreen compact />
        </div>
        <div className="mx-auto h-3 w-8 bg-[#333742]" />
        <div className="mx-auto h-1.5 w-16 rounded-full bg-[#454a57]" />
      </div>
    );
  }

  if (device === 'Apple Watch') {
    return (
      <div className="device-art flex h-32 flex-col items-center justify-center sm:h-36">
        <div className="h-8 w-9 rounded-t-lg bg-[#353943]" />
        <div className="relative h-[66px] w-[62px] rounded-[17px] border-[4px] border-[#454a55] bg-black p-1.5 shadow-2xl">
          <div className="grid h-full place-items-center rounded-xl bg-[#0b1320]">
            <Bell className="h-5 w-5 text-violet-400" />
            <span className="absolute bottom-2 text-[6px] font-bold text-white">9:41</span>
          </div>
        </div>
        <div className="h-8 w-9 rounded-b-lg bg-[#353943]" />
      </div>
    );
  }

  return (
    <div className="device-art flex h-32 w-full max-w-[160px] flex-col items-center justify-center sm:h-36">
      <div className="relative h-[92px] w-full overflow-hidden rounded-xl border-[5px] border-[#333742] bg-black shadow-2xl sm:h-[104px]">
        <Image src="/images/family-ai-lifestyle.png" alt="FamilyOS smart display" fill sizes="160px" className="object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent" />
        <span className="absolute bottom-2 left-2 text-[7px] font-bold text-white">Good evening, family</span>
      </div>
      <div className="h-3 w-8 bg-[#333742]" />
      <div className="h-1.5 w-16 rounded-full bg-[#454a57]" />
    </div>
  );
}

export function TrustStrip({ familiesNote = 'A growing community of families' }: { familiesNote?: string }) {
  const items = [
    [Shield, 'Secure & Private', 'Your data is always protected'],
    [Home, 'Works Everywhere', 'Web, iOS, Android, and more'],
    [Sparkles, 'Real-time Sync', 'Changes sync instantly across devices'],
    [Heart, 'Loved by Families', familiesNote],
  ] as const;
  return (
    <div className="grid gap-6 border-t border-white/8 py-9 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([Icon, title, body]) => (
        <div key={title} className="flex items-start gap-4">
          <IconOrb icon={Icon} className="h-12 w-12" />
          <div>
            <h3 className="font-bold">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-white/65">{body}</p>
          </div>
        </div>
      ))}
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

export function MiniCalendar() {
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between text-white/75">
        <span>May 2024</span>
        <span>+</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[9px] text-white/40">
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
          {index < 2 ? <CheckCircle2 className={cn('h-5 w-5', color)} /> : <Circle className="h-5 w-5 text-white/35" />}
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

export function SmallCtaBand() {
  return (
    <section className="showcase-card grid items-center gap-6 rounded-2xl p-8 lg:grid-cols-[1fr_auto_auto] lg:p-10">
      <div className="flex items-center gap-6">
        <IconOrb icon={Sparkles} className="hidden h-16 w-16 sm:inline-flex" />
        <div>
          <h2 className="text-2xl font-bold">One app. Every part of your family life.</h2>
          <p className="mt-2 max-w-2xl text-white/68">
            From daily routines to life&apos;s big moments, FamilyOS brings it all together so you can focus on what really matters.
          </p>
        </div>
      </div>
      <PrimaryLink href="/signup">Get Started Free</PrimaryLink>
      <OutlineLink href="/how-it-works">See How It Works</OutlineLink>
    </section>
  );
}

export const FEATURE_RAIL = [
  { icon: CalendarDays, title: 'Shared Calendar', body: "See everyone's schedule in one beautiful view.", tone: 'violet' },
  { icon: CheckSquare2, title: 'Chores & Rewards', body: 'Assign chores, earn points, build habits.', tone: 'green' },
  { icon: UtensilsCrossed, title: 'Meal Planning', body: 'Plan meals, build grocery lists, save time.', tone: 'orange' },
  { icon: GraduationCap, title: 'School & Sports', body: 'Stay on top of school and activities.', tone: 'blue' },
  { icon: Heart, title: 'Health & Reminders', body: 'Medications, appointments, and important reminders.', tone: 'pink' },
  { icon: Folder, title: 'Documents & Notes', body: 'Store what matters, access anywhere.', tone: 'violet' },
] as const;

export const FEATURE_TOPICS = [
  { icon: CalendarDays, title: 'Organize Schedules', tone: 'violet' },
  { icon: CheckSquare2, title: 'Manage Tasks', tone: 'green' },
  { icon: UtensilsCrossed, title: 'Plan Meals', tone: 'orange' },
  { icon: GraduationCap, title: 'Stay on Top of School', tone: 'blue' },
  { icon: Heart, title: 'Health & Wellness', tone: 'pink' },
  { icon: Home, title: 'Home Management', tone: 'blue' },
  { icon: Sparkles, title: 'AI Family Assistant', tone: 'violet' },
] as const;

export const WORK_STEPS = [
  [Sparkles, 'Create Your Family', 'Set up your household in minutes and invite family members.'],
  [Mail, 'Add or Forward Anything', 'Forward emails, snap photos of flyers, or add events, tasks, and lists.'],
  [Sparkles, 'AI Gets to Work', 'Our AI reads, understands, and organizes everything into the right places.'],
  [UsersIcon, 'Everyone Stays in Sync', 'Calendars, tasks, reminders, and updates are shared in real time.'],
  [Check, 'Life Runs Smoother', 'FamilyOS helps you plan ahead, avoid chaos, and enjoy more time together.'],
] as const;

function UsersIcon({ className }: { className?: string }) {
  return <Home className={className} />;
}
