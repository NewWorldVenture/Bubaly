'use client';

import { useEffect, useState } from 'react';
import {
  Calendar, UtensilsCrossed, ShoppingCart, CheckSquare, Bell, PiggyBank,
  Check, CornerDownRight, type LucideIcon,
} from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { SampleBadge } from '@/components/marketing/primitives';

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
    prompt: 'aiShowcase.addSoccerPracticeEveryTuesday',
    reply: 'aiShowcase.doneIAddedARepeating',
    actions: [
      { icon: Calendar, title: 'aiShowcase.soccerPractice', meta: 'aiShowcase.repeatsTueThu500', tone: 'brand' },
      { icon: Bell, title: 'aiShowcase.leaveByReminder', meta: 'aiShowcase.leaveBy430Pm12MinDrive', tone: 'accent' },
    ],
  },
  {
    icon: UtensilsCrossed,
    prompt: 'aiShowcase.planDinnersForThisWeek',
    reply: 'aiShowcase.hereSALightBalanced',
    actions: [
      { icon: UtensilsCrossed, title: 'aiShowcase.fiveDinnersPlanned', meta: 'aiShowcase.honeyGarlicChickenTacoBowls', tone: 'brand' },
    ],
  },
  {
    icon: ShoppingCart,
    prompt: 'aiShowcase.buildAGroceryListFrom',
    reply: 'aiShowcase.added23ItemsGroupedBy',
    actions: [
      { icon: ShoppingCart, title: 'aiShowcase.groceryList23Items', meta: 'aiShowcase.produce8Meat4Dairy', tone: 'green' },
    ],
  },
  {
    icon: CheckSquare,
    prompt: 'aiShowcase.giveTheKidsAgeAppropriate',
    reply: 'aiShowcase.assignedAndSplitThemFairly',
    actions: [
      { icon: CheckSquare, title: 'aiShowcase.makeYourBedEmma', meta: 'aiShowcase.satMorning10Pts', tone: 'brand' },
      { icon: CheckSquare, title: 'aiShowcase.takeOutRecyclingJack', meta: 'aiShowcase.sunEvening15Pts', tone: 'brand' },
    ],
  },
  {
    icon: Bell,
    prompt: 'aiShowcase.remindUsToChangeThe',
    reply: 'aiShowcase.setForYouAndI',
    actions: [
      { icon: Bell, title: 'aiShowcase.changeHvacFilter', meta: 'aiShowcase.dueIn90DaysNotifies', tone: 'accent' },
    ],
  },
  {
    icon: PiggyBank,
    prompt: 'aiShowcase.howAreWeDoingOn',
    reply: 'aiShowcase.youRe68ThereAnd',
    actions: [
      { icon: PiggyBank, title: 'aiShowcase.vacationFund20403', meta: 'aiShowcase.onTrackForJuly60', tone: 'green' },
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
        {/* Badged: the prompts and the records they produce are a scripted
            sample, not a live run. Same badge as the homepage ledger. */}
        <div className="mb-1 flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{tr('aiShowcase.tryAsking')}</p>
          <SampleBadge>{tr('handledProof.sampleBadge')}</SampleBadge>
        </div>
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
                {tr(d.prompt)}
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
            {tr(demo.prompt)}
          </div>

          <div className="flex items-end gap-2.5">
            <span className="glow-dot mb-1 h-7 w-7 shrink-0" />
            <div className="rounded-2xl rounded-bl-md border border-brand/15 bg-surface/80 px-4 py-2.5 text-sm leading-6 text-muted shadow-lg backdrop-blur-xl">
              {tr(demo.reply)}
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
                  <p className="truncate text-sm font-semibold">{tr(a.title)}</p>
                  <p className="truncate text-xs text-muted">{tr(a.meta)}</p>
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
