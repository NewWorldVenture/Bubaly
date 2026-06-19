import type { Metadata } from 'next';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Mail,
  Shield,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import {
  Container,
  GradientText,
  IconOrb,
  OutlineLink,
  PageWrap,
  PhoneMockup,
  Pill,
  PrimaryLink,
  Rating,
  WORK_STEPS,
} from '@/components/marketing/visual-mocks';

export const metadata: Metadata = {
  title: 'How It Works',
  description: 'How FamilyOS turns scattered family information into organized action.',
};

const FLOW_CARDS = [
  [Mail, 'School Email Arrives', 'FamilyOS scans and understands the details.'],
  [Sparkles, 'AI Extracts & Organizes', 'Events, deadlines, and action items are added to the right places.'],
  [CalendarDays, 'Everyone Stays In Sync', 'Your whole family is updated automatically.'],
  [CheckCircle2, 'You Stay Ahead', 'AI reminds, suggests, and helps you plan better.'],
] as const;

export default function HowItWorksPage() {
  return (
    <PageWrap>
      <Container className="pb-16 pt-14 lg:pb-20">
        <section className="grid items-center gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <Pill>Simple. Smart. Life-changing.</Pill>
            <h1 className="mt-8 text-6xl font-black leading-[1.08] sm:text-7xl">
              How FamilyOS <GradientText>Works</GradientText>
            </h1>
            <p className="mt-7 max-w-lg text-xl leading-9 text-white/76">
              FamilyOS is your family&apos;s AI-powered operating system. It brings everything together and helps you stay ahead of what matters most.
            </p>
            <div className="mt-9 flex flex-col gap-4 sm:flex-row">
              <PrimaryLink href="/signup">Get Started Free</PrimaryLink>
              <OutlineLink href="/ai">See It in Action</OutlineLink>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <div className="flex -space-x-2">
                {['SJ', 'DM', 'AL', 'PK'].map((item) => (
                  <span key={item} className="grid h-11 w-11 place-items-center rounded-full border-2 border-[#07101a] bg-gradient-to-br from-amber-200 to-rose-300 text-xs font-bold text-slate-900">
                    {item}
                  </span>
                ))}
              </div>
              <div>
                <Rating />
                <p className="mt-1 text-sm text-white/78">10,000+ families love FamilyOS</p>
              </div>
            </div>
          </div>

          <div className="grid items-center gap-7 lg:grid-cols-[1fr_290px]">
            <div className="relative mx-auto w-[270px]">
              <PhoneMockup />
            </div>
            <div className="space-y-7">
              {FLOW_CARDS.map(([Icon, title, body]) => (
                <div key={String(title)} className="showcase-card rounded-2xl p-6">
                  <div className="flex gap-4">
                    <IconOrb icon={Icon} className="h-12 w-12 rounded-xl" />
                    <div>
                      <h2 className="font-bold">{title}</h2>
                      <p className="mt-2 text-sm leading-6 text-white/65">{body}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="showcase-panel mt-10 p-6 lg:p-8">
          <div className="text-center">
            <h2 className="text-4xl font-black">It works in 5 simple steps</h2>
            <p className="mt-3 text-white/68">Powerful technology. Simple for families.</p>
          </div>
          <div className="mt-9 grid gap-5 lg:grid-cols-5">
            {WORK_STEPS.map(([Icon, title, body], index) => (
              <article key={title} className="relative showcase-card rounded-xl p-6 text-center">
                <span className="absolute -top-7 left-1/2 grid h-12 w-12 -translate-x-1/2 place-items-center rounded-full bg-violet-600 text-lg font-black shadow-glow">
                  {index + 1}
                </span>
                <IconOrb icon={Icon} className="mx-auto mt-6 h-16 w-16" />
                <h3 className="mt-5 font-bold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-white/65">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-4 rounded-xl border border-white/8 bg-white/[0.035] p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <IconOrb icon={Shield} className="h-12 w-12 rounded-xl" />
              <div>
                <h3 className="font-bold">Secure. Private. Built for Families.</h3>
                <p className="mt-1 text-sm text-white/65">Your data is always protected and only shared with your family.</p>
              </div>
            </div>
            <a href="/security" className="inline-flex items-center gap-2 text-sm font-bold text-violet-300">
              Learn more about security <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>

        <section className="showcase-panel mt-8 grid gap-8 p-7 lg:grid-cols-[0.85fr_1.25fr] lg:p-8">
          <div>
            <h2 className="text-4xl font-black leading-tight">
              The magic is in the <GradientText>AI</GradientText>
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-8 text-white/72">
              FamilyOS turns scattered information into organized action automatically.
            </p>
            <ul className="mt-7 space-y-3 text-white/82">
              {['Snap a photo of a school flyer', 'AI extracts events, dates & details', 'Automatically adds to your calendar', 'Creates tasks, reminders & lists', 'Notifies the right people', 'Saves you hours every week'].map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-violet-400" /> {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid items-start gap-6 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            <MagicCapture />
            <ArrowRight className="mt-32 hidden h-9 w-9 text-violet-400 md:block" />
            <MagicDetails />
            <ArrowRight className="mt-32 hidden h-9 w-9 text-violet-400 md:block" />
            <MagicCalendar />
          </div>
        </section>

        <section className="showcase-panel mt-8 p-7">
          <h2 className="text-center text-3xl font-black">
            <GradientText>Loved</GradientText> by families everywhere
          </h2>
          <div className="mt-7 grid gap-5 md:grid-cols-3 lg:grid-cols-5">
            {['FamilyOS has completely changed how we stay organized.', 'The AI saves me so much time.', 'Finally, an app that actually brings everything together.', 'Our whole family is on the same page now.', 'The school email scanner feature is pure genius.'].map((quote, index) => (
              <article key={quote} className="showcase-card rounded-xl p-5">
                <Rating />
                <p className="mt-4 min-h-[74px] text-sm leading-6 text-white/82">&quot;{quote}&quot;</p>
                <p className="mt-4 text-sm font-bold">{['Jessica M.', 'David T.', 'Amanda R.', 'Chris & Maria', 'Priya K.'][index]}</p>
                <p className="text-xs text-white/55">{['Mom of 3', 'Dad of 2', 'Mom of 4', 'Parents of 3', 'Mom of 2'][index]}</p>
              </article>
            ))}
          </div>
        </section>
      </Container>
    </PageWrap>
  );
}

function MagicCapture() {
  return (
    <div>
      <p className="mb-3 text-center text-sm font-bold">1. You capture it</p>
      <div className="mx-auto max-w-[230px] rounded-2xl bg-gradient-to-br from-stone-200 to-stone-500 p-6">
        <div className="rounded-xl border-4 border-slate-900 bg-white p-5 text-center text-slate-900 shadow-xl">
          <p className="text-2xl font-black leading-6">SPRING SOCCER TOURNAMENT</p>
          <p className="mt-4 text-xl font-black">MAY 18-19</p>
          <p className="mt-2 text-xs font-bold">LOCAL RIVER PARK</p>
          <div className="mx-auto mt-5 h-16 w-16 rounded-full border-[10px] border-slate-900" />
        </div>
      </div>
    </div>
  );
}

function MagicDetails() {
  return (
    <div>
      <p className="mb-3 text-center text-sm font-bold">2. AI understands it</p>
      <div className="showcase-card rounded-2xl p-6">
        <Sparkles className="h-8 w-8 text-violet-400" />
        <h3 className="mt-4 font-bold">AI Extracted Details</h3>
        <ul className="mt-4 space-y-3 text-sm text-white/76">
          {['Spring Soccer Tournament', 'May 18-19, 2024', 'Check in: 8:30 AM', 'Games start: 9:00 AM', 'Riverside Park', 'Bring gear and snacks'].map((item) => (
            <li key={item} className="flex gap-2">
              <CheckCircle2 className="h-4 w-4 text-violet-400" /> {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MagicCalendar() {
  return (
    <div>
      <p className="mb-3 text-center text-sm font-bold">3. It&apos;s organized for your family</p>
      <div className="showcase-card rounded-2xl p-5">
        <div className="flex items-center justify-between text-sm font-bold">
          <span>May 2024</span>
          <CalendarDays className="h-5 w-5 text-violet-400" />
        </div>
        <div className="mt-5 rounded-xl bg-violet-600/30 p-4">
          <p className="font-bold">Spring Soccer Tournament</p>
          <p className="mt-2 text-sm text-white/70">May 18 - May 19</p>
          <p className="text-sm text-white/70">8:30 AM - 12:00 PM</p>
          <p className="text-sm text-white/70">Riverside Park</p>
        </div>
        <div className="mt-5 space-y-2 text-sm">
          {['Pack soccer gear', 'Bring snacks', 'Team jersey'].map((item) => (
            <p key={item} className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-violet-400" /> {item}
            </p>
          ))}
        </div>
        <div className="mt-4 flex -space-x-2">
          <span className="h-7 w-7 rounded-full bg-amber-300" />
          <span className="h-7 w-7 rounded-full bg-cyan-300" />
          <span className="h-7 w-7 rounded-full bg-violet-400" />
        </div>
      </div>
    </div>
  );
}
