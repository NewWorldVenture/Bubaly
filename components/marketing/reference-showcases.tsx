import Link from 'next/link';
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
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
import { getPublicStats } from '@/lib/marketing/stats';
import { familiesNote } from '@/lib/marketing/format';
import { getTranslations } from '@/lib/i18n/server';

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
    <div className="reference-page soft-grid-bg min-h-dvh overflow-hidden text-fg transition-colors duration-300">
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
    <Link href={href} className="inline-flex h-12 items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-[#435df0] to-[#7834e9] px-6 text-[13px] font-semibold text-brand-fg shadow-[0_10px_32px_rgba(91,61,236,.24)] transition hover:brightness-110">
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

/** The server translator, threaded into the mock panels below. These render
 *  product screenshots in markup rather than images, so every label in them is
 *  real on-screen copy and has to come from the catalogue like any other. */
type T = (key: string, params?: Record<string, string | number>) => string;

/** Weekday column headers for the calendar mocks. Abbreviations differ per
 *  language (and are not always three letters), so they come from the
 *  catalogue rather than being sliced off a longer name. */
const WEEKDAY_KEYS = [
  'marketing.mock.weekday.sun', 'marketing.mock.weekday.mon', 'marketing.mock.weekday.tue',
  'marketing.mock.weekday.wed', 'marketing.mock.weekday.thu', 'marketing.mock.weekday.fri',
  'marketing.mock.weekday.sat',
] as const;

function FeatureCard({
  id,
  icon,
  tone,
  title,
  description,
  children,
  row = 1,
}: {
  id?: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  description: string;
  children: React.ReactNode;
  row?: 1 | 2;
}) {
  return (
    <article id={id} className={cn('dark flex scroll-mt-24 flex-col rounded-[14px] border border-white/[0.09] bg-[#08111c]/90 p-[13px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.025),0_20px_50px_rgba(0,0,0,.2)]', row === 1 ? 'h-[374px]' : 'h-[350px]')}>
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
  [CalendarDays, 'marketing.features.topic.schedules', 'violet'],
  [CheckSquare2, 'marketing.features.topic.tasks', 'green'],
  [UtensilsCrossed, 'marketing.features.topic.meals', 'orange'],
  [GraduationCap, 'marketing.features.topic.school', 'blue'],
  [Heart, 'marketing.features.topic.health', 'pink'],
  [Home, 'marketing.features.topic.home', 'blue'],
  [Star, 'marketing.features.topic.assistant', 'violet'],
] as const;

export async function FeaturesReferencePage() {
  const t = await getTranslations();

  return (
    <ReferencePage>
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-2 pt-[26px] sm:px-7">
        <section className="text-center">
          <Eyebrow>{t('marketing.tagline')}</Eyebrow>
          <h1 className="mt-3 text-[38px] font-extrabold leading-[1.06] tracking-[-0.035em] sm:text-[48px]">
            {t('marketing.features.hero.titleLead')}
            <br />
            <GradientText>{t('marketing.features.hero.titleAccent')}</GradientText>
          </h1>
          <p className="mx-auto mt-3.5 max-w-[590px] text-[15px] leading-6 text-white/72">
            {t('marketing.features.hero.subtitleLead')}
            <br className="hidden sm:block" /> {t('marketing.features.hero.subtitleRest')}
          </p>
        </section>

        <section className="mx-auto mt-7 grid max-w-[842px] grid-cols-2 gap-y-7 sm:grid-cols-4 lg:grid-cols-7">
          {FEATURE_TOPICS.map(([Icon, titleKey, tone]) => (
            <div key={titleKey} className="text-center">
              <TopicIcon icon={Icon} tone={tone} />
              <h2 className="mt-2.5 whitespace-pre-line text-[15px] font-semibold leading-[21px]">{t(titleKey)}</h2>
            </div>
          ))}
        </section>

        <section className="mt-4 border-t border-white/[0.07] pt-[14px] text-center">
          <h2 className="text-[27px] font-bold tracking-[-0.025em]">{t('marketing.features.sectionTitle')}</h2>
          <p className="mt-1.5 text-[13px] text-white/65">{t('marketing.features.sectionSubtitle')}</p>
        </section>

        <section className="mt-[18px] grid gap-[14px] px-0 sm:grid-cols-2 lg:grid-cols-4 lg:px-[14px]">
          <FeatureCard
            id="smart-calendar"
            icon={CalendarDays}
            tone="violet"
            title={t('marketing.features.card.calendar.title')}
            description={t('marketing.features.card.calendar.description')}
          >
            <MiniCalendar t={t} />
          </FeatureCard>
          <FeatureCard
            id="tasks-chores"
            icon={CheckSquare2}
            tone="green"
            title={t('marketing.features.card.tasks.title')}
            description={t('marketing.features.card.tasks.description')}
          >
            <TaskList t={t} />
          </FeatureCard>
          <FeatureCard
            id="meal-planning"
            icon={UtensilsCrossed}
            tone="orange"
            title={t('marketing.features.card.meals.title')}
            description={t('marketing.features.card.meals.description')}
          >
            <MealPlan t={t} />
          </FeatureCard>
          <FeatureCard
            icon={ShoppingBasket}
            tone="green"
            title={t('marketing.features.card.grocery.title')}
            description={t('marketing.features.card.grocery.description')}
          >
            <GroceryList t={t} />
          </FeatureCard>
          <FeatureCard
            id="school-hub"
            icon={GraduationCap}
            tone="blue"
            title={t('marketing.features.card.school.title')}
            description={t('marketing.features.card.school.description')}
            row={2}
          >
            <SchoolList t={t} />
          </FeatureCard>
          <FeatureCard
            id="health-medications"
            icon={HeartPulse}
            tone="pink"
            title={t('marketing.features.card.health.title')}
            description={t('marketing.features.card.health.description')}
            row={2}
          >
            <HealthList t={t} />
          </FeatureCard>
          <FeatureCard
            id="home-management"
            icon={HousePlus}
            tone="green"
            title={t('marketing.features.card.homeMgmt.title')}
            description={t('marketing.features.card.homeMgmt.description')}
            row={2}
          >
            <HomeList t={t} />
          </FeatureCard>
          <FeatureCard
            icon={Sparkles}
            tone="violet"
            title={t('marketing.features.card.assistant.title')}
            description={t('marketing.features.card.assistant.description')}
            row={2}
          >
            <AssistantChat t={t} />
          </FeatureCard>
        </section>

        <section className="dark mx-0 mt-[18px] grid h-auto min-h-[105px] items-center gap-5 rounded-[13px] border border-white/[0.09] bg-[radial-gradient(circle_at_55%_0%,rgba(82,63,232,.15),transparent_46%),linear-gradient(110deg,rgba(89,48,189,.13),rgba(8,17,28,.9))] px-7 py-5 text-white sm:mx-[14px] lg:flex lg:h-[109px] lg:py-3">
          <div className="flex items-center gap-5 lg:min-w-0 lg:flex-1">
            <Sparkles className="hidden h-10 w-10 shrink-0 text-violet-400 sm:block" strokeWidth={1.7} />
            <div>
              <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{t('marketing.features.banner.title')}</h2>
              <p className="mt-1 text-[13px] leading-5 text-white/68">{t('marketing.features.banner.bodyLead')}<br className="hidden xl:block" /> {t('marketing.features.banner.bodyRest')}</p>
            </div>
          </div>
          <PrimaryButton>{t('marketing.getStartedFree')}</PrimaryButton>
          <OutlineButton>{t('marketing.seeHowItWorks')}</OutlineButton>
        </section>

        <TrustStrip />
      </div>
    </ReferencePage>
  );
}

function MiniCalendar({ t }: { t: T }) {
  const days = ['28', '29', '30', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '1'];
  return (
    <div className="relative h-full text-[8px] text-white/65">
      <div className="flex items-center justify-between text-[10px] text-white/85"><span>{t('marketing.mock.may2024')}</span><span className="text-white/45">⌄　×</span></div>
      <div className="mt-3 grid grid-cols-7 gap-y-2 text-center text-[6px] text-white/55">{WEEKDAY_KEYS.map((key) => <span key={key}>{t(key)}</span>)}</div>
      <div className="mt-1.5 grid grid-cols-7 gap-y-2 text-center">
        {days.map((day, index) => <span key={`${day}-${index}`} className={cn(index < 3 && 'text-white/30', index === 11 && 'mx-auto grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-white')}>{day}</span>)}
      </div>
      <div className="absolute left-[43px] top-[66px] w-[112px] rounded-md border border-blue-400/30 bg-blue-600/25 px-2 py-1 text-[8px] leading-[10px] text-white">{t('marketing.mock.event.schoolDropOff')}<br /><span className="text-white/55">8:00 AM</span></div>
      <div className="absolute left-[43px] top-[95px] w-[112px] rounded-md border border-violet-400/30 bg-violet-600/25 px-2 py-1 text-[8px] leading-[10px] text-white">{t('marketing.mock.event.soccerPractice')}<br /><span className="text-white/55">4:00 PM</span></div>
      <div className="absolute left-[43px] top-[124px] w-[112px] rounded-md border border-fuchsia-400/30 bg-fuchsia-600/20 px-2 py-1 text-[8px] leading-[10px] text-white">{t('marketing.mock.event.pianoLesson')}<br /><span className="text-white/55">5:30 PM</span></div>
      <div className="absolute left-[43px] top-[153px] w-[112px] rounded-md border border-rose-400/30 bg-rose-600/20 px-2 py-1 text-[8px] leading-[10px] text-white">{t('marketing.mock.event.familyDinner')}<br /><span className="text-white/55">7:00 PM</span></div>
    </div>
  );
}

function TaskList({ t }: { t: T }) {
  // The first names are people, not copy: they stay as they are in every
  // language, the same way the product would show a real family's names.
  const rows = [
    [t('marketing.mock.chore.trash'), 'Liam'],
    [t('marketing.mock.chore.plants'), 'Emma'],
    [t('marketing.mock.chore.table'), 'Olivia'],
    [t('marketing.mock.chore.dishwasher'), 'Noah'],
  ];
  return (
    <div>
      <p className="mb-2.5 text-[10px] font-semibold">{t('marketing.mock.todaysChores')}</p>
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

function MealPlan({ t }: { t: T }) {
  const meals = [
    [t('marketing.mock.day.mon'), t('marketing.mock.meal.salmon'), t('marketing.mock.meal.salmonSide')],
    [t('marketing.mock.day.tue'), t('marketing.mock.meal.tacos'), t('marketing.mock.meal.tacosSide')],
    [t('marketing.mock.day.wed'), t('marketing.mock.meal.bolognese'), t('marketing.mock.meal.bologneseSide')],
    [t('marketing.mock.day.thu'), t('marketing.mock.meal.teriyaki'), t('marketing.mock.meal.teriyakiSide')],
  ];
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col">
      <p className="px-3 pt-3 text-[10px] font-semibold">{t('marketing.mock.thisWeeksPlan')}</p>
      <div className="flex-1 space-y-4 px-3 pt-3">
        {meals.map(([day, meal, side]) => <div key={day} className="grid grid-cols-[27px_1fr] text-[9px] leading-[12px]"><span className="text-white/55">{day}</span><span>{meal}<br /><span className="text-white/72">{side}</span></span></div>)}
      </div>
      <div className="border-t border-white/[0.07] px-3 py-2 text-center text-[9px] text-violet-300">{t('marketing.mock.viewFullPlan')}</div>
    </div>
  );
}

function GroceryList({ t }: { t: T }) {
  const items = [
    t('marketing.mock.grocery.milk'), t('marketing.mock.grocery.eggs'),
    t('marketing.mock.grocery.chicken'), t('marketing.mock.grocery.broccoli'),
    t('marketing.mock.grocery.avocados'), t('marketing.mock.grocery.bread'),
  ];
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3">
      <p className="mb-2.5 text-[10px] font-semibold">{t('marketing.mock.myGroceryList')}</p>
      <div className="flex-1 space-y-2.5">{items.map((item) => <p key={item} className="flex items-center gap-2 text-[9px]"><Circle className="h-[13px] w-[13px] text-white/55" />{item}</p>)}</div>
      <div className="rounded-lg border border-white/10 px-2 py-1.5 text-[9px] text-white/55"><Plus className="mr-1 inline h-3 w-3" /> {t('marketing.mock.addItem')}</div>
    </div>
  );
}

function SchoolList({ t }: { t: T }) {
  const items = [
    [t('marketing.mock.school.mathHomework'), t('marketing.mock.dueTomorrow')],
    [t('marketing.mock.school.scienceProject'), t('marketing.mock.dueMay10')],
    [t('marketing.mock.school.fieldTrip'), t('marketing.mock.may16')],
  ];
  return <ListPanel title={t('marketing.mock.upcoming')} footer={t('marketing.mock.viewAllAssignments')}>{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><span className={cn('grid h-6 w-6 place-items-center rounded-md', ['bg-pink-500/55', 'bg-indigo-500/55', 'bg-blue-500/55'][i])}><FileText className="h-3.5 w-3.5" /></span><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function HealthList({ t }: { t: T }) {
  const items = [
    [t('marketing.mock.health.allergyMed', { name: 'Liam' }), '8:00 AM'],
    [t('marketing.mock.health.vitaminD', { name: 'Olivia' }), '12:00 PM'],
    [t('marketing.mock.health.dentist'), '3:30 PM'],
  ];
  return <ListPanel title={t('marketing.mock.todaysReminders')} footer={t('marketing.mock.viewAll')}>{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><TinyAvatar index={i + 1} className="h-6 w-6" /><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function HomeList({ t }: { t: T }) {
  const items = [
    [t('marketing.mock.home.hvacFilter'), t('marketing.mock.may5')],
    [t('marketing.mock.home.garageDoor'), t('marketing.mock.may20')],
    [t('marketing.mock.home.waterHeater'), t('marketing.mock.june2')],
  ];
  return <ListPanel title={t('marketing.mock.upcoming')} footer={t('marketing.mock.viewAll')}>{items.map(([item, date], i) => <div key={item} className="flex items-center gap-2.5"><span className="grid h-6 w-6 place-items-center rounded-md bg-white/[0.045]">{i === 0 ? <Wrench className="h-3.5 w-3.5 text-white/60" /> : <HousePlus className="h-3.5 w-3.5 text-white/60" />}</span><div><p className="text-[9px]">{item}</p><p className="text-[7px] text-white/45">{date}</p></div></div>)}</ListPanel>;
}

function ListPanel({ title, footer, children }: { title: string; footer: string; children: React.ReactNode }) {
  return <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3"><p className="mb-3 text-[10px] font-semibold">{title}</p><div className="flex-1 space-y-3">{children}</div><div className="rounded-lg border border-white/[0.06] py-2 text-center text-[9px] text-violet-300">{footer}</div></div>;
}

function AssistantChat({ t }: { t: T }) {
  return (
    <div className="-m-3 flex h-[calc(100%+24px)] flex-col p-3 text-[8px] leading-[11px]">
      <div className="ml-auto rounded-lg bg-violet-600 px-2.5 py-2">{t('marketing.mock.chat.whatsHappening')}</div>
      <div className="mt-2 mr-3 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2">{t('marketing.mock.chat.eventsAnswerLead')}<br />{t('marketing.mock.chat.eventsAnswerRest')}</div>
      <div className="mt-2 ml-auto rounded-lg bg-violet-600 px-2.5 py-2">{t('marketing.mock.chat.planDinners')}</div>
      <div className="mt-2 mr-3 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2">{t('marketing.mock.chat.mealPlanAnswerLead')}<br />{t('marketing.mock.chat.mealPlanAnswerRest')}</div>
      <span className="mx-auto mt-auto h-8 w-8 shrink-0 rounded-full border border-blue-300 bg-[radial-gradient(circle,#fff_0,#48baf7_12%,#8a45e8_42%,#07101b_72%)] shadow-[0_0_15px_rgba(114,80,255,.75)]" />
    </div>
  );
}

async function TrustStrip() {
  const [t, { families }] = await Promise.all([getTranslations(), getPublicStats()]);
  const items = [
    [ShieldCheck, t('marketing.trust.private.title'), t('marketing.trust.private.body')],
    [Smartphone, t('marketing.trust.responsive.title'), t('marketing.trust.responsive.body')],
    [Cloud, t('marketing.trust.sync.title'), t('marketing.trust.sync.body')],
    [Heart, t('marketing.trust.community.title'), familiesNote(t, families)],
  ] as const;
  return (
    <section className="mx-0 mt-[18px] grid gap-6 border-t border-white/[0.06] px-7 py-6 sm:mx-[14px] sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([Icon, title, body]) => <div key={title} className="flex items-center gap-3.5"><Icon className="h-7 w-7 shrink-0 text-violet-400" strokeWidth={1.8} /><div><h3 className="text-[12px] font-semibold">{title}</h3><p className="mt-1 whitespace-pre-line text-[12px] leading-[17px] text-white/62">{body}</p></div></div>)}
    </section>
  );
}

const FLOW_CARDS = [
  [Mail, 'marketing.howItWorks.flow.email'],
  [Sparkles, 'marketing.howItWorks.flow.extract'],
  [CalendarDays, 'marketing.howItWorks.flow.sync'],
  [CheckCircle2, 'marketing.howItWorks.flow.ahead'],
] as const;

const WORK_STEPS = [
  [UsersRound, 'marketing.howItWorks.step.createFamily'],
  [Mail, 'marketing.howItWorks.step.forward'],
  [Sparkles, 'marketing.howItWorks.step.aiWorks'],
  [Users, 'marketing.howItWorks.step.sync'],
  [CheckCircle2, 'marketing.howItWorks.step.smoother'],
] as const;

export async function HowItWorksReferencePage() {
  const t = await getTranslations();

  return (
    <ReferencePage>
      <div className="mx-auto w-full max-w-[1024px] px-5 pb-3 pt-8 sm:px-[31px]">
        <section className="relative min-h-[463px] lg:h-[463px]">
          <div className="max-w-[414px] pt-[26px] lg:pl-[14px]">
            <Eyebrow>{t('marketing.tagline')}</Eyebrow>
            <h1 className="mt-3 text-[50px] font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-[58px]">
              {t('marketing.howItWorks.hero.titleLead')}
              <br />
              <GradientText>{t('marketing.howItWorks.hero.titleAccent')}</GradientText>
            </h1>
            {/* One sentence, three lines. The breaks are typography, not grammar, so
                the copy is one catalogue string and the wrapping is left to CSS —
                a translation whose clauses fall differently still reads. */}
            <p className="mt-[16px] max-w-[390px] text-[16px] leading-[26px] text-white/78">{t('marketing.howItWorks.hero.subtitle')}</p>
            <div className="mt-[20px] flex flex-wrap gap-[15px]">
              <PrimaryButton>{t('marketing.getStartedFree')} <ArrowRight className="h-4 w-4" /></PrimaryButton>
              <OutlineButton href="#steps">{t('marketing.howItWorks.seeItInAction')}</OutlineButton>
            </div>
            <SocialProof />
          </div>

          <div className="absolute left-[48.2%] top-0 hidden lg:block">
            <DetailedPhone t={t} />
          </div>

          <svg className="pointer-events-none absolute left-[64.5%] top-4 hidden h-[392px] w-[132px] overflow-visible lg:block" viewBox="0 0 132 392" fill="none" aria-hidden="true">
            <path d="M6 33 C55 31 62 8 118 8" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 143 C55 143 71 140 118 140" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 253 C57 253 72 253 118 253" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            <path d="M6 333 C52 333 55 374 118 374" stroke="#7c4dff" strokeOpacity=".68" strokeDasharray="2 3" />
            {[['118','8'],['118','140'],['118','253'],['118','374']].map(([x,y]) => <path key={y} d={`M${x} ${y}l-5-3m5 3-5 3`} stroke="#7c4dff" strokeOpacity=".8" />)}
          </svg>

          <div className="absolute right-[29px] top-[5px] hidden w-[196px] lg:flex lg:flex-col lg:gap-5">
            {FLOW_CARDS.map(([Icon, key], index) => (
              <article key={key} className={cn('flex gap-3 rounded-[14px] border border-white/[0.10] bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.025),0_16px_38px_rgba(0,0,0,.18)]', index === 1 ? 'min-h-[101px]' : 'min-h-[80px]')}>
                <Icon className="mt-0.5 h-6 w-6 shrink-0 text-violet-400" />
                <div><h2 className="text-[11px] font-semibold">{t(`${key}.title`)}</h2><p className="mt-1.5 whitespace-pre-line text-[10px] leading-[15px] text-white/62">{t(`${key}.body`)}</p></div>
              </article>
            ))}
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:hidden">
            <div className="mx-auto sm:col-span-2"><DetailedPhone t={t} /></div>
            {FLOW_CARDS.map(([Icon, key]) => <article key={key} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4"><Icon className="h-6 w-6 text-violet-400" /><div><h2 className="text-sm font-semibold">{t(`${key}.title`)}</h2><p className="mt-1 whitespace-pre-line text-xs leading-5 text-white/65">{t(`${key}.body`)}</p></div></article>)}
          </div>
        </section>

        <StepsPanel t={t} />
        <MagicPanel t={t} />
        <FamilyWorkflowPanel t={t} />
      </div>
    </ReferencePage>
  );
}

async function SocialProof() {
  const [t, { families }] = await Promise.all([getTranslations(), getPublicStats()]);
  return (
    <div className="mt-[19px] inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-white/70">
      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
      {familiesNote(t, families)}
    </div>
  );
}

function DetailedPhone({ t }: { t: T }) {
  return (
    <div className="dark relative h-[443px] w-[216px] rounded-[35px] border-[3px] border-[#595959] bg-[#030507] p-[8px] text-white shadow-[0_22px_70px_rgba(0,0,0,.52),inset_0_0_0_1px_#111]">
      <div className="absolute left-1/2 top-[7px] z-10 h-[21px] w-[84px] -translate-x-1/2 rounded-full bg-black" />
      <div className="h-full overflow-hidden rounded-[27px] bg-[#07101a] px-[10px] pb-[10px] pt-[14px]">
        <div className="flex items-center justify-between px-1 text-[8px] font-semibold"><span>9:41</span><span>⌁ ▴ ▰</span></div>
        <div className="mt-[22px] flex items-start justify-between px-1"><h3 className="text-[13px] font-semibold leading-4">{t('marketing.mock.goodMorning')}<br />{t('marketing.mock.johnsonFamily')} 👋</h3><Bell className="h-4 w-4" /></div>
        <PhonePanel title={t('marketing.mock.todaysSnapshot')} className="mt-3">
          {[[t('marketing.mock.snapshot.events', { count: 3 }),'orange'],[t('marketing.mock.snapshot.tasks', { count: 2 }),'amber'],[t('marketing.mock.snapshot.medications', { count: 1 }),'blue'],[t('marketing.mock.snapshot.noConflicts'),'green']].map(([item, color], i) => <div key={item} className="flex items-center gap-2 py-1 text-[7px]"><span className={cn('grid h-3.5 w-3.5 place-items-center rounded-full', color === 'orange' && 'bg-orange-500/20 text-orange-400', color === 'amber' && 'bg-amber-500/20 text-amber-400', color === 'blue' && 'bg-blue-500/20 text-blue-400', color === 'green' && 'bg-emerald-500/20 text-emerald-400')}>{i < 3 ? <CalendarDays className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />}</span>{item}</div>)}
        </PhonePanel>
        <PhonePanel title={t('marketing.mock.upcoming')} className="mt-2">
          {[[t('marketing.mock.event.soccerPractice'), `${t('marketing.mock.today')} · 5:00 PM`],[t('marketing.mock.event.mathTest'), `${t('marketing.mock.tomorrow')} · 9:00 AM`],[t('marketing.mock.event.familyDinner'), `${t('marketing.mock.tomorrow')} · 6:30 PM`]].map(([item, date], i) => <div key={item} className="flex items-center gap-2 py-1.5"><span className="grid h-4 w-4 place-items-center rounded-full bg-orange-500/25 text-[7px] text-orange-400">{i + 1}</span><div><p className="text-[7px]">{item}</p><p className="text-[6px] text-white/55">{date}</p></div></div>)}
        </PhonePanel>
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.06] px-1 pt-2 text-[6px] text-white/50"><Home className="h-3.5 w-3.5 text-violet-400" /><CalendarDays className="h-3.5 w-3.5" /><span className="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-lg text-white">+</span><CheckSquare2 className="h-3.5 w-3.5" /><span className="text-sm leading-none">•••</span></div>
      </div>
    </div>
  );
}

function PhonePanel({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-[9px] bg-white/[0.035] p-2.5', className)}><div className="mb-1 flex items-center justify-between"><p className="text-[8px] font-semibold">{title}</p><CalendarDays className="h-3 w-3 text-violet-400" /></div>{children}</div>;
}

function StepsPanel({ t }: { t: T }) {
  return (
    <section id="steps" className="dark rounded-[15px] border border-white/[0.08] bg-[#06101a]/[0.78] px-3 pb-3 pt-[5px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.02)]">
      <div className="text-center"><h2 className="text-[27px] font-bold tracking-[-0.025em]">{t('marketing.howItWorks.stepsTitle', { count: WORK_STEPS.length })}</h2><p className="mt-1 text-[12px] text-white/62">{t('marketing.howItWorks.stepsSubtitle')}</p></div>
      <div className="mt-[41px] grid gap-7 lg:grid-cols-5">
        {WORK_STEPS.map(([Icon, key], index) => (
          <article key={key} className="relative min-h-[175px] rounded-[13px] border border-white/[0.09] bg-white/[0.04] px-3 pb-3 pt-7 text-center shadow-[inset_0_1px_0_rgba(255,255,255,.025)]">
            <span className="absolute -top-[29px] left-1/2 grid h-[38px] w-[38px] -translate-x-1/2 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-700 text-[15px] font-semibold shadow-[0_8px_20px_rgba(90,48,220,.32)]">{index + 1}</span>
            {index < 4 && <><span className="absolute -top-[10px] left-[68%] hidden w-[82%] border-t border-dashed border-violet-500/65 lg:block" /><ArrowRight className="absolute -right-[35px] -top-[16px] hidden h-3 w-3 text-violet-400 lg:block" /></>}
            <Icon className="mx-auto h-[45px] w-[45px] text-violet-500" strokeWidth={1.8} />
            <h3 className="mt-3 text-[11px] font-semibold">{t(`${key}.title`)}</h3>
            <p className="mt-2 whitespace-pre-line text-[10px] leading-[16px] text-white/63">{t(`${key}.body`)}</p>
          </article>
        ))}
      </div>
      <div className="mt-[13px] border-t border-white/[0.06] pt-[13px]">
        <div className="flex min-h-[66px] flex-col gap-4 rounded-[12px] border border-white/[0.08] bg-white/[0.035] px-7 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4"><ShieldCheck className="h-9 w-9 text-violet-400" /><div><h3 className="text-[13px] font-semibold">{t('marketing.howItWorks.privacy.title')}</h3><p className="mt-1 text-[11px] text-white/60">{t('marketing.howItWorks.privacy.body')}</p></div></div>
          <Link href="/security" className="flex items-center gap-3 text-[11px] text-violet-400">{t('marketing.howItWorks.privacy.learnMore')} <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </div>
    </section>
  );
}

function MagicPanel({ t }: { t: T }) {
  const bullets = [
    t('marketing.magic.bullet.snap'), t('marketing.magic.bullet.extract'),
    t('marketing.magic.bullet.calendar'), t('marketing.magic.bullet.tasks'),
    t('marketing.magic.bullet.notify'), t('marketing.magic.bullet.saves'),
  ];
  return (
    <section className="dark mt-[14px] grid gap-6 rounded-[15px] border border-white/[0.08] bg-[#06101a]/[0.78] p-5 text-white lg:h-[334px] lg:grid-cols-[274px_1fr]">
      <div>
        <h2 className="whitespace-nowrap text-[27px] font-bold tracking-[-0.03em]">{t('marketing.magic.title')} <GradientText>{t('marketing.magic.titleAccent')}</GradientText><Sparkles className="ml-0.5 inline h-5 w-5 text-violet-400" /></h2>
        <p className="mt-2 text-[14px] leading-6 text-white/68">{t('marketing.magic.subtitle')}</p>
        <ul className="mt-4 space-y-2.5">{bullets.map((item) => <li key={item} className="flex items-center gap-2.5 text-[12px] text-white/73"><CheckCircle2 className="h-4 w-4 text-violet-400" />{item}</li>)}</ul>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-3 lg:grid-cols-[166px_28px_176px_28px_1fr]">
        <MagicCapture t={t} />
        <ArrowRight className="mt-[137px] hidden h-7 w-7 text-violet-500 lg:block" />
        <MagicDetails t={t} />
        <ArrowRight className="mt-[137px] hidden h-7 w-7 text-violet-500 lg:block" />
        <MagicCalendar t={t} />
      </div>
    </section>
  );
}

function MagicCapture({ t }: { t: T }) {
  return (
    <div><p className="mb-2 text-center text-[11px] font-semibold">{t('marketing.magic.step.capture')}</p><div className="relative h-[271px] overflow-hidden rounded-[11px] bg-[radial-gradient(circle_at_70%_25%,#dac6a6,transparent_24%),radial-gradient(circle_at_25%_35%,#747966,transparent_35%),linear-gradient(135deg,#a9a18a,#4b5147)]">
      <div className="absolute -bottom-16 -left-6 h-[205px] w-[92px] rotate-[18deg] rounded-[45%] bg-gradient-to-r from-[#bb7655] to-[#e3a77f] shadow-xl" />
      <div className="absolute left-[35px] top-[18px] h-[245px] w-[101px] rounded-[17px] border-[5px] border-[#16181a] bg-[#202327] shadow-[0_10px_25px_rgba(0,0,0,.38)]"><div className="mx-auto mt-1 h-1 w-8 rounded-full bg-black" /></div>
      <Flyer t={t} className="absolute left-[39px] top-[42px] h-[190px] w-[93px]" />
    </div></div>
  );
}

function Flyer({ t, className }: { t: T; className?: string }) {
  // The flyer is the *input* to the extraction story told beside it, so its
  // text has to be readable in the visitor's language for the demo to land.
  // Upper-casing is CSS, not baked into the catalogue: a language whose casing
  // rules differ (or whose diacritics are lost by naive upper-casing) keeps its
  // own form.
  return <div className={cn('bg-[#f0f0ec] p-2 text-[#17191d] shadow-lg', className)}><p className="text-[12px] font-black uppercase leading-[12px]">{t('marketing.magic.flyer.title')}</p><p className="mt-2 text-[10px] font-black uppercase">{t('marketing.magic.flyer.dates')}</p><p className="mt-1 border-y border-black py-1 text-[5px] font-bold uppercase">{t('marketing.magic.flyer.location')}</p><p className="mt-2 text-[5px] font-bold uppercase leading-[7px]">{t('marketing.magic.flyer.checkIn')}<br />{t('marketing.magic.flyer.gamesStart')}</p><div className="absolute bottom-2 right-1 grid h-10 w-10 place-items-center rounded-full border-[5px] border-[#15181b] text-[17px]">⚽</div></div>;
}

function MagicDetails({ t }: { t: T }) {
  const rows: [LucideIcon, string][] = [
    [CalendarDays, t('marketing.magic.detail.tournament')],
    [CalendarDays, t('marketing.magic.detail.dates')],
    [Bell, t('marketing.magic.detail.checkIn')],
    [Bell, t('marketing.magic.detail.gamesStart')],
    [MapPin, t('marketing.magic.detail.park')],
    [CheckSquare2, t('marketing.magic.detail.bring')],
  ];
  return <div><p className="mb-2 text-center text-[11px] font-semibold">{t('marketing.magic.step.understand')}</p><div className="h-[271px] rounded-[12px] border border-white/[0.10] bg-white/[0.035] p-4"><Sparkles className="h-6 w-6 text-violet-400" /><h3 className="mt-3 text-[10px] font-semibold">{t('marketing.magic.extractedDetails')}</h3><div className="mt-3 space-y-3">{rows.map(([Icon, text]) => <p key={text} className="flex gap-2 whitespace-pre-line text-[9px] leading-[12px] text-white/76"><Icon className="h-3 w-3 shrink-0 text-violet-400" />{text}</p>)}</div></div></div>;
}

function MagicCalendar({ t }: { t: T }) {
  const cells = [...WEEKDAY_KEYS.map((k) => t(k)), '12', '13', '14', '15', '16', '17', '18'];
  const tasks = [t('marketing.magic.task.gear'), t('marketing.magic.task.snacks'), t('marketing.magic.task.jersey')];
  return <div><p className="mb-2 whitespace-nowrap text-center text-[11px] font-semibold">{t('marketing.magic.step.organized')}</p><div className="h-[271px] rounded-[12px] border border-white/[0.10] bg-white/[0.035] p-3"><div className="flex justify-between text-[9px] font-semibold"><span>{t('marketing.mock.may2024')}</span><ChevronRight className="h-3 w-3" /></div><div className="mt-3 grid grid-cols-7 gap-y-1 text-center text-[5px] text-white/50">{cells.map((d,i) => <span key={`${d}-${i}`} className={cn(d === '18' && 'mx-auto grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-white')}>{d}</span>)}</div><div className="mt-3 rounded-lg bg-violet-600/25 p-3"><p className="text-[9px] font-semibold">{t('marketing.magic.detail.tournament')}</p><p className="mt-2 text-[7px] leading-[10px] text-white/58">{t('marketing.magic.detail.dateRange')}<br />8:30 AM – 12:00 PM<br />{t('marketing.magic.detail.park')}</p></div><div className="mt-3 border-t border-white/[0.07] pt-2"><p className="text-[8px] font-semibold">{t('marketing.magic.tasksCreated')}</p>{tasks.map(item => <p key={item} className="mt-1.5 flex items-center gap-1.5 text-[7px]"><CheckCircle2 className="h-2.5 w-2.5 text-violet-400" />{item}</p>)}<div className="mt-2 flex -space-x-1">{[0,1,2].map(i => <TinyAvatar key={i} index={i} className="h-5 w-5" />)}</div></div></div></div>;
}

function FamilyWorkflowPanel({ t }: { t: T }) {
  const workflows = ['morning', 'paperwork', 'dinner', 'aligned', 'weekends'].map((k) => [
    t(`marketing.workflow.${k}.title`),
    t(`marketing.workflow.${k}.body`),
  ]);
  return (
    <section className="dark relative mt-[21px] rounded-[15px] border border-white/[0.08] bg-[#06101a]/[0.78] px-12 pb-3 pt-[6px] text-white">
      <h2 className="text-center text-[23px] font-bold tracking-[-0.025em]">{t('marketing.workflow.title')} <GradientText>{t('marketing.workflow.titleAccent')}</GradientText></h2>
      <div className="mt-3 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-5">{workflows.map(([title,body]) => <article key={title} className="min-h-[142px] rounded-[10px] border border-white/[0.07] bg-white/[0.035] p-3"><CheckCircle2 className="h-4 w-4 text-emerald-400" /><h3 className="mt-3 text-[9px] font-semibold">{title}</h3><p className="mt-2 text-[8.5px] leading-[13px] text-white/70">{body}</p></article>)}</div>
    </section>
  );
}
