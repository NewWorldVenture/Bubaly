'use client';

import { useEffect, useState } from 'react';
import {
  Calendar, UtensilsCrossed, ShoppingCart, CheckSquare, Bell, PiggyBank,
  Check, CornerDownRight, type LucideIcon,
} from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';

// The centerpiece of the /ai page: a live-feeling "Ask → Act" demo. Each prompt,
// when active, shows the family member's message, Bubaly's reply, and — the whole
// point — the REAL records it creates, rendered as the same cards the app shows.
// Auto-advances; clicking a prompt selects it and pauses the rotation.

type Action = { icon: LucideIcon; title: string; meta: string; tone: 'brand' | 'accent' | 'green' };

type Demo = {
  icon: LucideIcon;
  prompt: string;
  reply: string;
  actions: Action[];
};

const DEMOS: Demo[] = [
  {
    icon: Calendar,
    prompt: 'Add soccer practice every Tuesday and Thursday at 5pm.',
    reply: 'Done — I added a repeating practice and a 30-minute leave-by reminder so you’re never late.',
    actions: [
      { icon: Calendar, title: 'Soccer practice', meta: 'Repeats Tue & Thu · 5:00–6:30 PM', tone: 'brand' },
      { icon: Bell, title: 'Leave-by reminder', meta: '4:30 PM · 12 min drive to the field', tone: 'accent' },
    ],
  },
  {
    icon: UtensilsCrossed,
    prompt: 'Plan dinners for this week — nothing too heavy.',
    reply: 'Here’s a light, balanced week. Want me to turn it into a grocery list?',
    actions: [
      { icon: UtensilsCrossed, title: '5 dinners planned', meta: 'Honey-garlic chicken · Taco bowls · Salmon · Pasta primavera · Sheet-pan veggies', tone: 'brand' },
    ],
  },
  {
    icon: ShoppingCart,
    prompt: 'Build a grocery list from our meal plan.',
    reply: 'Added 23 items, grouped by aisle, and merged the ones you already have in the pantry.',
    actions: [
      { icon: ShoppingCart, title: 'Grocery list · 23 items', meta: 'Produce 8 · Meat 4 · Dairy 3 · Pantry 8', tone: 'green' },
    ],
  },
  {
    icon: CheckSquare,
    prompt: 'Give the kids age-appropriate chores for the weekend.',
    reply: 'Assigned and split them fairly. Emma and Jack can check them off from their own logins.',
    actions: [
      { icon: CheckSquare, title: 'Make your bed → Emma', meta: 'Sat morning · 10 pts', tone: 'brand' },
      { icon: CheckSquare, title: 'Take out recycling → Jack', meta: 'Sun evening · 15 pts', tone: 'brand' },
    ],
  },
  {
    icon: Bell,
    prompt: 'Remind us to change the HVAC filter in 90 days.',
    reply: 'Set for you — and I’ll nudge the whole household, not just whoever asked.',
    actions: [
      { icon: Bell, title: 'Change HVAC filter', meta: 'Due in 90 days · notifies everyone', tone: 'accent' },
    ],
  },
  {
    icon: PiggyBank,
    prompt: 'How are we doing on the summer vacation fund?',
    reply: 'You’re 68% there and on pace for July if you keep the current weekly transfer.',
    actions: [
      { icon: PiggyBank, title: 'Vacation fund · $2,040 / $3,000', meta: 'On track for July · $60/wk', tone: 'green' },
    ],
  },
];

const TONE: Record<Action['tone'], string> = {
  brand: 'bg-brand/12 text-brand-text',
  accent: 'bg-[rgb(var(--accent)/0.14)] text-[rgb(var(--accent))]',
  green: 'bg-emerald-500/12 text-emerald-400',
};

export function AiActionDemo() {
  const tr = useTranslations();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setActive((i) => (i + 1) % DEMOS.length), 4200);
    return () => clearInterval(t);
  }, [paused]);

  const demo = DEMOS[active];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-stretch">
      {/* Prompt rail */}
      <div
        className="flex flex-col gap-2.5"
        onMouseEnter={() => setPaused(true)}
        onFocusCapture={() => setPaused(true)}
      >
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{tr('aiShowcase.tryAsking')}</p>
        {DEMOS.map((d, i) => {
          const on = i === active;
          return (
            <button
              key={d.prompt}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={on}
              className={[
                'group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm transition',
                on
                  ? 'border-brand/50 bg-brand/10 shadow-glow'
                  : 'border-border bg-surface/40 hover:border-brand/30 hover:bg-surface/70',
              ].join(' ')}
            >
              <span
                className={[
                  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
                  on ? 'bg-brand text-brand-fg' : 'bg-brand/10 text-brand-text',
                ].join(' ')}
              >
                <d.icon className="h-[18px] w-[18px]" />
              </span>
              <span className={on ? 'font-medium text-foreground' : 'text-muted group-hover:text-foreground'}>
                {d.prompt}
              </span>
            </button>
          );
        })}
      </div>

      {/* Chat + action panel */}
      <div
        className="ai-panel relative overflow-hidden rounded-3xl border border-brand/20 p-5 sm:p-6"
        onMouseEnter={() => setPaused(true)}
      >
        <div className="ai-hero-glow pointer-events-none absolute inset-0 opacity-70" aria-hidden />
        <div className="relative flex items-center gap-2.5 border-b border-white/10 pb-4">
          <span className="glow-dot h-8 w-8" />
          <div>
            <p className="text-sm font-semibold leading-tight">{tr('aiShowcase.bubalyAssistant')}</p>
            <p className="text-[11px] text-muted">{tr('aiShowcase.actingInsideYourFamilyPrivateBy')}</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> {tr('aiShowcase.live')}
          </span>
        </div>

        {/* keyed so each switch replays the enter animation */}
        <div key={active} className="assistant-message-enter relative mt-4 space-y-3">
          <div className="ml-auto w-fit max-w-[92%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.08] px-4 py-2.5 text-sm font-medium text-foreground shadow-lg backdrop-blur-xl">
            {demo.prompt}
          </div>

          <div className="flex items-end gap-2.5">
            <span className="glow-dot mb-1 h-7 w-7 shrink-0" />
            <div className="rounded-2xl rounded-bl-md border border-brand/15 bg-surface/80 px-4 py-2.5 text-sm leading-6 text-muted shadow-lg backdrop-blur-xl">
              {demo.reply}
            </div>
          </div>

          <div className="space-y-2 pl-9">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-brand-text">
              <CornerDownRight className="h-3.5 w-3.5" /> {tr('aiShowcase.createdForYou')}
            </p>
            {demo.actions.map((a) => (
              <div
                key={a.title}
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface/70 px-3.5 py-3 shadow-sm"
              >
                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TONE[a.tone]}`}>
                  <a.icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{a.title}</p>
                  <p className="truncate text-xs text-muted">{a.meta}</p>
                </div>
                <span className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <Check className="h-4 w-4" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
