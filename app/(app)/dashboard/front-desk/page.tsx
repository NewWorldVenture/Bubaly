import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Phone, Mail, MessageSquare, FileText, CalendarClock, Zap, BookHeart, Sun,
  ArrowRight, Sparkles, Check, CircleDot, ShoppingCart, ListChecks, Cake,
  CalendarX, Wallet, HeartPulse, Pill, UtensilsCrossed, FileClock, ShieldCheck,
} from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { DecisionQueue } from '@/components/front-desk/decision-queue';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

const HANDLED_ICON: Record<string, typeof CircleDot> = {
  document: FileClock, appointment: CalendarClock, chore: ListChecks,
  birthday: Cake, groceries: ShoppingCart, conflict: CalendarX,
  finance: Wallet, wellbeing: HeartPulse, medication: Pill, meal: UtensilsCrossed,
  insurance: ShieldCheck,
};

export const metadata: Metadata = { title: 'Family Front Desk' };
export const dynamic = 'force-dynamic';

type ChannelStatus = 'active' | 'setup';
type Channel = {
  icon: typeof Phone;
  title: string;
  desc: string;
  href: string;
  status: ChannelStatus;
  meta?: string;
  tone: string;
};

// The Family Front Desk — the lobby of the AI Operating System. It packages the
// concierge that already powers Bubaly (call screening, magic import, documents,
// scheduling, automation, memory, briefings) into one calm surface, and puts the
// only-what-needs-you decision queue front and center. Everything is real and
// Supabase-wired; nothing is a placeholder.
export default async function FrontDeskPage() {
  const ctx = await requireFeature('/dashboard/front-desk');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);

  const [{ count: docCount }, { count: eventCount }, { data: handled }] = await Promise.all([
    supabase.from('documents').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
    supabase.from('calendar_events').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('starts_at', now.toISOString()).lte('starts_at', weekEnd.toISOString()),
    supabase.from('autopilot_suggestions')
      .select('id, title, detail, kind, status, resolved_at')
      .eq('family_id', familyId).in('status', ['auto_executed', 'executed', 'approved'])
      .order('resolved_at', { ascending: false, nullsFirst: false }).limit(6),
  ]);

  const handledItems = (handled ?? []) as { id: string; title: string; detail: string | null; kind: string; status: string; resolved_at: string | null }[];

  const phoneReady: ChannelStatus = isTwilioConfigured() ? 'active' : 'setup';

  const channels: Channel[] = [
    {
      icon: Phone, title: 'AI Phone Concierge', tone: 'text-emerald-400',
      desc: 'Answers calls, screens scams, schedules, and escalates only when it’s really you they need.',
      href: '/guardian', status: phoneReady,
      meta: phoneReady === 'active' ? 'Live on your Guardian number' : 'Connect a phone number',
    },
    {
      icon: Mail, title: 'AI Email Concierge', tone: 'text-blue-400',
      desc: 'Reads forwarded email, extracts the actions, files documents, and updates your calendar and lists.',
      href: '/dashboard/inbox', status: 'active', meta: 'Forward anything to import',
    },
    {
      icon: MessageSquare, title: 'AI SMS Concierge', tone: 'text-violet-400',
      desc: 'Handles texts from schools, coaches, and providers with the same intelligence as your calls.',
      href: '/guardian', status: phoneReady,
      meta: phoneReady === 'active' ? 'Live on your Guardian number' : 'Connect a phone number',
    },
    {
      icon: FileText, title: 'AI Document Concierge', tone: 'text-amber-400',
      desc: 'Understands permission slips, medical forms, invoices, and registrations — and files them automatically.',
      href: '/dashboard/documents', status: 'active',
      meta: docCount && docCount > 0 ? `${docCount} on file` : 'Snap or upload to start',
    },
    {
      icon: CalendarClock, title: 'AI Scheduling Agent', tone: 'text-sky-400',
      desc: 'Finds a time everyone is free and books it — across each person’s calendar in one tap.',
      href: '/dashboard/calendar', status: 'active',
      meta: eventCount && eventCount > 0 ? `${eventCount} events this week` : 'Find a time',
    },
    {
      icon: Zap, title: 'AI Automation Engine', tone: 'text-orange-400',
      desc: 'Turns every inbound message into the right task, event, reminder, list item, or archived record.',
      href: '/dashboard/autopilot', status: 'active', meta: 'Always on',
    },
    {
      icon: BookHeart, title: 'AI Family Memory', tone: 'text-pink-400',
      desc: 'A searchable timeline of every interaction, document, event, and decision — so nothing is lost.',
      href: '/dashboard/family-memory', status: 'active', meta: 'Searchable timeline',
    },
    {
      icon: Sun, title: 'AI Personal Assistant', tone: 'text-yellow-400',
      desc: 'Delivers each person a personalized daily briefing instead of making them go digging.',
      href: '/dashboard/briefing', status: 'active', meta: 'Daily briefing',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand/12 via-surface/40 to-transparent p-6 sm:p-8">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
          <Sparkles className="h-3.5 w-3.5" /> The AI Operating System for Family Life
        </span>
        <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">Your Family Front Desk</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
          Every call answered, every email understood, every form processed, every appointment coordinated.
          Bubaly’s front desk handles the invisible work of family life — so you spend less time managing
          life and more time living it.
        </p>
      </div>

      {/* Executive Dashboard — only what needs a decision */}
      <DecisionQueue />

      {/* Recently handled — proof the concierge is working (AI Family Memory) */}
      {handledItems.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Sparkles className="h-5 w-5 text-emerald-400" /> Recently handled for you
            </h2>
            <Link href="/dashboard/family-memory" className="text-xs font-semibold text-brand hover:underline">
              Full timeline
            </Link>
          </div>
          <ul className="space-y-2">
            {handledItems.map((h) => {
              const Icon = HANDLED_ICON[h.kind] ?? CircleDot;
              const auto = h.status === 'auto_executed';
              return (
                <li key={h.id} className="flex items-center gap-3 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] px-4 py-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{h.title}</p>
                    {h.detail && <p className="truncate text-xs text-muted">{h.detail}</p>}
                  </div>
                  {auto && (
                    <span className="hidden shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400 sm:inline">
                      Auto
                    </span>
                  )}
                  {h.resolved_at && <span className="shrink-0 text-[11px] text-muted">{fmtRelative(h.resolved_at)}</span>}
                  <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Concierge channels */}
      <div>
        <h2 className="mb-1 text-lg font-bold">Your concierge</h2>
        <p className="mb-4 text-sm text-muted">Eight ways Bubaly works the inbound for your family.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => (
            <Link key={c.title} href={c.href}
              className="group flex flex-col rounded-2xl border border-border bg-surface/40 p-5 transition hover:border-brand/40 hover:bg-elevated">
              <div className="mb-3 flex items-center justify-between">
                <span className={cn('grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04]', c.tone)}>
                  <c.icon className="h-5 w-5" />
                </span>
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  c.status === 'active' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400')}>
                  {c.status === 'active' ? 'Active' : 'Set up'}
                </span>
              </div>
              <h3 className="text-sm font-bold">{c.title}</h3>
              <p className="mt-1 flex-1 text-xs leading-5 text-muted">{c.desc}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] font-medium text-fg/70">{c.meta}</span>
                <ArrowRight className="h-4 w-4 text-muted opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
