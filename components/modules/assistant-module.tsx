'use client';

// The Family AI page: a conversation with Bubaly whose outcomes are cards, not
// chat bubbles (§53), laid out as a workspace (§54) — conversation on the
// left, plan and results in the centre, household context on the right; on a
// phone, Chat | Plan | Context.
//
// Transport: `POST /api/ai` (SSE). The event contract is
// `AssistantStreamEvent` in `lib/ai/result-cards.ts`: `delta` text, `action`
// lines (the family-readable summary only — never a tool name), `card` and
// `run` for the outcomes worth a card, then `done`. Reopening a conversation
// rehydrates its cards from `ai_messages.structured_content`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, CheckCircle2, Bell, Pill, ListChecks, Mic,
  Plus, School, Send, ShoppingCart, Sparkles, UtensilsCrossed,
  Square, Volume2, VolumeX, Loader2, ShieldCheck, LayoutList,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { AssistantWorkspace, useDesktop, type WorkspacePane } from '@/components/assistant/workspace';
import { ConversationPane } from '@/components/assistant/conversation-pane';
import { ResultPane, cardId, type ConversationMessage } from '@/components/assistant/result-pane';
import { ContextRail, type ActivityItem, type GlanceItem, type UpcomingEvent } from '@/components/assistant/context-rail';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { isManager } from '@/lib/constants/roles';
import { useVoice } from '@/lib/hooks/use-voice';
import { VOICE_MODES, cleanTranscript } from '@/lib/ai/voice';
import { parsePrefillQuery } from '@/lib/ai/prefill';
import { parseAssistantStreamEvent, runStatusCard, structuredContentFrom, type ResultCard } from '@/lib/ai/result-cards';
import { useTranslations } from '@/components/i18n/locale-provider';

// Quick-suggestion chips shown above an active conversation.
const CHIPS = [
  [CalendarDays, "What's happening today?"],
  [UtensilsCrossed, 'Plan dinners for the week'],
  [Sparkles, 'Add soccer practice every Tuesday'],
  [ListChecks, 'Create chores for the kids'],
  [School, 'Summarize our week'],
] as const;

// "Popular requests" cards on the welcome hero (icon + title + sub + prompt).
const POPULAR: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string; prompt: string }[] = [
  { icon: CalendarDays, title: "Today's plan", sub: "what's on our schedule", prompt: "What's on our schedule today?" },
  { icon: UtensilsCrossed, title: 'Plan dinners', sub: 'for the whole week', prompt: 'Plan dinners for this week' },
  { icon: ListChecks, title: 'Assign chores', sub: 'to the kids', prompt: 'Create chores for the kids this week' },
  { icon: ShoppingCart, title: 'Grocery list', sub: 'from our meal plan', prompt: 'Build a grocery list from our meal plan' },
  { icon: Bell, title: 'Set a reminder', sub: 'so nothing slips', prompt: 'Remind me to order the camp forms' },
];

const TRY_ASKING = [
  { icon: CalendarDays, text: "What's on our schedule today?" },
  { icon: UtensilsCrossed, text: 'Plan dinners for this week' },
  { icon: ShoppingCart, text: 'Build a grocery list from our meal plan' },
  { icon: ListChecks, text: 'What chores are due this week?' },
];

type ChatAction = { name: string; ok: boolean; summary: string };
type Message = ConversationMessage & { actions?: ChatAction[]; runIds?: string[] };

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

/** One-line label for the outcome chip in the thread that points at the card in the plan pane. */
export function cardChipLabel(card: ResultCard): string {
  switch (card.kind) {
    case 'meal_plan': return `Meal plan · ${card.days.length} ${card.days.length === 1 ? 'day' : 'days'}`;
    case 'calendar_conflict': return card.conflicts.length ? `${card.conflicts.length} ${card.conflicts.length === 1 ? 'conflict' : 'conflicts'}` : 'No conflicts';
    case 'budget_analysis': return 'Spending';
    case 'vacation_prep': return 'Trip prep';
    case 'task_group': return `${card.tasks.length} ${card.tasks.length === 1 ? 'task' : 'tasks'}`;
    case 'grocery_list': return `Grocery list · ${card.items.length}`;
    case 'readiness': return `Readiness ${Math.round(card.score)}`;
    case 'approval': return 'Needs your approval';
    case 'run_status': return card.title;
    default: return card.title;
  }
}

/** Run ids without a card of their own become run cards, so a reopened conversation still links to its runs. */
export function withRunCards(cards: ResultCard[], runIds: string[]): ResultCard[] {
  const seen = new Set(cards.filter((c): c is Extract<ResultCard, { kind: 'run_status' }> => c.kind === 'run_status').map((c) => c.run_id));
  return [...cards, ...runIds.filter((id) => !seen.has(id)).map((id) => runStatusCard({ runId: id }))];
}

export function AssistantModule() {
  const t = useTranslations();
  const { family, selfMember, role } = useApp();
  const firstName = (selfMember?.display_name || 'there').split(' ')[0];
  const canDecide = isManager(role);
  const desktop = useDesktop();

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
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);

  // Workspace state: which pane a phone shows, which card the thread pointed at,
  // and how many cards arrived since the plan pane was last looked at.
  const [pane, setPane] = useState<WorkspacePane>('chat');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [unseenCards, setUnseenCards] = useState(0);

  // Context rail data
  const [glance, setGlance] = useState<GlanceItem[]>([
    { icon: CalendarDays, value: '—', label: 'Events today' },
    { icon: CheckCircle2, value: '—', label: 'Tasks due' },
    { icon: Bell, value: '—', label: 'Reminders due' },
    { icon: Pill, value: '—', label: 'Active meds' },
  ]);
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railError, setRailError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  // True once the user has sent at least one message → switch hero → chat thread.
  const hasConversation = messages.some((m) => m.role === 'user');

  // Load the context rail. Every read captures its error: a failed count is
  // shown as an error the person can retry, never as a confident zero.
  const loadRail = useCallback(async () => {
    if (!family?.id) return;
    const supabase = createClient();
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const in14 = new Date(start); in14.setDate(in14.getDate() + 14);
    setRailLoading(true);

    const [todayRes, choresRes, upcomingRes, remindersRes, medsRes] = await Promise.all([
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
    ]);
    setRailLoading(false);
    const failed = [todayRes.error, choresRes.error, upcomingRes.error, remindersRes.error, medsRes.error].find(Boolean);
    if (failed) {
      console.error('[assistant] context rail load failed', failed);
      setRailError(describeDbError(failed, t('assistantModule.couldNotLoadTodayS')));
      return;
    }
    setRailError(null);
    const todayEvts = todayRes.data ?? [];
    setGlance([
      { icon: CalendarDays, value: String(todayEvts.length), label: 'Events today' },
      { icon: CheckCircle2, value: String(choresRes.count ?? 0), label: 'Tasks due' },
      { icon: Bell, value: String(remindersRes.count ?? 0), label: 'Reminders due' },
      { icon: Pill, value: String(medsRes.count ?? 0), label: 'Active meds' },
    ]);
    setUpcoming(upcomingRes.data ?? []);
    setActivity(todayEvts.slice(0, 3).map((e, i) => ({
      icon: CalendarDays,
      text: `${e.title} added to calendar`,
      time: fmtRelative(e.created_at),
      color: ['text-emerald-400', 'text-orange-400', 'text-violet-400'][i] ?? 'text-violet-400',
    })));
  }, [family?.id, t]);

  useEffect(() => { void loadRail(); }, [loadRail]);

  useEffect(() => {
    if (hasConversation) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, hasConversation]);

  // The plan pane, once looked at, has no unseen cards.
  useEffect(() => { if (pane === 'plan' || desktop) setUnseenCards(0); }, [pane, desktop, messages]);

  // Deep link: arriving with "?q=…" (e.g. routed here from Quick Capture) sends
  // that question immediately, then strips it from the URL so a refresh/back
  // doesn't resend. Runs once.
  const prefillSent = useRef(false);
  useEffect(() => {
    if (prefillSent.current || typeof window === 'undefined') return;
    const q = parsePrefillQuery(window.location.search);
    if (!q) return;
    prefillSent.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('q');
    window.history.replaceState({}, '', url.toString());
    void send(q);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the conversation list, and rehydrate the active conversation's messages.
  const loadConversations = useCallback(async () => {
    if (!family?.id) return;
    const supabase = createClient();
    const { data, error } = await supabase.from('ai_conversations')
      .select('id, title, updated_at').eq('family_id', family.id)
      .order('updated_at', { ascending: false }).limit(25);
    // Keep the prior conversation history on a transient read failure instead of
    // clobbering the sidebar to an empty "no conversations" list.
    setConversationsError(error ? describeDbError(error, t('assistantModule.couldNotLoadYourConversations')) : null);
    if (error) return;
    setConversations(data ?? []);
  }, [family?.id, t]);

  const loadConversation = useCallback(async (id: string) => {
    const supabase = createClient();
    const { data, error } = await supabase.from('ai_messages')
      .select('role, content, tool_results, structured_content').eq('conversation_id', id)
      .order('created_at', { ascending: true }).limit(200);
    // A failed message read must not masquerade as an empty conversation (a fresh
    // greeting) — that hides real history. Leave the current view intact so the
    // user can retry rather than switching into a misleading blank thread.
    setThreadError(error ? describeDbError(error, t('assistantModule.couldNotOpenThatConversation')) : null);
    if (error) return;
    setConvId(id);
    if (typeof window !== 'undefined') sessionStorage.setItem('assistant-conv-id', id);
    if (!data || data.length === 0) { setMessages(greeting()); return; }
    setMessages(data.map((m) => {
      const structured = structuredContentFrom(m.structured_content);
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
        id: generateId(),
        actions: Array.isArray(m.tool_results)
          ? (m.tool_results as { ok?: boolean; summary?: string; error?: string }[]).map((r) => ({ name: '', ok: r?.ok !== false, summary: r?.summary ?? r?.error ?? 'Done' }))
          : undefined,
        cards: m.role === 'assistant' ? withRunCards(structured.cards, structured.runIds) : undefined,
        runIds: structured.runIds,
      } as Message;
    }));
  }, [firstName]); // eslint-disable-line react-hooks/exhaustive-deps

  function newChat() {
    const id = newConversationId();
    setConvId(id);
    if (typeof window !== 'undefined') sessionStorage.setItem('assistant-conv-id', id);
    setMessages(greeting());
    setInput('');
    setHighlightId(null);
    setPane('chat');
  }

  async function deleteConversation(id: string) {
    if (!confirm(t('assistantModule.deleteThisConversation'))) return;
    const { error } = await createClient().from('ai_conversations').delete().eq('id', id);
    if (error) {
      console.error('[assistant] conversation delete failed', error);
      setConversationsError(describeDbError(error, t('assistantModule.couldNotDeleteThatConversation')));
      return;
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === convId) newChat();
  }

  async function renameConversation(id: string, current: string) {
    const title = window.prompt(t('assistantModule.renameConversation'), current || '')?.trim();
    if (!title || title === current) return;
    const { error } = await createClient().from('ai_conversations').update({ title: title.slice(0, 80) }).eq('id', id);
    if (error) {
      console.error('[assistant] conversation rename failed', error);
      setConversationsError(describeDbError(error, t('assistantModule.couldNotRenameThatConversation')));
      return;
    }
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
    setHighlightId(null);

    const userMsg: Message = { role: 'user', content: msg, id: generateId() };
    const replyId = generateId();
    // Add the user turn + an empty assistant bubble we fill as the stream arrives.
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', id: replyId, actions: [], cards: [], runIds: [] }]);
    setLoading(true);

    const patchReply = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));
    const addCard = (card: ResultCard) => {
      patchReply((m) => ({ ...m, cards: [...(m.cards ?? []), card] }));
      setUnseenCards((n) => n + 1);
    };

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ conversationId: convId, message: msg }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: t('assistantModule.sorryIHadTroubleWith') })) as { error?: string };
        patchReply((m) => ({ ...m, content: err.error ?? t('assistantModule.sorryIHadTroubleWith') }));
        return;
      }
      // Parse the SSE stream: delta (text), action (line), card, run, error, done.
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
          let raw: unknown;
          try { raw = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const ev = parseAssistantStreamEvent(raw);
          if (!ev) continue;
          if (ev.type === 'delta' && ev.text) { finalText += ev.text; patchReply((m) => ({ ...m, content: m.content + ev.text })); }
          else if (ev.type === 'action') patchReply((m) => ({ ...m, actions: [...(m.actions ?? []), { name: ev.name, ok: ev.ok, summary: ev.summary }] }));
          else if (ev.type === 'card') addCard(ev.card);
          else if (ev.type === 'run') {
            patchReply((m) => ({ ...m, runIds: [...new Set([...(m.runIds ?? []), ev.runId])] }));
            addCard(runStatusCard({ runId: ev.runId, status: ev.status, summary: ev.summary }));
          }
          else if (ev.type === 'error') patchReply((m) => ({ ...m, content: m.content || ev.error }));
          else if (ev.type === 'done') { finalText = ev.content || finalText; patchReply((m) => ({ ...m, content: m.content || (ev.content || 'Done.') })); }
        }
      }
      // Speak the reply aloud when voice output is enabled on this device.
      if (finalText.trim() && voice.shouldSpeak()) void voice.speak(finalText);
    } catch (error) {
      console.error('[assistant] request failed', error);
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

  /** A chip in the thread points at its card: on a phone that means the Plan tab. */
  function openCard(id: string) {
    setHighlightId(id);
    if (!desktop) setPane('plan');
  }

  const ask = (text: string) => { setPane('chat'); void send(text); };

  const planCount = useMemo(() => messages.reduce((n, m) => n + (m.cards?.length ?? 0), 0), [messages]);

  // Shared composer props (used by both the hero and the docked input bar).
  const composerProps = {
    input, setInput, loading, voice, voiceError,
    onSend: () => void send(),
    onMic: () => void onMicPress(),
    dismissVoiceError: () => setVoiceError(null),
  };

  const thread = (
    <>
      <div className="mt-4 flex gap-2.5 overflow-x-auto scrollbar-none">
        {CHIPS.map(([Icon, label]) => (
          <button
            key={label} type="button" onClick={() => void send(label)}
            className="focus-ring inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface/40 px-4 text-sm text-fg transition hover:border-brand/40 hover:bg-elevated"
          >
            <Icon className="h-4 w-4 text-brand-text" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {threadError && (
        <div role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {threadError}
        </div>
      )}

      <div className="mt-7 flex-1 space-y-6 overflow-y-auto overscroll-contain pb-4">
        {messages.map((msg) =>
          msg.role === 'assistant' ? (
            <div key={msg.id} className="assistant-message-enter flex gap-3">
              <div className="ai-orb mt-1 h-8 w-8 shrink-0">
                <Sparkles className="h-4 w-4 text-brand-text" aria-hidden />
              </div>
              <div className="min-w-0 max-w-[480px] space-y-2">
                <div className="rounded-2xl border border-border bg-surface/40 p-4 text-sm leading-6 whitespace-pre-wrap">
                  {msg.content
                    ? msg.content
                    : ((msg.actions && msg.actions.length > 0) || (msg.cards && msg.cards.length > 0))
                      ? <span className="text-muted">{t('assistant.workingOnIt')}</span>
                      : (
                        <span className="inline-flex items-center gap-1.5" role="status" aria-label={t('assistant.bubalyIsThinking')}>
                          {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-brand motion-reduce:animate-none" style={{ animationDelay: `${i * 0.15}s` }} />)}
                        </span>
                      )}
                </div>
                {msg.actions && msg.actions.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t('assistant.whatBubalyDid')}>
                    {msg.actions.map((a, i) => (
                      <li key={i} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', a.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger')}>
                        <CheckCircle2 className="h-3 w-3" aria-hidden /> {a.summary}
                      </li>
                    ))}
                  </ul>
                )}
                {msg.cards && msg.cards.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t('assistant.results')}>
                    {msg.cards.map((card, i) => {
                      const id = cardId(msg.id, i);
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            onClick={() => openCard(id)}
                            className={cn(
                              'focus-ring coarse:min-h-11 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition hover:bg-elevated',
                              highlightId === id ? 'border-brand/60 bg-brand/15 text-brand-text' : 'border-brand/30 bg-brand/10 text-brand-text',
                            )}
                          >
                            <LayoutList className="h-3 w-3" aria-hidden /> {cardChipLabel(card)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div key={msg.id} className="assistant-message-enter ml-auto max-w-[520px] text-right">
              <div className="inline-block rounded-2xl bg-brand px-4 py-3 text-sm font-medium text-brand-fg shadow-glow">
                {msg.content}
              </div>
            </div>
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Docked input bar */}
      <div className="mt-4 pb-[env(safe-area-inset-bottom)]">
        <Composer variant="bar" {...composerProps} onMicPress={composerProps.onMic} />
        <p className="mt-3 text-center text-xs text-muted/60">{t('assistant.aiCanMakeMistakesPleaseDouble')}</p>
      </div>
    </>
  );

  const hero = (
    <div className="ai-hero-glow -mx-2 mt-2 flex flex-1 flex-col items-center justify-start rounded-3xl px-2 pb-5 pt-6 text-center sm:pt-8">
      <h2 className="text-2xl font-black sm:text-4xl">{t('assistant.whatCanIHelpYouWith')}</h2>
      <p className="mt-2 max-w-lg text-sm text-muted sm:text-base">
        {t('assistant.tellMeWhatYouNeedI')}
      </p>

      <div className="mt-6 w-full max-w-2xl">
        <Composer variant="hero" {...composerProps} onMicPress={composerProps.onMic} />
      </div>

      <div className="mt-6 w-full max-w-3xl">
        <p className="mb-3 text-sm font-bold tracking-wide text-fg/90">{t('assistant.popularRequests')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {POPULAR.map(({ icon: Icon, title, sub, prompt }) => (
            <button
              key={title}
              type="button"
              onClick={() => void send(prompt)}
              disabled={loading}
              className="ai-suggest-card group flex items-start gap-2.5 p-3 text-left disabled:opacity-50"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text transition group-hover:bg-brand/20">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-fg">{title}</span>
                <span className="block truncate text-xs text-muted">{sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 inline-flex items-center gap-2 text-xs text-muted sm:text-sm">
        <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
        {t('assistant.yourFamilyAposSDataStays')}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {/* Top controls — voice mode + new chat. Title shows only mid-conversation. */}
      <div className="flex items-center gap-4">
        {hasConversation ? (
          <div className="flex items-center gap-3">
            <div className="ai-orb h-11 w-11 shrink-0">
              <Sparkles className="h-5 w-5 text-brand-text drop-shadow" aria-hidden />
            </div>
            <h1 className="text-2xl font-black sm:text-3xl">{t('assistant.familyAi')}</h1>
            <span className="rounded-md bg-brand px-2.5 py-1 text-[10px] font-black tracking-wide text-brand-fg">BETA</span>
          </div>
        ) : (
          <span className="text-sm font-semibold text-muted">{t('assistant.familyConcierge')}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowVoiceMenu((s) => !s)}
              aria-label={t('assistant.voiceSettings')}
              aria-expanded={showVoiceMenu}
              className={cn(
                'focus-ring coarse:min-h-11 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition',
                voice.mode === 'text'
                  ? 'border-border bg-surface/40 text-fg hover:bg-elevated'
                  : 'border-brand/40 bg-brand/10 text-brand-text',
              )}
            >
              {voice.mode === 'text' ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
              <span className="hidden sm:inline">{t('assistant.voice')}</span>
            </button>
            {showVoiceMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowVoiceMenu(false)} />
                <div className="popover-surface absolute right-0 z-20 mt-2 w-60 p-2">
                  <p className="px-2 py-1.5 text-xs font-semibold text-muted">{t('assistant.assistantVoiceThisDevice')}</p>
                  {VOICE_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => { voice.setMode(m.value); setShowVoiceMenu(false); if (m.value === 'text') voice.stopSpeaking(); }}
                      className={cn(
                        'focus-ring flex w-full flex-col items-start rounded-lg px-2 py-2 text-left transition',
                        voice.mode === m.value ? 'bg-brand/10' : 'hover:bg-elevated',
                      )}
                    >
                      <span className={cn('text-sm font-medium', voice.mode === m.value ? 'text-brand-text' : 'text-fg')}>{m.label}</span>
                      <span className="text-xs text-muted">{m.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button type="button" onClick={newChat} className="focus-ring coarse:min-h-11 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-3 py-1.5 text-sm font-semibold text-fg transition hover:bg-elevated">
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('assistant.newChat')}</span>
          </button>
        </div>
      </div>

      <AssistantWorkspace
        pane={pane}
        onPaneChange={setPane}
        counts={{ plan: unseenCards }}
        hero={hasConversation ? undefined : hero}
        conversation={(
          <ConversationPane
            conversations={conversations}
            activeId={convId}
            error={conversationsError}
            onSelect={(id) => void loadConversation(id)}
            onNew={newChat}
            onRename={(id, current) => void renameConversation(id, current)}
            onDelete={(id) => void deleteConversation(id)}
            onRetry={() => void loadConversations()}
          >
            {hasConversation ? thread : (
              <p className="mt-4 rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                {t('assistant.yourConversationWithBubalyShowsUp')}
              </p>
            )}
          </ConversationPane>
        )}
        plan={(
          <ResultPane
            messages={messages}
            streaming={loading}
            compact={!desktop}
            canDecide={canDecide}
            onAsk={ask}
            highlightId={highlightId}
          />
        )}
        context={(
          <ContextRail
            glance={glance}
            upcoming={upcoming}
            activity={activity}
            prompts={TRY_ASKING}
            loading={railLoading}
            error={railError}
            onRetry={() => void loadRail()}
            onAsk={ask}
          />
        )}
      />
      <p className="sr-only" aria-live="polite">{planCount > 0 ? `${planCount} results available in the plan pane` : ''}</p>
    </div>
  );
}

/* ───────────────────────── Composer ─────────────────────────
   Shared input surface. `hero` = the large welcome textarea with a
   gradient send button; `bar` = the compact docked input. Both share the
   voice-error banner, stop-speaking control, and recording state. */
type VoiceApi = ReturnType<typeof useVoice>;
function Composer({
  variant, input, setInput, loading, voice, voiceError, onSend, onMicPress, dismissVoiceError,
}: {
  variant: 'hero' | 'bar';
  input: string;
  setInput: (v: string) => void;
  loading: boolean;
  voice: VoiceApi;
  voiceError: string | null;
  onSend: () => void;
  onMicPress: () => void;
  dismissVoiceError: () => void;
}) {
  const t = useTranslations();
  const isHero = variant === 'hero';
  const disabled = loading || voice.status === 'transcribing';
  const canSend = !disabled && input.trim().length > 0;

  return (
    <div className={isHero ? 'text-left' : ''}>
      {voiceError && (
        <div className="mb-2 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <span>{voiceError}</span>
          <button type="button" onClick={dismissVoiceError} aria-label={t('assistant.dismiss')} className="ml-2 text-amber-300/70 hover:text-amber-200">✕</button>
        </div>
      )}
      {voice.status === 'speaking' && (
        <button
          type="button"
          onClick={voice.stopSpeaking}
          className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand-text"
        >
          <Square className="h-3 w-3" aria-hidden /> {t('assistant.stopSpeaking')}
        </button>
      )}

      {voice.status === 'recording' ? (
        // Recording state: pulsing indicator + stop / cancel.
        <div className="flex items-center gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
          </span>
          <span className="flex-1 text-sm font-medium text-rose-200">{t('assistant.listeningTapTheMicToSend')}</span>
          <button type="button" onClick={voice.cancelRecording} className="rounded-full px-3 py-1.5 text-xs font-semibold text-rose-200/80 hover:text-rose-100">
            {t('assistant.cancel')}
          </button>
          <button type="button" onClick={onMicPress} aria-label={t('assistant.stopAndSend')} className="grid h-10 w-10 place-items-center rounded-full bg-rose-500 text-white">
            <Square className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : isHero ? (
        /* Hero: tall textarea with gradient send button */
        <div className="ai-composer flex items-end gap-2 p-3 sm:gap-3 sm:p-4">
          <textarea
            rows={2}
            className="min-h-[3.5rem] w-full flex-1 resize-none bg-transparent text-base leading-7 outline-none placeholder:text-muted"
            placeholder={voice.status === 'transcribing' ? 'Transcribing…' : 'Describe what you need… e.g. “Plan dinners and build the grocery list”'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            enterKeyHint="send"
            disabled={disabled}
            aria-label={t('assistant.askBubaly')}
          />
          {voice.supported && (
            <button
              type="button"
              onClick={onMicPress}
              disabled={disabled}
              aria-label={t('assistant.recordVoiceMessage')}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-40"
            >
              {voice.status === 'transcribing' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic className="h-5 w-5" aria-hidden />}
            </button>
          )}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={t('assistant.send')}
            className="ai-send grid h-11 w-11 shrink-0 place-items-center rounded-full text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-5 w-5" aria-hidden />
          </button>
        </div>
      ) : (
        /* Bar: compact single-line input */
        <div className="ai-composer flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder={voice.status === 'transcribing' ? 'Transcribing…' : 'Ask anything or give a command…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            enterKeyHint="send"
            disabled={disabled}
            aria-label={t('assistant.messageBubaly')}
          />
          {voice.supported && (
            <button
              type="button"
              onClick={onMicPress}
              disabled={disabled}
              aria-label={t('assistant.recordVoiceMessage')}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-40"
            >
              {voice.status === 'transcribing' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            </button>
          )}
          <button type="button" onClick={onSend} disabled={!canSend} aria-label={t('assistant.send')} className="ai-send grid h-10 w-10 shrink-0 place-items-center rounded-full text-white disabled:opacity-40">
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
