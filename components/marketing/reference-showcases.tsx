import Link from 'next/link';
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Cloud,
  FileText,
  GraduationCap,
  Heart,
  HeartPulse,
  Home,
  HousePlus,
  Mail,
  MapPin,
  PlayCircle,
  Plus,
  ShieldCheck,
  ShoppingBasket,
  Smartphone,
  Sparkles,
  Star,
  UtensilsCrossed,
  Users,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const tones = {
  violet: 'border-violet-500/20 bg-violet-500/10 text-violet-400',
  green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  orange: 'border-orange-500/20 bg-orange-500/10 text-orange-400',
  blue: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
  pink: 'border-pink-500/20 bg-pink-500/10 text-pink-400',
} as const;

type Tone = keyof typeof tones;

function ReferencePage({ children }: { children: React.ReactNode }) {
  return (
    <div className="reference-page min-h-screen overflow-hidden bg-[#020811] text-white">
      {children}
    </div>
  );
}

function GradientText({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-gradient-to-r from-[#4c8df6] via-[#7755f6] to-[#a847e7] bg-clip-text text-transparent">
      {children}
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] px-3 text-[11px] font-medium text-white/85 shadow-[inset_0_1px_0_rgba(255,255,255,.025)]">
      <Sparkles className="h-3.5 w-3.5 text-violet-400" />
      {children}
    </span>
  );
}

function TopicIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: Tone }) {
  return (
    <span className={cn('mx-auto grid h-14 w-14 place-items-center rounded-full border bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,.04),0_12px_32px_rgba(0,0,0,.22)]', tones[tone])}>
      <Icon className="h-7 w-7" strokeWidth={2.2} />
    </span>
  );
}

function SquareIcon({ icon: Icon, tone = 'violet', className }: { icon: LucideIcon; tone?: Tone; className?: string }) {
  return (
    <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg border', tones[tone], className)}>
      <Icon className="h-[19px] w-[19px]" strokeWidth={2} />
    </span>
  );
}

function PrimaryButton({ href = '/signup', children }: { href?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-12 items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-[#435df0] to-[#7834e9] px-6 text-[13px] font-semibold shadow-[0_10px_32px_rgba(91,61,236,.24)] transition hover:brightness-110">
      {children}
    </Link>
  );
}

function OutlineButton({ href = '/how-it-works', children }: { href?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-12 items-center justify-center gap-3 rounded-xl border border-white/25 bg-white/[0.015] px-6 text-[13px] font-semibold transition hover:bg-white/[0.05]">
      <PlayCircle className="h-[18px] w-[18px]" />
      {children}
    </Link>
  );
}

function TinyAvatar({ index = 0, className }: { index?: number; className?: string }) {
  const palette = [
    'from-[#d39a72] via-[#f2c49f] to-[#5a2c23]',
    'from-[#f0c18f] via-[#9e603f] to-[#271714]',
    'from-[#f4c4a0] via-[#df936d] to-[#603329]',
    'from-[#d7a47c] via-[#f1c5a2] to-[#4b2b25]',
    'from-[#c98760] via-[#e6ab82] to-[#34211d]',
  ];
  return (
    <span className={cn('relative inline-block shrink-0 overflow-hidden rounded-full border border-white/45 bg-gradient-to-b', palette[index % palette.length], className)}>
      <span className="absolute left-1/2 top-[18%] h-[42%] w-[43%] -translate-x-1/2 rounded-full bg-[#f2bd94]" />
      <span className="absolute -bottom-[20%] left-1/2 h-[58%] w-[75%] -translate-x-1/2 rounded-[50%] bg-[#dce5e1]" />
      <span className="absolute left-1/2 top-[12%] h-[22%] w-[53%] -translate-x-1/2 rounded-t-full bg-[#38251f]" />
    </span>
  );
}

function FeatureCard({
  icon,
  tone,
  title,
  description,
  children,
  row = 1,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  description: string;
  children: React.ReactNode;
  row?: 1 | 2;
}) {
  return (
    <article className={cn('flex flex-col rounded-[14px] border border-white/[0.09] bg-[#08111c]/90 p-[13px] shadow-[inset_0_1px_0_rgba(255,255,255,.025),0_20px_50px_rgba(0,0,0,.2)]', row === 1 ? 'h-[374px]' : 'h-[350px]')}>
      <div className="flex items-center gap-2.5">
        <SquareIcon icon={icon} tone={tone} />
        <h3 className="text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
      </div>
      <p className="mt-3 min-h-[76px] text-[12px] leading-[18px] text-white/75">{description}</p>
      <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-white/[0.08] bg-gradient-to-br from-white/[0.05] to-white/[0.018] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,.02)]">
        {children}
      </div>
    </article>
  );
}

const FEATURE_TOPICS = [
  [CalendarDays, 'Organize\nSchedules', 'violet'],
  [CheckSquare2, 'Manage\nTasks', 'green'],
  [UtensilsCrossed, 'Plan\nMeals', 'orange'],
  [GraduationCap, 'Stay on Top of\nSchool', 'blue'],
  [Heart, 'Health &\nWellness', 'pink'],
  [Home, 'Home\nManagement', 'blue'],
  [Star, 'AI Family\nAssistant', 'violet'],
] as const;

export function FeaturesReferencePage() {
  return (
    <ReferencePage>
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-2 pt-[26px] sm:px-7">
        <section className="text-center">
          <Eyebrow>All-in-one family operating system</Eyebrow>
          <h1 className="mt-3 text-[38px] font-extrabold leading-[1.06] tracking-[-0.035em] sm:text-[48px]">
            Everything your family needs,
            <br />
            <GradientText>all in one intelligent place.</GradientText>
          </h1>
          <p className="mx-auto mt-3.5 max-w-[590px] text-[15px] leading-6 text-white/72">
            FamilyOS combines powerful tools with AI intelligence to help your family
            <br className="hidden sm:block" /> stay organized, connected, and ahead of what matters most.
          </p>
        </section>

        <section className="mx-auto mt-7 grid max-w-[842px] grid-cols-2 gap-y-7 sm:grid-cols-4 lg:grid-cols-7">
          {FEATURE_TOPICS.map(([Icon, title, tone]) => (
            <div key={title} className="text-center">
              <TopicIcon icon={Icon} tone={tone} />
              <h2 className="mt-2.5 whitespace-pre-line text-[15px] font-semibold leading-[21px]">{title}</h2>
            </div>
          ))}
        </section>

        <section className="mt-4 border-t border-white/[0.07] pt-[14px] text-center">
          <h2 className="text-[27px] font-bold tracking-[-0.025em]">Powerful features. Peaceful families.</h2>
          <p className="mt-1.5 text-[13px] text-white/65">Discover how FamilyOS makes everyday life easier.</p>
        </section>

        <section className="mt-[18px] grid gap-[14px] px-0 sm:grid-cols-2 lg:grid-cols-4 lg:px-[14px]">
          <FeatureCard
            icon={CalendarDays}
            tone="violet"
            title="Smart Calendar"
            description="See everyone's schedule in one place. AI automatically adds events from emails, texts, and school updates."
          >
            <MiniCalendar />
          </FeatureCard>
          <FeatureCard
            icon={CheckSquare2}
            tone="green"
            title="Tasks & Chores"
            description="Assign chores, track progress, and reward good habits. AI suggests tasks based on your family's routine."
          >
            <TaskList />
          </FeatureCard>
          <FeatureCard
            icon={UtensilsCrossed}
            tone="orange"
            title="Meal Planning"
            description="Plan meals for the week, automatically create grocery lists, and discover recipes your family will love."
          >
            <MealPlan />
          </FeatureCard>
          <FeatureCard
            icon={ShoppingBasket}
            tone="green"
            title="Grocery Lists"
            description="Smart lists that update automatically based on your meal plan and what you actually need."
          >
            <GroceryList />
          </FeatureCard>
          <FeatureCard
            icon={GraduationCap}
            tone="blue"
            title="School Hub"
            description="Keep track of homework, assignments, school events, important dates, and teacher communications."
            row={2}
          >
            <SchoolList />
          </FeatureCard>
          <FeatureCard
            icon={HeartPulse}
            tone="pink"
            title="Health & Medications"
            description="Never miss a dose or appointment. Get smart reminders and keep health info all in one place."
            row={2}
          >
            <HealthList />
          </FeatureCard>
          <FeatureCard
            icon={HousePlus}
            tone="green"
            title="Home Management"
            description="Track maintenance, warranties, important documents, and reminders to keep your home running smoothly."
            row={2}
          >
            <HomeList />
          </FeatureCard>
          <FeatureCard
            icon={Sparkles}
            tone="violet"
            title="AI Family Assistant"
            description="Your AI sidekick that helps plan, organize, and keep your family ahead of everything."
            row={2}
          >
            <AssistantChat />
          </FeatureCard>
        </section>

        <section className="mx-0 mt-[18px] grid h-auto min-h-[105px] items-center gap-5 rounded-[13px] border border-white/[0.09] bg-[radial-gradient(circle_at_55%_0%,rgba(82,63,232,.15),transparent_46%),linear-gradient(110deg,rgba(89,48,189,.13),rgba(8,17,28,.9))] px-7 py-5 sm:mx-[14px] lg:h-[109px] lg:py-3">
          <div className="flex items-center gap-5">
            <Sparkles className="hidden h-10 w-10 shrink-0 text-violet-400 sm:block" strokeWidth={1.7} />
            <div>
              <h2 className="text-[19px] font-semibold tracking-[-0.02em]">One app. Every part of your family life.</h2>
              <p className="mt-1 text-[13px] leading-5 text-white/68">From daily routines to life&apos;s big moments, FamilyOS brings it all together<br className="hidden xl:block" /> so you can focus on what really matters.</p>
            </div>
          </div>
          <PrimaryButton>Get Started Free</PrimaryButton>
          <OutlineButton>See How It Works</OutlineButton>
        </section>

        <TrustStrip />
      </div>
    </ReferencePage>
  );
}

function MiniCalendar() {
  const days = ['28', '29', '30', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '1'];
  return (
    <div className="relative h-full text-[8px] text-white/65">
      <div className="flex items-center justify-between text-[10px] text-white/85"><span>May 2024</span><span className="text-white/45">⌄　×</span></div>
      <div className="mt-3 grid grid-cols-7 gap-y-2 text-center text-[6px] text-white/42">{['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="mt-1.5 grid grid-cols-7 gap-y-2 text-center">
        {days.map((day, index) => <span key={`${day}-${index}`} className={cn(index < 3 && 'text-white/30', index === 11 && 'mx-auto grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-white')}>{day}</span>)}
      </div>
      <div className="absolute left-[43px] top-[66px] w-[112px] rounded-md border border-blue-400/30 bg-blue-600/25 px-2 py-1 text-[8px] leading-[10px] text-white">School Drop-off<br /><span className="text-white/55">8:00 AM</span></div>
      <div className="absolute left-[43px] top-[95px] w-[112px] rounded-md border border-violet-400/30 bg-violet-600/25 px-2 py-1 text-[8px] leading-[10px] text-white">Soccer Practice<br /><span className="text-white/55">4:00 PM</span></div>
      <div className="absolute left-[43px] top-[124px] w-[112px] rounded-md border border-fuchsia-400/30 bg-fuchsia-600/20 px-2 py-1 text-[8px] leading-[10px] text-white">Piano Lesson<br /><span className="text-white/55">5:30 PM</span></div>
      <div className="absolute left-[43px] top-[153px] w-[112px] rounded-md border border-rose-400/30 bg-rose-600/20 px-2 py-1 text-[8px] leading-[10px] text-white">Family Dinner<br /><span className="text-white/55">7:00 PM</span></div>
    </div>
  );
}

function TaskList() {
  const rows = [['Take out the trash', 'Liam'], ['Water plants', 'Emma'], ['Set the table', 'Olivia'], ['Load dishwasher', 'Noah']];
  return (
    <div>
      <p className="mb-2.5 text-[10px] font-semibold">Today&apos;s Chores</p>
      <div className="space-y-2.5">
        {rows.map(([task, name], index) => (
          <div key={task} className="flex items-center gap-2">
            <TinyAvatar index={index} className="h-[22px] w-[22px]" />
            <div className="min-w-0 flex-1"><p className="truncate text-[9px]">{task}</p><p className="text-[7px] text-white/45">{name}</p></div>
            {index < 2 ? <Check className="h-[18px] w-[18px] rounded-full bg-emerald-400/80 p-1 text-white" /> : <Circle className="h-[18px] w-[18px] text-white/40" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function MealPlan() {
  const meals = [['Mon', 'Garlic Butter Salmon', 'with Asparagus'], ['Tue', 'Chicken Tacos', 'with Rice'], ['Wed', 'Spaghetti Bolognese', 'with Salad'], ['Thu', 'Teriyaki Chicken', 'with Veggies']];
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col">
      <p className="px-3 pt-3 text-[10px] font-semibold">This Week&apos;s Plan</p>
      <div className="flex-1 space-y-4 px-3 pt-3">
        {meals.map(([day, meal, side]) => <div key={day} className="grid grid-cols-[27px_1fr] text-[9px] leading-[12px]"><span className="text-white/55">{day}</span><span>{meal}<br /><span className="text-white/72">{side}</span></span></div>)}
      </div>
      <div className="border-t border-white/[0.07] px-3 py-2 text-center text-[9px] text-violet-300">View Full Plan</div>
    </div>
  );
}

function GroceryList() {
  const items = ['Milk', 'Eggs', 'Chicken Breast', 'Broccoli', 'Avocados', 'Whole Wheat Bread'];
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3">
      <p className="mb-2.5 text-[10px] font-semibold">My Grocery List</p>
      <div className="flex-1 space-y-2.5">{items.map((item) => <p key={item} className="flex items-center gap-2 text-[9px]"><Circle className="h-[13px] w-[13px] text-white/55" />{item}</p>)}</div>
      <div className="rounded-lg border border-white/10 px-2 py-1.5 text-[9px] text-white/42"><Plus className="mr-1 inline h-3 w-3" /> Add item</div>
    </div>
  );
}

function SchoolList() {
  const items = [['Math Homework', 'Due Tomorrow'], ['Science Project', 'Due May 10'], ['Field Trip', 'May 16']];
  return <ListPanel title="Upcoming" footer="View All Assignments">{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><span className={cn('grid h-6 w-6 place-items-center rounded-md', ['bg-pink-500/55', 'bg-indigo-500/55', 'bg-blue-500/55'][i])}><FileText className="h-3.5 w-3.5" /></span><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function HealthList() {
  const items = [['Liam – Allergy Medication', '8:00 AM'], ['Olivia – Vitamin D', '12:00 PM'], ['Dentist Appointment', '3:30 PM']];
  return <ListPanel title="Today&apos;s Reminders" footer="View All">{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><TinyAvatar index={i + 1} className="h-6 w-6" /><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function HomeList() {
  const items = [['HVAC Filter Change', 'May 5'], ['Garage Door Service', 'May 20'], ['Water Heater Flush', 'June 2']];
  return <ListPanel title="Upcoming" footer="View All">{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><span className="grid h-6 w-6 place-items-center rounded-md bg-white/[0.045]">{i === 0 ? <Wrench className="h-3.5 w-3.5 text-white/60" /> : <HousePlus className="h-3.5 w-3.5 text-white/60" />}</span><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function ListPanel({ title, footer, children }: { title: string; footer: string; children: React.ReactNode }) {
  return <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3"><p className="mb-3 text-[10px] font-semibold">{title}</p><div className="flex-1 space-y-3">{children}</div><div className="rounded-lg border border-white/[0.06] py-2 text-center text-[9px] text-violet-300">{footer}</div></div>;
}

function AssistantChat() {
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3 text-[8px] leading-[11px]">
      <div className="ml-auto rounded-lg bg-violet-600 px-2.5 py-2">What&apos;s happening this week?</div>
      <div className="mt-2 mr-3 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2">You have 6 events this week,<br />2 chores due, and 1 appointment.</div>
      <div className="mt-2 ml-auto rounded-lg bg-violet-600 px-2.5 py-2">Plan dinners for the week</div>
      <div className="mt-2 mr-3 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2">Here&apos;s your meal plan<br />based on your preferences.</div>
      <span className="mx-auto mt-auto h-8 w-8 shrink-0 rounded-full border border-blue-300 bg-[radial-gradient(circle,#fff_0,#48baf7_12%,#8a45e8_42%,#07101b_72%)] shadow-[0_0_15px_rgba(114,80,255,.75)]" />
    </div>
  );
}

function TrustStrip() {
  const items = [
    [ShieldCheck, 'Secure & Private', 'Your data is always\nprotected'],
    [Smartphone, 'Works Everywhere', 'Web, iOS, Android,\nand more'],
    [Cloud, 'Real-time Sync', 'Changes sync instantly\nacross all devices'],
    [Heart, 'Loved by Families', '10,000+ families\nand growing'],
  ] as const;
  return (
    <section className="mx-0 mt-[18px] grid gap-6 border-t border-white/[0.06] px-7 py-6 sm:mx-[14px] sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([Icon, title, body]) => <div key={title} className="flex items-center gap-3.5"><Icon className="h-7 w-7 shrink-0 text-violet-400" strokeWidth={1.8} /><div><h3 className="text-[12px] font-semibold">{title}</h3><p className="mt-1 whitespace-pre-line text-[12px] leading-[17px] text-white/62">{body}</p></div></div>)}
    </section>
  );
}

const FLOW_CARDS = [
  [Mail, 'School Email Arrives', 'FamilyOS scans and\nunderstands the details.'],
  [Sparkles, 'AI Extracts & Organizes', 'Events, deadlines, and\naction items are added\nto the right places.'],
  [CalendarDays, 'Everyone Stays In Sync', 'Your whole family is\nupdated automatically.'],
  [CheckCircle2, 'You Stay Ahead', 'AI reminds, suggests, and\nhelps you plan better.'],
] as const;

const WORK_STEPS = [
  [UsersRound, 'Create Your Family', 'Set up your household in\nminutes and invite family\nmembers.'],
  [Mail, 'Add or Forward Anything', 'Forward emails, snap photos\nof flyers, or add events, tasks,\nand lists.'],
  [Sparkles, 'AI Gets to Work', 'Our AI reads, understands, and\norganizes everything into the\nright places.'],
  [Users, 'Everyone Stays in Sync', 'Calendars, tasks, reminders,\nand updates are shared in\nreal time.'],
  [CheckCircle2, 'Life Runs Smoother', 'FamilyOS helps you plan\nahead, avoid chaos, and\nenjoy more time together.'],
] as const;

export function HowItWorksReferencePage() {
  return (
    <ReferencePage>
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-3 pt-8 sm:px-[31px]">
        <section className="relative min-h-[463px] lg:h-[463px]">
          <div className="max-w-[414px] pt-[26px] lg:pl-[14px]">
            <Eyebrow>Simple. Smart. Life-changing.</Eyebrow>
            <h1 className="mt-3 text-[50px] font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-[58px]">
              How FamilyOS
              <br />
              <GradientText>Works</GradientText>
            </h1>
            <p className="mt-[16px] max-w-[390px] text-[16px] leading-[26px] text-white/78">FamilyOS is your family&apos;s AI-powered operating<br className="hidden sm:block" /> system. It brings everything together—and helps<br className="hidden sm:block" /> you stay ahead of what matters most.</p>
            <div className="mt-[20px] flex flex-wrap gap-[15px]">
              <PrimaryButton>Get Started Free <ArrowRight className="h-4 w-4" /></PrimaryButton>
              <OutlineButton href="#steps">See It in Action</OutlineButton>
            </div>
            <SocialProof />
          </div>

          <div className="absolute left-[48.2%] top-0 hidden lg:block">
            <DetailedPhone />
          </div>

          <svg className="pointer-events-none absolute left-[64.5%] top-4 hidden h-[392px] w-[132px] overflow-visible lg:block" viewBox="0 0 132 392" fill="none" aria-hidden="true">
            <path d="M6 33 C55 31 62 8 118 8" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 143 C55 143 71 140 118 140" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 253 C57 253 72 253 118 253" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 333 C52 333 55 374 118 374" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            {[['118','8'],['118','140'],['118','253'],['118','374']].map(([x,y]) => <path key={y} d={`M${x} ${y}l-5-3m5 3-5 3`} stroke="#7c4dff" strokeOpacity=".8" />)}
          </svg>

          <div className="absolute right-[29px] top-[5px] hidden w-[196px] lg:flex lg:flex-col lg:gap-5">
            {FLOW_CARDS.map(([Icon, title, body], index) => (
              <article key={title} className={cn('flex gap-3 rounded-[14px] border border-white/[0.10] bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.025),0_16px_38px_rgba(0,0,0,.18)]', index === 1 ? 'min-h-[101px]' : 'min-h-[80px]')}>
                <Icon className="mt-0.5 h-6 w-6 shrink-0 text-violet-400" />
                <div><h2 className="text-[11px] font-semibold">{title}</h2><p className="mt-1.5 whitespace-pre-line text-[10px] leading-[15px] text-white/62">{body}</p></div>
              </article>
            ))}
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:hidden">
            <div className="mx-auto sm:col-span-2"><DetailedPhone /></div>
            {FLOW_CARDS.map(([Icon, title, body]) => <article key={title} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4"><Icon className="h-6 w-6 text-violet-400" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 whitespace-pre-line text-xs leading-5 text-white/65">{body}</p></div></article>)}
          </div>
        </section>

        <StepsPanel />
        <MagicPanel />
        <TestimonialsPanel />
      </div>
    </ReferencePage>
  );
}

function SocialProof() {
  return (
    <div className="mt-[19px] flex items-center gap-3">
      <div className="flex -space-x-2">{[0, 1, 2, 3, 4].map((index) => <TinyAvatar key={index} index={index} className="h-9 w-9 border-2 border-[#07101a]" />)}</div>
      <div><div className="flex gap-1 text-amber-400">{Array.from({ length: 5 }).map((_, i) => <Star key={i} className="h-3 w-3 fill-current" />)}</div><p className="mt-1 text-[11px] text-white/70">10,000+ families love FamilyOS</p></div>
    </div>
  );
}

function DetailedPhone() {
  return (
    <div className="relative h-[443px] w-[216px] rounded-[35px] border-[3px] border-[#595959] bg-[#030507] p-[8px] shadow-[0_22px_70px_rgba(0,0,0,.52),inset_0_0_0_1px_#111]">
      <div className="absolute left-1/2 top-[7px] z-10 h-[21px] w-[84px] -translate-x-1/2 rounded-full bg-black" />
      <div className="h-full overflow-hidden rounded-[27px] bg-[#07101a] px-[10px] pb-[10px] pt-[14px]">
        <div className="flex items-center justify-between px-1 text-[8px] font-semibold"><span>9:41</span><span>⌁ ▴ ▰</span></div>
        <div className="mt-[22px] flex items-start justify-between px-1"><h3 className="text-[13px] font-semibold leading-4">Good morning,<br />The Johnson Family 👋</h3><Bell className="h-4 w-4" /></div>
        <PhonePanel title="Today&apos;s Snapshot" className="mt-3">
          {[['3 Events Today','orange'],['2 Tasks Due','amber'],['1 Medication Reminder','blue'],['No Conflicts','green']].map(([item, color], i) => <div key={item} className="flex items-center gap-2 py-1 text-[7px]"><span className={cn('grid h-3.5 w-3.5 place-items-center rounded-full', color === 'orange' && 'bg-orange-500/20 text-orange-400', color === 'amber' && 'bg-amber-500/20 text-amber-400', color === 'blue' && 'bg-blue-500/20 text-blue-400', color === 'green' && 'bg-emerald-500/20 text-emerald-400')}>{i < 3 ? <CalendarDays className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />}</span>{item}</div>)}
        </PhonePanel>
        <PhonePanel title="Upcoming" className="mt-2">
          {[['Soccer Practice','Today · 5:00 PM'],['Math Test','Tomorrow · 9:00 AM'],['Family Dinner','Tomorrow · 6:30 PM']].map(([item, date], i) => <div key={item} className="flex items-center gap-2 py-1.5"><span className="grid h-4 w-4 place-items-center rounded-full bg-orange-500/25 text-[7px] text-orange-400">{i + 1}</span><div><p className="text-[7px]">{item}</p><p className="text-[6px] text-white/42">{date}</p></div></div>)}
        </PhonePanel>
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.06] px-1 pt-2 text-[6px] text-white/50"><Home className="h-3.5 w-3.5 text-violet-400" /><CalendarDays className="h-3.5 w-3.5" /><span className="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-lg text-white">+</span><CheckSquare2 className="h-3.5 w-3.5" /><span className="text-sm leading-none">•••</span></div>
      </div>
    </div>
  );
}

function PhonePanel({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-[9px] bg-white/[0.035] p-2.5', className)}><div className="mb-1 flex items-center justify-between"><p className="text-[8px] font-semibold">{title}</p><CalendarDays className="h-3 w-3 text-violet-400" /></div>{children}</div>;
}

function StepsPanel() {
  return (
    <section id="steps" className="rounded-[15px] border border-white/[0.08] bg-[#06101a]/78 px-3 pb-3 pt-[5px] shadow-[inset_0_1px_0_rgba(255,255,255,.02)]">
      <div className="text-center"><h2 className="text-[27px] font-bold tracking-[-0.025em]">It works in 5 simple steps</h2><p className="mt-1 text-[12px] text-white/62">Powerful technology. Simple for families.</p></div>
      <div className="mt-[41px] grid gap-7 lg:grid-cols-5">
        {WORK_STEPS.map(([Icon, title, body], index) => (
          <article key={title} className="relative min-h-[175px] rounded-[13px] border border-white/[0.09] bg-white/[0.04] px-3 pb-3 pt-7 text-center shadow-[inset_0_1px_0_rgba(255,255,255,.025)]">
            <span className="absolute -top-[29px] left-1/2 grid h-[38px] w-[38px] -translate-x-1/2 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-700 text-[15px] font-semibold shadow-[0_8px_20px_rgba(90,48,220,.32)]">{index + 1}</span>
            {index < 4 && <><span className="absolute -top-[10px] left-[68%] hidden w-[82%] border-t border-dashed border-violet-500/65 lg:block" /><ArrowRight className="absolute -right-[35px] -top-[16px] hidden h-3 w-3 text-violet-400 lg:block" /></>}
            <Icon className="mx-auto h-[45px] w-[45px] text-violet-500" strokeWidth={1.8} />
            <h3 className="mt-3 text-[11px] font-semibold">{title}</h3>
            <p className="mt-2 whitespace-pre-line text-[10px] leading-[16px] text-white/63">{body}</p>
          </article>
        ))}
      </div>
      <div className="mt-[13px] border-t border-white/[0.06] pt-[13px]">
        <div className="flex min-h-[66px] flex-col gap-4 rounded-[12px] border border-white/[0.08] bg-white/[0.035] px-7 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4"><ShieldCheck className="h-9 w-9 text-violet-400" /><div><h3 className="text-[13px] font-semibold">Secure. Private. Built for Families.</h3><p className="mt-1 text-[11px] text-white/60">Your data is always protected and only shared with your family.</p></div></div>
          <Link href="/security" className="flex items-center gap-3 text-[11px] text-violet-400">Learn more about security <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </div>
    </section>
  );
}

function MagicPanel() {
  const bullets = ['Snap a photo of a school flyer', 'AI extracts events, dates & details', 'Automatically adds to your calendar', 'Creates tasks, reminders & lists', 'Notifies the right people', 'Saves you hours every week'];
  return (
    <section className="mt-[14px] grid gap-6 rounded-[15px] border border-white/[0.08] bg-[#06101a]/78 p-5 lg:h-[334px] lg:grid-cols-[274px_1fr]">
      <div>
        <h2 className="whitespace-nowrap text-[27px] font-bold tracking-[-0.03em]">The magic is in the <GradientText>AI</GradientText><Sparkles className="ml-0.5 inline h-5 w-5 text-violet-400" /></h2>
        <p className="mt-2 text-[14px] leading-6 text-white/68">FamilyOS turns scattered information into<br />organized action—automatically.</p>
        <ul className="mt-4 space-y-2.5">{bullets.map((item) => <li key={item} className="flex items-center gap-2.5 text-[12px] text-white/73"><CheckCircle2 className="h-4 w-4 text-violet-400" />{item}</li>)}</ul>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-3 lg:grid-cols-[166px_28px_176px_28px_1fr]">
        <MagicCapture />
        <ArrowRight className="mt-[137px] hidden h-7 w-7 text-violet-500 lg:block" />
        <MagicDetails />
        <ArrowRight className="mt-[137px] hidden h-7 w-7 text-violet-500 lg:block" />
        <MagicCalendar />
      </div>
    </section>
  );
}

function MagicCapture() {
  return (
    <div><p className="mb-2 text-center text-[11px] font-semibold">1. You capture it</p><div className="relative h-[271px] overflow-hidden rounded-[11px] bg-[radial-gradient(circle_at_70%_25%,#dac6a6,transparent_24%),radial-gradient(circle_at_25%_35%,#747966,transparent_35%),linear-gradient(135deg,#a9a18a,#4b5147)]">
      <div className="absolute -bottom-16 -left-6 h-[205px] w-[92px] rotate-[18deg] rounded-[45%] bg-gradient-to-r from-[#bb7655] to-[#e3a77f] shadow-xl" />
      <div className="absolute left-[35px] top-[18px] h-[245px] w-[101px] rounded-[17px] border-[5px] border-[#16181a] bg-[#202327] shadow-[0_10px_25px_rgba(0,0,0,.38)]"><div className="mx-auto mt-1 h-1 w-8 rounded-full bg-black" /></div>
      <Flyer className="absolute left-[39px] top-[42px] h-[190px] w-[93px]" />
    </div></div>
  );
}

function Flyer({ className }: { className?: string }) {
  return <div className={cn('bg-[#f0f0ec] p-2 text-[#17191d] shadow-lg', className)}><p className="text-[12px] font-black leading-[12px]">SPRING<br />SOCCER<br />TOURNAMENT</p><p className="mt-2 text-[10px] font-black">MAY 18-19</p><p className="mt-1 border-y border-black py-1 text-[5px] font-bold">LOCATION: RIVER PARK</p><p className="mt-2 text-[5px] font-bold leading-[7px]">CHECK IN: 8:30 AM<br />GAMES START: 9:00 AM</p><div className="absolute bottom-2 right-1 grid h-10 w-10 place-items-center rounded-full border-[5px] border-[#15181b] text-[17px]">⚽</div></div>;
}

function MagicDetails() {
  const rows: [LucideIcon, string][] = [[CalendarDays, 'Spring Soccer Tournament'], [CalendarDays, 'May 18–19, 2024'], [Bell, 'Check in: 8:30 AM'], [Bell, 'Games start: 9:00 AM'], [MapPin, 'Riverside Park'], [CheckSquare2, 'Bring: Water bottle, shin\nguards, team jersey']];
  return <div><p className="mb-2 text-center text-[11px] font-semibold">2. AI understands it</p><div className="h-[271px] rounded-[12px] border border-white/[0.10] bg-white/[0.035] p-4"><Sparkles className="h-6 w-6 text-violet-400" /><h3 className="mt-3 text-[10px] font-semibold">AI Extracted Details</h3><div className="mt-3 space-y-3">{rows.map(([Icon, text]) => <p key={text} className="flex gap-2 whitespace-pre-line text-[9px] leading-[12px] text-white/76"><Icon className="h-3 w-3 shrink-0 text-violet-400" />{text}</p>)}</div></div></div>;
}

function MagicCalendar() {
  return <div><p className="mb-2 whitespace-nowrap text-center text-[11px] font-semibold">3. It&apos;s organized for your family</p><div className="h-[271px] rounded-[12px] border border-white/[0.10] bg-white/[0.035] p-3"><div className="flex justify-between text-[9px] font-semibold"><span>May 2024</span><ChevronRight className="h-3 w-3" /></div><div className="mt-3 grid grid-cols-7 gap-y-1 text-center text-[5px] text-white/50">{['SUN','MON','TUE','WED','THU','FRI','SAT','12','13','14','15','16','17','18'].map((d,i) => <span key={`${d}-${i}`} className={cn(d === '18' && 'mx-auto grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-white')}>{d}</span>)}</div><div className="mt-3 rounded-lg bg-violet-600/25 p-3"><p className="text-[9px] font-semibold">Spring Soccer Tournament</p><p className="mt-2 text-[7px] leading-[10px] text-white/58">May 18 – May 19<br />8:30 AM – 12:00 PM<br />Riverside Park</p></div><div className="mt-3 border-t border-white/[0.07] pt-2"><p className="text-[8px] font-semibold">Tasks Created</p>{['Pack soccer gear','Bring snacks','Team jersey'].map(item => <p key={item} className="mt-1.5 flex items-center gap-1.5 text-[7px]"><CheckCircle2 className="h-2.5 w-2.5 text-violet-400" />{item}</p>)}<div className="mt-2 flex -space-x-1">{[0,1,2].map(i => <TinyAvatar key={i} index={i} className="h-5 w-5" />)}</div></div></div></div>;
}

function TestimonialsPanel() {
  const testimonials = [
    ["FamilyOS has completely\nchanged how we stay organized.\nI don't know how we lived\nwithout it!", 'Jessica M.', 'Mom of 3'],
    ['The AI saves me so much time.\nIt catches things I would\nnormally miss.', 'David T.', 'Dad of 2'],
    ['Finally, an app that actually\nbrings everything together in\none place.', 'Amanda R.', 'Mom of 4'],
    ['Our whole family is on the same\npage now. Less stress and more\ntime together.', 'Chris & Maria', 'Parents of 3'],
    ["The school email scanner\nfeature is pure genius. It's like\nhaving an assistant.", 'Priya K.', 'Mom of 2'],
  ];
  return (
    <section className="relative mt-[21px] rounded-[15px] border border-white/[0.08] bg-[#06101a]/78 px-12 pb-3 pt-[6px]">
      <h2 className="text-center text-[23px] font-bold tracking-[-0.025em]"><GradientText>Loved</GradientText> by families everywhere</h2>
      <button type="button" aria-label="Previous testimonial" className="absolute left-1 top-[98px] grid h-8 w-8 place-items-center rounded-full bg-violet-500/10 text-white/65"><ChevronLeft className="h-4 w-4" /></button>
      <button type="button" aria-label="Next testimonial" className="absolute right-1 top-[98px] grid h-8 w-8 place-items-center rounded-full bg-violet-500/10 text-white/65"><ChevronRight className="h-4 w-4" /></button>
      <div className="mt-1.5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-5">{testimonials.map(([quote,name,role]) => <article key={name} className="min-h-[142px] rounded-[10px] border border-white/[0.07] bg-white/[0.035] p-3"><div className="flex gap-0.5 text-amber-400">{Array.from({length:5}).map((_,i)=><Star key={i} className="h-2.5 w-2.5 fill-current" />)}</div><p className="mt-2 whitespace-pre-line text-[8.5px] leading-[13px] text-white/80">&quot;{quote}&quot;</p><p className="mt-4 text-[8px] font-semibold">{name}</p><p className="mt-0.5 text-[7px] text-white/50">{role}</p></article>)}</div>
    </section>
  );
}
