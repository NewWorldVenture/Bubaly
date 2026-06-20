import Link from 'next/link';
import {
  ArrowRight,
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
  Sparkles,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function PageWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('soft-grid-bg min-h-dvh text-white', className)}>{children}</div>;
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
    <span className={cn('inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-4 py-2 text-sm font-semibold text-white/90', className)}>
      <Icon className="h-4 w-4 text-blue-400" />
      {children}
    </span>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-14 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-7 text-base font-bold text-white shadow-glow transition hover:scale-[1.01]"
    >
      {children}
      <ArrowRight className="h-5 w-5" />
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
            'grid h-11 w-11 place-items-center rounded-full border-2 border-[#07101a] text-xs font-bold text-white',
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
    <div className="relative mx-auto w-full max-w-[760px] pt-8 lg:pt-0">
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
    <div className={cn('rounded-[2rem] border-[6px] border-neutral-800 bg-black p-2 shadow-2xl', className)}>
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
    <section className="showcase-panel overflow-hidden p-8 lg:p-12">
      <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
        <div>
          <h2 className="text-4xl font-bold leading-tight">
            Your <GradientText>AI Family</GradientText> Assistant
          </h2>
          <p className="mt-6 text-lg leading-8 text-white/72">
            Your built-in family assistant helps you plan, organize, and stay ahead of what matters most.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/86">
            {['Create schedules instantly', 'Plan meals and generate grocery lists', 'Get reminders and helpful suggestions', 'Answers tailored to your family'].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-violet-400" /> {item}
              </li>
            ))}
          </ul>
          <Link href="/ai" className="mt-8 inline-flex rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold">
            Try the AI Assistant
          </Link>
        </div>
        <div className="relative min-h-[360px] overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_80%_35%,rgba(245,145,77,0.20),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]">
          <div className="absolute inset-0 bg-gradient-to-r from-[#08111c] via-[#08111c]/65 to-transparent" />
          <div className="absolute bottom-0 right-0 flex h-[82%] w-[70%] items-end justify-center gap-3 opacity-95">
            {['h-56 w-36 bg-blue-900/60', 'h-72 w-44 bg-amber-900/55', 'h-48 w-32 bg-emerald-900/55', 'h-52 w-32 bg-rose-900/55'].map((shape, index) => (
              <div key={shape} className={cn('rounded-t-full border border-white/10', shape)}>
                <div className="mx-auto mt-5 h-16 w-16 rounded-full bg-gradient-to-br from-amber-200 to-rose-300" />
                {index === 1 && <div className="mx-auto mt-6 h-20 w-28 rounded-xl bg-black/35" />}
              </div>
            ))}
          </div>
          <div className="absolute left-12 top-16 rounded-xl bg-white/[0.07] px-5 py-3 text-sm backdrop-blur">What&apos;s happening this week?</div>
          <div className="absolute left-20 top-36 max-w-[250px] rounded-xl bg-white/[0.08] p-5 text-sm leading-6 backdrop-blur">
            You have 6 events this week. Soccer practice on Tue & Thu, Math test on Friday, and Family dinner on Sunday.
          </div>
          <div className="absolute left-44 top-72 rounded-xl bg-white/[0.08] px-5 py-3 text-sm backdrop-blur">Plan dinners for the week</div>
          <div className="absolute left-20 bottom-8 max-w-[245px] rounded-xl bg-white/[0.08] p-5 text-sm leading-6 backdrop-blur">
            Here&apos;s your meal plan: Honey Garlic Chicken, Tacos, Salmon & Veggies, Pasta Primavera, Homemade Pizza.
          </div>
          <span className="glow-dot absolute left-4 top-40 h-8 w-8" />
          <span className="glow-dot absolute left-4 bottom-20 h-8 w-8" />
        </div>
      </div>
    </section>
  );
}

export function TestimonialBand({ compact = false }: { compact?: boolean }) {
  // Honest, benefit-driven copy — no fabricated quotes, names, ratings, or press
  // mentions. Real customer testimonials can be wired here when they exist.
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
      <div className="mt-10 border-t border-white/8 pt-8 text-center">
        <p className="text-sm text-white/70">
          Row-level security on every table · Private document storage · You stay in control of your data
        </p>
      </div>
    </section>
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
