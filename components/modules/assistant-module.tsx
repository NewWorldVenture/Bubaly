'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CalendarDays, CheckCircle2, CloudSun, Gift, ListChecks, Mic,
  Plus, PlusCircle, School, Send, ShoppingCart, Sparkles, UtensilsCrossed,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils/cn';

const CHIPS = [
  [CalendarDays, "What's happening today?"],
  [UtensilsCrossed, 'Plan dinners for the week'],
  [Sparkles, 'Add soccer practice every Tuesday'],
  [ListChecks, 'Create chores for the kids'],
  [School, 'Summarize our week'],
  [PlusCircle, 'More suggestions'],
] as const;

const PROMPTS = [
  'What do we have going on this week?',
  'Create a grocery list from our meal plan',
  'Remind me to order camp forms',
  "What are my kids' activities today?",
];

const TRY_PROMPTS = PROMPTS;

type Message = { role: 'user' | 'assistant'; content: string; id: string };
type GlanceItem = { icon: React.ComponentType<{ className?: string }>; value: string; label: string };
type UpcomingEvent = { id: string; title: string; starts_at: string; all_day: boolean };
type ActivityItem = { icon: React.ComponentType<{ className?: string }>; text: string; time: string; color: string };

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function AssistantModule() {
  const { family, selfMember } = useApp();
  const firstName = (selfMember?.display_name || 'there').split(' ')[0];

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [convId] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('assistant-conv-id');
      if (stored) return stored;
      const id = generateId();
      sessionStorage.setItem('assistant-conv-id', id);
      return id;
    }
    return generateId();
  });

  // Sidebar data
  const [glance, setGlance] = useState<GlanceItem[]>([
    { icon: CalendarDays, value: '—', label: 'Events Today' },
    { icon: CheckCircle2, value: '—', label: 'Tasks Due' },
    { icon: Gift, value: '1', label: 'Medication Reminder' },
    { icon: CloudSun, value: '72°F', label: 'Partly Cloudy' },
  ]);
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Load sidebar data
  useEffect(() => {
    if (!family?.id) return;
    const supabase = createClient();
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const in14 = new Date(start); in14.setDate(in14.getDate() + 14);

    Promise.all([
      supabase.from('calendar_events').select('id, title, starts_at, all_day')
        .eq('family_id', family.id).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()),
      supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).in('status', ['todo', 'in_progress']),
      supabase.from('calendar_events').select('id, title, starts_at, all_day')
        .eq('family_id', family.id).gte('starts_at', end.toISOString()).lte('starts_at', in14.toISOString())
        .order('starts_at').limit(4),
    ]).then(([{ data: todayEvts }, { count: openChores }, { data: upEvts }]) => {
      setGlance([
        { icon: CalendarDays, value: String(todayEvts?.length ?? 0), label: 'Events Today' },
        { icon: CheckCircle2, value: String(openChores ?? 0), label: 'Tasks Due' },
        { icon: Gift, value: '1', label: 'Medication Reminder' },
        { icon: CloudSun, value: '72°F', label: 'Partly Cloudy' },
      ]);
      setUpcoming(upEvts ?? []);
      setActivity((todayEvts ?? []).slice(0, 3).map((e, i) => ({
        icon: CalendarDays,
        text: `${e.title} added to calendar`,
        time: ['9:16 AM', '9:15 AM', 'Yesterday'][i] ?? 'Recently',
        color: ['text-emerald-400', 'text-orange-400', 'text-violet-400'][i] ?? 'text-violet-400',
      })));
    });
  }, [family?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Show initial greeting message
  useEffect(() => {
    setMessages([{
      id: 'init',
      role: 'assistant',
      content: `Good morning, ${firstName}! Here's what's on the agenda for today. Ask me anything about your family's schedule, meals, chores, or anything else!`,
    }]);
  }, [firstName]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', content: msg, id: generateId() };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message: msg }),
      });
      const data = await res.json() as { reply?: string; error?: string };
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply ?? 'Sorry, I had trouble with that.', id: generateId() }]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.', id: generateId() }]);
    } finally {
      setLoading(false);
    }
  }

  const ACCENT_COLORS = ['bg-emerald-500', 'bg-indigo-500', 'bg-orange-500', 'bg-rose-500'];

  return (
    <div className="flex flex-col gap-7 lg:flex-row">
      {/* Main chat column */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-4">
          <div className="glow-dot h-14 w-14 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 shadow-glow" />
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-black">AI Assistant</h1>
            <span className="rounded-md bg-brand px-3 py-1 text-xs font-black text-brand-fg">BETA</span>
          </div>
        </div>

        <div className="mt-8">
          <h2 className="text-3xl font-black sm:text-5xl">Hi, {firstName}! 👋</h2>
          <p className="mt-2 bg-gradient-to-r from-violet-400 to-fuchsia-200 bg-clip-text text-2xl font-black text-transparent sm:text-4xl">
            How can I help your family today?
          </p>
          <p className="mt-4 text-base text-muted sm:text-lg">I can help you plan, organize, and stay ahead of everything.</p>
        </div>

        <div className="mt-7 flex gap-2.5 overflow-x-auto scrollbar-none sm:flex-wrap sm:overflow-x-visible">
          {CHIPS.map(([Icon, label]) => (
            <button
              key={label} onClick={() => void send(label === 'More suggestions' ? 'Give me more suggestions for things I can ask you.' : label)}
              className="inline-flex h-11 shrink-0 items-center gap-2.5 rounded-full border border-border bg-surface/40 px-4 text-sm text-fg transition hover:bg-elevated"
            >
              <Icon className="h-4 w-4 text-brand" />
              {label}
            </button>
          ))}
        </div>

        <div className="my-8 grid grid-cols-[1fr_auto_1fr] items-center gap-4 text-xs text-muted">
          <span className="h-px bg-border" /> Today <span className="h-px bg-border" />
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto pb-4">
          {messages.map((msg) =>
            msg.role === 'assistant' ? (
              <div key={msg.id} className="flex gap-4">
                <div className="mt-1 h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 shadow-glow" />
                <div className="max-w-[480px] rounded-2xl border border-border bg-surface/40 p-5 text-sm leading-6">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="ml-auto max-w-[520px] text-right">
                <div className="inline-block rounded-2xl bg-brand px-5 py-3.5 text-sm font-medium text-brand-fg">
                  {msg.content}
                </div>
              </div>
            )
          )}
          {loading && (
            <div className="flex gap-4">
              <div className="mt-1 h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-blue-600" />
              <div className="flex items-center gap-1.5 rounded-2xl border border-border bg-surface/40 px-5 py-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-2 w-2 animate-bounce rounded-full bg-brand" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="mt-4">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3">
            <Plus className="h-5 w-5 shrink-0 text-muted" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
              placeholder="Ask anything or give a command..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              disabled={loading}
            />
            <button onClick={() => void send()} disabled={loading || !input.trim()} className="grid h-10 w-10 place-items-center rounded-full bg-brand text-brand-fg disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-3 text-center text-xs text-muted/60">AI can make mistakes. Please double-check important information.</p>
        </div>
      </section>

      {/* Sidebar — hidden on mobile, horizontal scroll cards on md, vertical on lg */}
      <aside className="hidden lg:block lg:w-[330px] lg:shrink-0 lg:space-y-5">
        {/* At a Glance */}
        <SideCard title="At a Glance">
          {glance.map(({ icon: Icon, value, label }) => (
            <div key={label} className="flex items-center gap-4 py-2.5">
              <Icon className="h-6 w-6 shrink-0 text-fg" />
              <div>
                <p className="text-xl font-bold">{value}</p>
                <p className="text-xs text-muted">{label}</p>
              </div>
            </div>
          ))}
        </SideCard>

        {/* Upcoming */}
        <SideCard title="Upcoming" action={<a href="/dashboard/calendar" className="text-xs font-semibold text-brand">View Calendar</a>}>
          {upcoming.length > 0 ? upcoming.map((e, i) => {
            const d = new Date(e.starts_at);
            return (
              <div key={e.id} className="flex items-center gap-3 py-2.5">
                <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full text-white', ACCENT_COLORS[i % ACCENT_COLORS.length])}>
                  <CalendarDays className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold text-sm">{e.title}</p>
                  <p className="text-xs text-muted">
                    {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    {!e.all_day && ` · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}
                  </p>
                </div>
              </div>
            );
          }) : (
            <p className="py-4 text-sm text-muted/60 text-center">No upcoming events</p>
          )}
        </SideCard>

        {/* Smart Suggestions */}
        <SideCard title="Smart Suggestions">
          {[
            { icon: Sparkles, text: 'Emma has a science project due tomorrow. Want me to help create a study plan?' },
            { icon: ShoppingCart, text: 'You usually grocery shop on Sundays. Should I prepare the list?' },
            { icon: Gift, text: 'It looks like the HVAC filter needs to be changed soon.' },
          ].map(({ icon: Icon, text }) => (
            <button key={text} onClick={() => void send(text.split('?')[0] + '?')} className="flex gap-3 py-2.5 text-left hover:opacity-80 transition">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10">
                <Icon className="h-4 w-4 text-brand" />
              </span>
              <p className="text-xs leading-5 text-fg/80">{text}</p>
            </button>
          ))}
          <button className="mt-2 w-full rounded-full border border-brand/40 py-2.5 text-xs font-bold text-brand hover:border-brand">
            View All Suggestions
          </button>
        </SideCard>

        {/* Recent Activity */}
        <SideCard title="Recent Activity" action={<a href="/dashboard/calendar" className="text-xs font-semibold text-brand">View All</a>}>
          {activity.length > 0 ? activity.map((a) => (
            <div key={a.text} className="flex items-center gap-3 py-2 text-xs">
              <a.icon className={cn('h-4 w-4 shrink-0', a.color)} />
              <span className="flex-1 text-fg/80">{a.text}</span>
              <span className="shrink-0 text-muted/60">{a.time}</span>
            </div>
          )) : (
            <p className="py-3 text-xs text-muted/60 text-center">No recent activity</p>
          )}
        </SideCard>

        {/* Try saying */}
        <SideCard title="Try saying something like...">
          {TRY_PROMPTS.map((p) => (
            <button key={p} onClick={() => void send(p)}
              className="mt-2 block w-full rounded-full border border-border bg-surface/40 px-4 py-2.5 text-left text-xs text-fg/80 transition hover:bg-elevated">
              &quot;{p}&quot;
            </button>
          ))}
        </SideCard>
      </aside>
    </div>
  );
}

function SideCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
