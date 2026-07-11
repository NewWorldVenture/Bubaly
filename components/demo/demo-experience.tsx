'use client';

// The demo experience, split across the app chrome during a demo session:
//   • `DemoEmailGate`  — expiresAt === null: the app is blurred behind an email
//     capture pop-up; submitting it starts the 5-minute clock.
//   • `DemoClockPill`  — the live countdown, mounted TOP-LEFT in the app header.
//     When it hits zero it swaps itself for the "upgrade" pop-up (Free 5-day
//     trial · Family Basic · Family+).
// The gate + upgrade pop-ups are portaled to <body> so they escape the header's
// stacking context and sit above every app modal/drawer.
import { useEffect, useState, useTransition } from 'react';
import { Clock, LogOut, Mail, Sparkles, Crown, Zap, Loader2, ArrowRight } from 'lucide-react';
import { createPortal, useFormStatus } from 'react-dom';
import { demoSecondsLeft, formatCountdown, DEMO_TTL_MINUTES } from '@/lib/demo/config';
import { endDemoAction, startDemoClockAction, choosePlanAfterDemoAction } from '@/app/(marketing)/demo/actions';

// ── Shared blur backdrop ─────────────────────────────────────────────────────
// Portaled to <body> so it escapes the header's stacking context and sits above
// every app modal / drawer (which reach z-[200]).
function BlurOverlay({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-xl" aria-hidden />
      <div className="relative w-full max-w-md rounded-3xl border border-border bg-surface p-7 shadow-2xl sm:p-8">
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── 1. Email capture ─────────────────────────────────────────────────────────
function GateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-brand text-sm font-bold text-white shadow-glow transition hover:opacity-90 disabled:opacity-70"
    >
      {pending
        ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting your demo…</>
        : <>Start my {DEMO_TTL_MINUTES}-minute demo <ArrowRight className="h-4 w-4" /></>}
    </button>
  );
}

/** The email-capture pop-up shown before the demo clock starts. */
export function DemoEmailGate() {
  return (
    <BlurOverlay>
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/15 ring-1 ring-emerald-400/30">
        <Mail className="h-6 w-6 text-emerald-400" />
      </div>
      <h2 className="mt-4 text-2xl font-black">You&apos;re in — one last thing</h2>
      <p className="mt-2 text-sm text-white/65">
        Drop your email and we&apos;ll unlock your live Family+ demo. You&apos;ll have{' '}
        {DEMO_TTL_MINUTES} minutes to add, edit and delete real data — everything resets when you leave.
      </p>

      <form action={startDemoClockAction} className="mt-5">
        <label htmlFor="demo-email" className="sr-only">Email address</label>
        <input
          id="demo-email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@email.com"
          className="h-12 w-full rounded-xl border border-border bg-bg px-4 text-sm text-fg outline-none ring-brand/50 placeholder:text-white/35 focus:ring-2"
        />
        <GateButton />
      </form>

      <p className="mt-3 text-center text-xs text-white/45">
        No spam, no card. Your {DEMO_TTL_MINUTES}-minute clock starts the moment you continue.
      </p>
    </BlurOverlay>
  );
}

// ── 2. Running countdown — the TOP-LEFT header pill ──────────────────────────
/**
 * The live demo countdown, mounted at the top-left of the app header. Ticks every
 * second; turns urgent (red, pulsing) in the final minute; and when the clock hits
 * zero it swaps itself for the upgrade pop-up. Renders inline (no fixed
 * positioning) so it sits naturally in the header's empty left slot.
 */
export function DemoClockPill({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState(() => demoSecondsLeft(expiresAt));
  const [pending, startTransition] = useTransition();
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLeft(demoSecondsLeft(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (left <= 0) return <DemoEnded />;

  const urgent = left <= 60;
  const exit = () => {
    if (exiting) return;
    setExiting(true);
    startTransition(() => { void endDemoAction(); });
  };

  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={`Demo mode — ${formatCountdown(left)} remaining`}
      className={
        'flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-1.5 text-xs font-semibold shadow-sm backdrop-blur-sm transition-colors sm:gap-2 sm:pr-2 ' +
        (urgent
          ? 'border-danger/40 bg-danger/12 text-danger'
          : 'border-brand/30 bg-brand/10 text-brand')
      }
    >
      {/* DEMO badge */}
      <span
        className={
          'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white ' +
          (urgent ? 'bg-danger' : 'bg-gradient-to-r from-brand to-violet-600')
        }
      >
        <Sparkles className="h-3 w-3" /> Demo
      </span>

      {/* Countdown */}
      <span className={'inline-flex items-center gap-1 ' + (urgent ? 'animate-pulse' : '')}>
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span className="tabular-nums">{formatCountdown(left)}</span>
        <span className="hidden text-fg/70 sm:inline">left</span>
      </span>

      {/* Exit */}
      <button
        type="button"
        onClick={exit}
        disabled={pending || exiting}
        aria-label="Exit demo"
        className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-fg/10 px-2 py-0.5 text-[11px] font-semibold text-fg/80 transition hover:bg-fg/20 disabled:opacity-60"
      >
        <LogOut className="h-3 w-3" /> <span className="hidden sm:inline">{exiting ? 'Exiting…' : 'Exit'}</span>
      </button>
    </div>
  );
}

// ── 3. Ended → upgrade pop-up ────────────────────────────────────────────────
// The three plans offered when the clock runs out.
const END_PLANS: { plan: string; title: string; blurb: string; icon: React.ReactNode; featured?: boolean }[] = [
  { plan: 'free', title: 'Free — 5-day trial', blurb: 'Everything, free for 5 days. No card required.', icon: <Zap className="h-5 w-5 text-emerald-400" /> },
  { plan: 'basic', title: 'Family Basic', blurb: 'The best family organizer on earth.', icon: <Crown className="h-5 w-5 text-yellow-400" />, featured: true },
  { plan: 'plus', title: 'Family+', blurb: 'Your family’s AI Chief of Staff.', icon: <Sparkles className="h-5 w-5 text-violet-400" /> },
];

function PlanRow({ plan, title, blurb, icon, featured }: (typeof END_PLANS)[number]) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="plan"
      value={plan}
      disabled={pending}
      className={
        'flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition disabled:opacity-60 ' +
        (featured
          ? 'border-violet-400/70 bg-violet-500/10 ring-1 ring-violet-400/30 hover:bg-violet-500/15'
          : 'border-border bg-bg hover:bg-white/[0.04]')
      }
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-fg">{title}</span>
        <span className="block text-xs text-white/60">{blurb}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-white/40" />
    </button>
  );
}

function DemoEnded() {
  return (
    <BlurOverlay>
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 ring-1 ring-brand/30">
        <Clock className="h-6 w-6 text-brand" />
      </div>
      <h2 className="mt-4 text-2xl font-black">Your {DEMO_TTL_MINUTES} minutes are up ⏱️</h2>
      <p className="mt-2 text-sm text-white/65">
        Hope you loved it. Make it your family&apos;s — pick a plan to keep going. Your demo data resets, but a real account starts fresh and stays.
      </p>

      <form action={choosePlanAfterDemoAction} className="mt-5 space-y-2.5">
        {END_PLANS.map((p) => <PlanRow key={p.plan} {...p} />)}
      </form>
    </BlurOverlay>
  );
}
