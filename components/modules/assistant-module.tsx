'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarDays, CheckCircle2, Bell, Pill, ListChecks, Mic,
  Plus, PlusCircle, School, Send, ShoppingCart, Sparkles, UtensilsCrossed,
  MessageSquare, Trash2, Pencil, Square, Volume2, VolumeX, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { useVoice } from '@/lib/hooks/use-voice';
import { VOICE_MODES, cleanTranscript } from '@/lib/ai/voice';
import { Markdown } from '@/components/ui/markdown';

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

type ChatAction = { name: string; ok: boolean; summary: string };
type Message = { role: 'user' | 'assistant'; content: string; id: string; actions?: ChatAction[] };
type GlanceItem = { icon: React.ComponentType<{ className?: string }>; value: string; label: string };
type UpcomingEvent = { id: string; title: string; starts_at: string; all_day: boolean };
type ActivityItem = { icon: React.ComponentType<{ className?: string }>; text: string; time: string; color: string };

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function newConversationId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // RFC4122-ish fallback for older browsers.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8; return v.toString(16);
  });
}

export function AssistantModule() {
  const { family, selfMember } = useApp();
  const firstName = (selfMember?.display_name || 'there').split(' ')[0];

  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voice = useVoice({ onError: setVoiceError });
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);

  const greeting = () => {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return [{ id: 'init', role: 'assistant' as const, content: `${g}, ${firstName}! I can help you plan your week, schedule events, add chores, build your grocery list, set reminders, and more — just ask.` }];
  };

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [convId, setConvId] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('assistant-conv-id');
      if (stored && stored.includes('-')) return stored; // valid UUID
      const id = newConversationId();
      sessionStorage.setItem('assistant-conv-id', id);
      return id;
    }
    return newConversationId();
  });
  const [conversations, setConversations] = useState<{ id: string; title: string; updated_at: string }[]>([]);

  // Sidebar data
  const [glance, setGlance] = useState<GlanceItem[]>([
    { icon: CalendarDays, value: '—', label: 'Events Today' },
    { icon: CheckCircle2, value: '—', label: 'Tasks Due' },
    { icon: Bell, value: '—', label: 'Reminders Due' },
    { icon: Pill, value: '—', label: 'Active Meds' },
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
      supabase.from('calendar_events').select('id, title, starts_at, all_day, created_at')
        .eq('family_id', family.id).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()),
      supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).in('status', ['todo', 'in_progress']),
      supabase.from('calendar_events').select('id, title, starts_at, all_day')
        .eq('family_id', family.id).gte('starts_at', end.toISOString()).lte('starts_at', in14.toISOString())
        .order('starts_at').limit(4),
      supabase.from('reminders').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).eq('is_done', false).lte('remind_at', end.toISOString()),
      supabase.from('medications').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).eq('is_active', true),
    ]).then(([{ data: todayEvts }, { count: openChores }, { data: upEvts }, { count: remindersDue }, { count: activeMeds }]) => {
      setGlance([
        { icon: CalendarDays, value: String(todayEvts?.length ?? 0), label: 'Events Today' },
        { icon: CheckCircle2, value: String(openChores ?? 0), label: 'Tasks Due' },
        { icon: Bell, value: String(remindersDue ?? 0), label: 'Reminders Due' },
        { icon: Pill, value: String(activeMeds ?? 0), label: 'Active Meds' },
      ]);
      setUpcoming(upEvts ?? []);
      setActivity((todayEvts ?? []).slice(0, 3).map((e, i) => ({
        icon: CalendarDays,
        text: `${e.title} added to calendar`,
        time: fmtRelative(e.created_at),
        color: ['text-emerald-400', 'text-orange-400', 'text-violet-400'][i] ?? 'text-violet-400',
      })));
    });
  }, [family?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load the conversation list, and rehydrate the active conversation's messages.
  const loadConversations = useCallback(async () => {
    if (!family?.id) return;
    const supabase = createClient();
    const { data } = await supabase.from('ai_conversations')
      .select('id, title, updated_at').eq('family_id', family.id)
      .order('updated_at', { ascending: false }).limit(25);
    setConversations(data ?? []);
  }, [family?.id]);

  const loadConversation = useCallback(async (id: string) => {
    const supabase = createClient();
    const { data } = await supabase.from('ai_messages')
      .select('role, content, tool_results').eq('conversation_id', id)
      .order('created_at', { ascending: true }).limit(200);
    setConvId(id);
    if (typeof window !== 'undefined') sessionStorage.setItem('assistant-conv-id', id);
    if (!data || data.length === 0) { setMessages(greeting()); return; }
    setMessages(data.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      id: generateId(),
      actions: Array.isArray(m.tool_results)
        ? (m.tool_results as { ok?: boolean; summary?: string; error?: string }[]).map((r) => ({ name: '', ok: r?.ok !== false, summary: r?.summary ?? r?.error ?? 'Done' }))
        : undefined,
    } as Message)));
  }, [firstName]); // eslint-disable-line react-hooks/exhaustive-deps

  function newChat() {
    const id = newConversationId();
    setConvId(id);
    if (typeof window !== 'undefined') sessionStorage.setItem('assistant-conv-id', id);
    setMessages(greeting());
    setInput('');
  }

  async function deleteConversation(id: string) {
    if (!confirm('Delete this conversation?')) return;
    await createClient().from('ai_conversations').delete().eq('id', id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === convId) newChat();
  }

  async function renameConversation(id: string, current: string) {
    const title = window.prompt('Rename conversation', current || '')?.trim();
    if (!title || title === current) return;
    await createClient().from('ai_conversations').update({ title: title.slice(0, 80) }).eq('id', id);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }

  useEffect(() => { void loadConversations(); }, [loadConversations]);
  // On first mount, rehydrate the stored conversation (or greet for a new one).
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? sessionStorage.getItem('assistant-conv-id') : null;
    if (stored && stored.includes('-')) void loadConversation(stored);
    else setMessages(greeting());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || loading) return;
    setInput('');

    const userMsg: Message = { role: 'user', content: msg, id: generateId() };
    const replyId = generateId();
    // Add the user turn + an empty assistant bubble we fill as the stream arrives.
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', id: replyId, actions: [] }]);
    setLoading(true);

    const patchReply = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, message: msg }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: 'Sorry, I had trouble with that.' })) as { error?: string };
        patchReply((m) => ({ ...m, content: err.error ?? 'Sorry, I had trouble with that.' }));
        return;
      }
      // Parse the SSE stream: delta (text), action (chip), error, done.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalText = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev: { type: string; text?: string; name?: string; ok?: boolean; summary?: string; content?: string; error?: string };
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta' && ev.text) { finalText += ev.text; patchReply((m) => ({ ...m, content: m.content + ev.text })); }
          else if (ev.type === 'action') patchReply((m) => ({ ...m, actions: [...(m.actions ?? []), { name: ev.name ?? '', ok: ev.ok !== false, summary: ev.summary ?? 'Done' }] }));
          else if (ev.type === 'error') patchReply((m) => ({ ...m, content: m.content || (ev.error ?? 'Something went wrong.') }));
          else if (ev.type === 'done') { finalText = ev.content || finalText; patchReply((m) => ({ ...m, content: m.content || (ev.content ?? 'Done.') })); }
        }
      }
      // Speak the reply aloud when voice output is enabled on this device.
      if (finalText.trim() && voice.shouldSpeak()) void voice.speak(finalText);
    } catch {
      patchReply((m) => ({ ...m, content: m.content || 'Something went wrong. Please try again.' }));
    } finally {
      setLoading(false);
      void loadConversations(); // titles/order update after the turn persists
    }
  }

  // Mic flow: record → transcribe → drop into the input (auto-send if we got text).
  async function onMicPress() {
    setVoiceError(null);
    if (voice.status === 'recording') { voice.stopRecording(); return; }
    const text = await voice.startRecording();
    if (text) {
      const cleaned = cleanTranscript(text);
      if (cleaned) void send(cleaned);
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
          <div className="ml-auto flex items-center gap-2">
            {/* Voice output mode */}
            <div className="relative">
              <button
                onClick={() => setShowVoiceMenu((s) => !s)}
                aria-label="Voice settings"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition',
                  voice.mode === 'text'
                    ? 'border-border bg-surface/40 text-fg hover:bg-elevated'
                    : 'border-brand/40 bg-brand/10 text-brand',
                )}
              >
                {voice.mode === 'text' ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                <span className="hidden sm:inline">Voice</span>
              </button>
              {showVoiceMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowVoiceMenu(false)} />
                  <div className="absolute right-0 z-20 mt-2 w-60 rounded-2xl border border-border bg-surface p-2 shadow-xl">
                    <p className="px-2 py-1.5 text-xs font-semibold text-muted">Assistant voice (this device)</p>
                    {VOICE_MODES.map((m) => (
                      <button
                        key={m.value}
                        onClick={() => { voice.setMode(m.value); setShowVoiceMenu(false); if (m.value === 'text') voice.stopSpeaking(); }}
                        className={cn(
                          'flex w-full flex-col items-start rounded-lg px-2 py-2 text-left transition',
                          voice.mode === m.value ? 'bg-brand/10' : 'hover:bg-elevated',
                        )}
                      >
                        <span className={cn('text-sm font-medium', voice.mode === m.value ? 'text-brand' : 'text-fg')}>{m.label}</span>
                        <span className="text-xs text-muted">{m.hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={newChat} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-3 py-1.5 text-sm font-semibold text-fg transition hover:bg-elevated">
              <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New chat</span>
            </button>
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
                <div className="max-w-[480px] space-y-2">
                  <div className="rounded-2xl border border-border bg-surface/40 p-5 text-sm leading-6">
                    {msg.content
                      ? <Markdown content={msg.content} />
                      : (msg.actions && msg.actions.length > 0)
                        ? <span className="text-muted">Working on it…</span>
                        : (
                          <span className="inline-flex items-center gap-1.5">
                            {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-brand" style={{ animationDelay: `${i * 0.15}s` }} />)}
                          </span>
                        )}
                  </div>
                  {msg.actions && msg.actions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {msg.actions.map((a, i) => (
                        <span key={i} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', a.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300')}>
                          <CheckCircle2 className="h-3 w-3" /> {a.summary}
                        </span>
                      ))}
                    </div>
                  )}
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
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="mt-4 pb-[env(safe-area-inset-bottom)]">
          {voiceError && (
            <div className="mb-2 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>{voiceError}</span>
              <button onClick={() => setVoiceError(null)} aria-label="Dismiss" className="ml-2 text-amber-300/70 hover:text-amber-200">✕</button>
            </div>
          )}
          {voice.status === 'speaking' && (
            <button
              onClick={voice.stopSpeaking}
              className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand"
            >
              <Square className="h-3 w-3" /> Stop speaking
            </button>
          )}

          {voice.status === 'recording' ? (
            // Recording state: pulsing indicator + stop / cancel.
            <div className="flex items-center gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
              </span>
              <span className="flex-1 text-sm font-medium text-rose-200">Listening… tap the mic to send</span>
              <button onClick={voice.cancelRecording} className="rounded-full px-3 py-1.5 text-xs font-semibold text-rose-200/80 hover:text-rose-100">
                Cancel
              </button>
              <button onClick={onMicPress} aria-label="Stop and send" className="grid h-10 w-10 place-items-center rounded-full bg-rose-500 text-white">
                <Square className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface/40 px-3 py-3 sm:gap-3 sm:px-4">
              <input
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
                placeholder={voice.status === 'transcribing' ? 'Transcribing…' : 'Ask anything or give a command…'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                disabled={loading || voice.status === 'transcribing'}
              />
              {voice.supported && (
                <button
                  onClick={() => void onMicPress()}
                  disabled={loading || voice.status === 'transcribing'}
                  aria-label="Record voice message"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-40"
                >
                  {voice.status === 'transcribing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <button onClick={() => void send()} disabled={loading || !input.trim()} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-brand-fg disabled:opacity-40">
                <Send className="h-4 w-4" />
              </button>
            </div>
          )}
          <p className="mt-3 text-center text-xs text-muted/60">AI can make mistakes. Please double-check important information.</p>
        </div>
      </section>

      {/* Sidebar — hidden on mobile, horizontal scroll cards on md, vertical on lg */}
      <aside className="hidden lg:block lg:w-[330px] lg:shrink-0 lg:space-y-5">
        {/* Conversations */}
        <SideCard
          title="Conversations"
          action={<button onClick={newChat} className="inline-flex items-center gap-1 text-xs font-semibold text-brand"><Plus className="h-3.5 w-3.5" /> New</button>}
        >
          {conversations.length === 0 ? (
            <p className="py-3 text-xs text-muted/60 text-center">No saved chats yet.</p>
          ) : (
            <div className="space-y-0.5">
              {conversations.map((c) => (
                <div key={c.id} className={cn('group flex items-center gap-2 rounded-lg px-2 py-2', c.id === convId ? 'bg-brand/10' : 'hover:bg-elevated')}>
                  <button onClick={() => void loadConversation(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <MessageSquare className={cn('h-4 w-4 shrink-0', c.id === convId ? 'text-brand' : 'text-muted')} />
                    <span className="truncate text-xs text-fg/80">{c.title || 'New conversation'}</span>
                  </button>
                  <button onClick={() => void renameConversation(c.id, c.title)} aria-label="Rename conversation" className="shrink-0 p-1 text-muted/50 opacity-0 transition hover:text-fg group-hover:opacity-100">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => void deleteConversation(c.id)} aria-label="Delete conversation" className="shrink-0 p-1 text-muted/50 opacity-0 transition hover:text-rose-400 group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SideCard>

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
                <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg', ACCENT_COLORS[i % ACCENT_COLORS.length])}>
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

        {/* Try asking */}
        <SideCard title="Try Asking">
          {[
            { icon: CalendarDays, text: "What's on our schedule today?" },
            { icon: UtensilsCrossed, text: 'Plan dinners for this week' },
            { icon: ShoppingCart, text: 'Build a grocery list from our meal plan' },
            { icon: ListChecks, text: 'What chores are due this week?' },
          ].map(({ icon: Icon, text }) => (
            <button key={text} onClick={() => void send(text)} className="flex gap-3 py-2.5 text-left hover:opacity-80 transition">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10">
                <Icon className="h-4 w-4 text-brand" />
              </span>
              <p className="text-xs leading-5 text-fg/80">{text}</p>
            </button>
          ))}
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
