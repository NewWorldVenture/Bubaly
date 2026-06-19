import {
  CalendarDays,
  CheckCircle2,
  CloudSun,
  Gift,
  ListChecks,
  PlusCircle,
  School,
  ShoppingCart,
  Sparkles,
  UtensilsCrossed,
} from 'lucide-react';
import { AssistantInputBar } from '@/components/app/app-shell';
import { cn } from '@/lib/utils/cn';

const chips = [
  [CalendarDays, "What's happening today?"],
  [UtensilsCrossed, 'Plan dinners for the week'],
  [Sparkles, 'Add soccer practice every Tuesday'],
  [ListChecks, 'Create chores for the kids'],
  [School, 'Summarize our week'],
  [PlusCircle, 'More suggestions'],
] as const;

const schedule = [
  ['8:00 AM', 'School Drop-off'],
  ['10:00 AM', 'Math Meeting'],
  ['4:30 PM', 'Soccer Practice'],
] as const;

export function AssistantModule() {
  return (
    <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_330px]">
      <section className="min-w-0">
        <div className="flex items-center gap-4">
          <span className="glow-dot h-14 w-14" />
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-black">AI Assistant</h1>
            <span className="rounded-md bg-violet-700 px-3 py-1 text-xs font-black">BETA</span>
          </div>
        </div>

        <div className="mt-10">
          <h2 className="text-5xl font-black leading-tight">Hi, Sarah!</h2>
          <p className="mt-2 bg-gradient-to-r from-violet-400 to-fuchsia-200 bg-clip-text text-4xl font-black text-transparent">
            How can I help your family today?
          </p>
          <p className="mt-5 text-lg text-white/70">I can help you plan, organize, and stay ahead of everything.</p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          {chips.map(([Icon, label]) => (
            <button key={label} className="inline-flex h-12 items-center gap-3 rounded-full border border-white/10 bg-white/[0.035] px-5 text-sm text-white/88 hover:bg-white/[0.07]">
              <Icon className="h-5 w-5 text-violet-400" />
              {label}
            </button>
          ))}
        </div>

        <div className="my-10 grid grid-cols-[1fr_auto_1fr] items-center gap-5 text-sm text-white/50">
          <span className="h-px bg-white/12" />
          Today
          <span className="h-px bg-white/12" />
        </div>

        <div className="space-y-8">
          <AssistantMessage>
            <p className="font-semibold">Good morning, Sarah. Here's what's on the agenda for today.</p>
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.035] p-5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-bold text-violet-300">3 events today</span>
                <a className="text-violet-300" href="/dashboard/calendar">View schedule</a>
              </div>
              <div className="mt-4 space-y-3">
                {schedule.map(([time, title]) => (
                  <div key={title} className="grid grid-cols-[90px_1fr] text-sm">
                    <span>{time}</span>
                    <span>{title}</span>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between text-sm">
                <span className="font-bold text-emerald-300">2 tasks due</span>
                <a className="text-violet-300" href="/dashboard/chores">View tasks</a>
              </div>
              <p className="mt-3 text-sm text-white/70">Science Project - Due Tomorrow</p>
              <p className="mt-2 text-sm text-white/70">Take out the trash - Due Today</p>
              <div className="mt-5 flex items-center justify-between text-sm">
                <span className="font-bold text-orange-300">1 medication reminder</span>
                <a className="text-violet-300" href="/dashboard/health">View</a>
              </div>
            </div>
          </AssistantMessage>

          <UserBubble text="Plan dinners for the week that my kids will actually eat." time="9:15 AM" />

          <AssistantMessage>
            <p className="font-semibold">Sure. Here's a kid-friendly dinner plan for this week based on your family's favorites.</p>
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.035] p-5">
              <h3 className="font-bold">This Week's Dinner Plan</h3>
              <div className="mt-4 space-y-3 text-sm">
                {[
                  ['Mon', 'Chicken Tacos with Rice'],
                  ['Tue', 'Spaghetti with Meatballs'],
                  ['Wed', 'Homemade Pizza'],
                  ['Thu', 'Cheesy Burgers & Fries'],
                  ['Fri', 'Fish Tacos with Slaw'],
                  ['Sat', 'BBQ Chicken & Veggies'],
                  ['Sun', 'Sunday Soup & Grilled Cheese'],
                ].map(([day, meal]) => (
                  <div key={day} className="grid grid-cols-[48px_1fr]">
                    <span className="text-white/65">{day}</span>
                    <span>{meal}</span>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <button className="rounded-full border border-violet-400/40 px-4 py-2 text-sm font-bold text-violet-300">Add to Meal Plan</button>
                <button className="rounded-full border border-violet-400/40 px-4 py-2 text-sm font-bold text-violet-300">Regenerate</button>
              </div>
            </div>
          </AssistantMessage>

          <UserBubble text="Add soccer practice every Tuesday at 6pm." time="9:16 AM" />

          <AssistantMessage>
            <p className="font-semibold text-white/88">All set. I've added Soccer Practice every Tuesday at 6:00 PM to the calendar.</p>
            <button className="mt-5 rounded-full border border-violet-400/45 px-5 py-2.5 text-sm font-bold text-violet-300">Open Calendar</button>
          </AssistantMessage>

          <AssistantInputBar />
          <p className="text-center text-xs text-white/45">AI can make mistakes. Please double-check important information.</p>
        </div>
      </section>

      <aside className="space-y-6">
        <SideCard title="At a Glance">
          {[
            [CalendarDays, '5', 'Events Today'],
            [CheckCircle2, '3', 'Tasks Due'],
            [Sparkles, '1', 'Medication Reminder'],
            [CloudSun, '72F', 'Partly Cloudy'],
          ].map(([Icon, value, label]) => (
            <div key={String(label)} className="flex items-center gap-4 py-2">
              <Icon className="h-7 w-7 text-white/85" />
              <div>
                <p className="text-xl font-bold">{value}</p>
                <p className="text-sm text-white/62">{label}</p>
              </div>
            </div>
          ))}
        </SideCard>

        <SideCard title="Upcoming" action="View Calendar">
          {[
            ['Soccer Practice', 'Tomorrow - 6:00 PM', 'bg-emerald-500'],
            ['Piano Lesson', 'Wed, May 22 - 4:00 PM', 'bg-indigo-500'],
            ['Field Trip', 'Fri, May 24 - All Day', 'bg-orange-500'],
            ["Mom's Birthday", 'Sun, May 26 - All Day', 'bg-rose-500'],
          ].map(([title, meta, color]) => (
            <div key={title} className="flex items-center gap-4 py-2">
              <span className={cn('grid h-10 w-10 place-items-center rounded-full', color)}>
                <CalendarDays className="h-5 w-5" />
              </span>
              <div>
                <p className="font-bold">{title}</p>
                <p className="text-sm text-white/62">{meta}</p>
              </div>
            </div>
          ))}
        </SideCard>

        <SideCard title="Smart Suggestions">
          {[
            ['Emma has a science project due tomorrow. Want me to help create a study plan?', Sparkles],
            ['You usually grocery shop on Sundays. Should I prepare the list?', ShoppingCart],
            ['It looks like the HVAC filter needs to be changed soon.', HomeIcon],
          ].map(([text, Icon]) => (
            <div key={String(text)} className="flex gap-4 py-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-500/12">
                <Icon className="h-5 w-5 text-violet-300" />
              </span>
              <p className="text-sm leading-6 text-white/74">{text}</p>
            </div>
          ))}
          <button className="mt-3 w-full rounded-full border border-violet-500/45 py-3 text-sm font-bold text-violet-300">View All Suggestions</button>
        </SideCard>

        <SideCard title="Recent Activity" action="View All">
          {['Soccer Practice added to calendar', 'Dinner plan created', 'Grocery list updated', 'Math Meeting added', 'New document uploaded'].map((item, index) => (
            <div key={item} className="flex items-center gap-4 py-2 text-sm">
              <CheckCircle2 className={cn('h-5 w-5', ['text-emerald-400', 'text-orange-400', 'text-emerald-400', 'text-violet-400', 'text-blue-400'][index])} />
              <span className="flex-1">{item}</span>
              <span className="text-xs text-white/45">{index < 2 ? `9:${16 - index} AM` : index === 2 ? 'Yesterday' : 'May 18'}</span>
            </div>
          ))}
        </SideCard>

        <SideCard title="Try saying something like...">
          {['What do we have going on this week?', 'Create a grocery list from our meal plan', 'Remind me to order camp forms', "What are my kids' activities today?"].map((prompt) => (
            <button key={prompt} className="mt-2 block w-full rounded-full border border-white/10 bg-white/[0.035] px-4 py-2.5 text-left text-xs text-white/82">
              "{prompt}"
            </button>
          ))}
        </SideCard>
      </aside>
    </div>
  );
}

function AssistantMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-5">
      <span className="glow-dot mt-1 h-10 w-10 shrink-0" />
      <div className="showcase-card max-w-[470px] rounded-xl p-5">{children}</div>
    </div>
  );
}

function UserBubble({ text, time }: { text: string; time: string }) {
  return (
    <div className="ml-auto max-w-[520px] text-right">
      <div className="inline-flex rounded-xl bg-violet-700 px-6 py-4 text-base font-medium">{text}</div>
      <p className="mt-2 text-xs text-white/45">You - {time}</p>
    </div>
  );
}

function SideCard({ title, action, children }: { title: string; action?: string; children: React.ReactNode }) {
  return (
    <section className="showcase-card rounded-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">{title}</h2>
        {action && <a className="text-sm font-semibold text-violet-300">{action}</a>}
      </div>
      {children}
    </section>
  );
}

function HomeIcon({ className }: { className?: string }) {
  return <Gift className={className} />;
}
