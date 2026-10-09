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
import { useDismissOnEscape } from '@/lib/hooks/use-dismiss-on-escape';
import {
  CalendarDays, CheckCircle2, Bell, Pill, ListChecks,
  Plus, School, Send, ShoppingCart, Sparkles, UtensilsCrossed,
  Square, Volume2, VolumeX, ShieldCheck, LayoutList,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { AssistantWorkspace, useDesktop, type WorkspacePane } from '@/components/assistant/workspace';
import { ConversationPane } from '@/components/assistant/conversation-pane';
import { ResultPane, cardId, type ConversationMessage } from '@/components/assistant/result-pane';
import { ContextRail, type ActivityItem, type GlanceItem, type UpcomingEvent } from '@/components/assistant/context-rail';
import { createClient } from '@/lib/supabase/client';
import { readAssistantRailCalendar } from '@/lib/calendar/assistant-rail';
import { settle, settleAll } from '@/lib/supabase/settle';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { useFamilyClock, useFormat } from '@/components/i18n/use-format';
import { cn } from '@/lib/utils/cn';
import { isManager } from '@/lib/constants/roles';
import { useVoice } from '@/lib/hooks/use-voice';
import { MicButton } from '@/components/voice/mic-button';
import type { MicStatus } from '@/lib/voice/mic-flow';
import { VOICE_MODES } from '@/lib/ai/voice';
import { parsePrefillQuery } from '@/lib/ai/prefill';
import { runStatusCard, structuredContentFrom, type ResultCard } from '@/lib/ai/result-cards';
import {
  AssistantConversationActivity, assistantConversationKey, chronologicalMessages,
  consumeAssistantStream, readAssistantConversation, rememberAssistantConversation,
} from '@/lib/ai/conversation-session';
import { MAX_AI_CHAT_MESSAGE_CHARS } from '@/lib/ai/chat-request';
import { usePlural, useTranslations } from '@/components/i18n/locale-provider';

// Quick-suggestion chips shown above an active conversation. Each holds a
// catalogue key: the chip is shown, and sent as the reader's own message, in
// the reader's language.
const CHIPS = [
  [CalendarDays, 'assistantModule.chip.whatsHappeningToday'],
  [UtensilsCrossed, 'assistantModule.chip.planDinners'],
  [Sparkles, 'assistantModule.chip.addSoccerPractice'],
  [ListChecks, 'assistantModule.chip.createChores'],
  [School, 'assistantModule.chip.summarizeOurWeek'],
] as const;

// "Popular requests" cards on the welcome hero (icon + title + sub + prompt).
const POPULAR: { icon: React.ComponentType<{ className?: string }>; id: string }[] = [
  { icon: CalendarDays, id: 'todaysPlan' },
  { icon: UtensilsCrossed, id: 'planDinners' },
  { icon: ListChecks, id: 'assignChores' },
  { icon: ShoppingCart, id: 'groceryList' },
  { icon: Bell, id: 'setAReminder' },
];
const popularKey = (id: string, part: 'title' | 'sub' | 'prompt') => `assistantModule.popular.${id}.${part}`;

const TRY_ASKING = [
  { icon: CalendarDays, textKey: 'assistantModule.popular.todaysPlan.prompt' },
  { icon: UtensilsCrossed, textKey: 'assistantModule.popular.planDinners.prompt' },
  { icon: ShoppingCart, textKey: 'assistantModule.popular.groceryList.prompt' },
  { icon: ListChecks, textKey: 'assistantModule.tryAsking.choresDueThisWeek' },
];

type ChatAction = { name: string; ok: boolean; summary: string };
type Message = ConversationMessage & { actions?: ChatAction[]; runIds?: string[]; error?: string; retryText?: string };
const MESSAGE_PAGE_SIZE = 100;
const CONVERSATION_PAGE_SIZE = 25;
type HistoryCursor = { id: string; created_at: string };

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

type Tr = (key: string, params?: Record<string, string | number>) => string;
type Plural = (key: string, count: number, params?: Record<string, string | number>) => string;

/** One-line label for the outcome chip in the thread that points at the card in the plan pane. */
export function cardChipLabel(card: ResultCard, t: Tr, plural: Plural): string {
  switch (card.kind) {
    case 'meal_plan': return plural('assistantModule.chipLabel.mealPlanDays', card.days.length);
    case 'calendar_conflict': return card.conflicts.length ? plural('assistantModule.chipLabel.conflicts', card.conflicts.length) : t('assistantModule.chipLabel.noConflicts');
    case 'budget_analysis': return t('assistantModule.chipLabel.spending');
    case 'vacation_prep': return t('assistantModule.chipLabel.tripPrep');
    case 'task_group': return plural('assistantModule.chipLabel.tasks', card.tasks.length);
    case 'grocery_list': return t('assistantModule.chipLabel.groceryList', { count: card.items.length });
    case 'readiness': return t('assistantModule.chipLabel.readiness', { score: Math.round(card.score) });
    case 'approval': return t('assistantModule.chipLabel.needsYourApproval');
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
  const { userId, familyId, selfMember, role } = useApp();
  // A changed identity remounts before paint: old text/cards/drafts never get a
  // render under the next household while waiting for an effect to clear them.
  return <AssistantSession key={`${userId}:${familyId}:${selfMember?.id ?? ''}:${role}`} />;
}

function AssistantSession() {
  const clock = useFamilyClock();
  const { fmtRelative } = useFormat();
  const t = useTranslations();
  const plural = usePlural();
  const { family, selfMember, role, userId } = useApp();
  const firstName = (selfMember?.display_name ?? '').trim().split(' ')[0];
  const canDecide = isManager(role);
  const desktop = useDesktop();

  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Speaking is the shared MicButton's job; this hook stays for the SPEAKING
  // half (mode, voice, TTS playback of replies).
  const voice = useVoice({ onError: setVoiceError });
  const [micStatus, setMicStatus] = useState<MicStatus>('idle');
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);
  useDismissOnEscape(showVoiceMenu, () => setShowVoiceMenu(false));

  const greeting = () => {
    // Good morning by the FAMILY's clock (TIME-003).
    const h = clock.hourNow();
    const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    // Without a name the greeting has none, rather than an English "there".
    const content = firstName
      ? t(`assistantModule.greeting.${part}`, { name: firstName })
      : t(`assistantModule.greeting.${part}NoName`);
    return [{ id: 'init', role: 'assistant' as const, content }];
  };

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [convId, setConvId] = useState(newConversationId);
  const storageKey = assistantConversationKey(userId, family.id);
  const remember = (id: string) => {
    try { rememberAssistantConversation(window.sessionStorage, storageKey, id); } catch { /* Storage may be disabled. */ }
  };
  const [activityGuard] = useState(() => new AssistantConversationActivity());
  const mounted = useRef(true);
  const activeId = useRef(convId);
  const drafts = useRef(new Map<string, string>());
  const pendingSend = useRef<{ controller: AbortController; replyId: string } | null>(null);
  const pendingThread = useRef(false);
  const listRequest = useRef(0);
  const railRequest = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const railAbort = useRef<AbortController | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadRetryId, setThreadRetryId] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
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
    { icon: CalendarDays, value: '—', label: t('assistantModule.glance.eventsToday') },
    { icon: CheckCircle2, value: '—', label: t('assistantModule.glance.tasksDue') },
    { icon: Bell, value: '—', label: t('assistantModule.glance.remindersDue') },
    { icon: Pill, value: '—', label: t('assistantModule.glance.activeMeds') },
  ]);
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railError, setRailError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAfterChange = useRef(true);

  useEffect(() => {
    mounted.current = true;
    activityGuard.activate();
    return () => {
      mounted.current = false;
      activityGuard.dispose();
      listAbort.current?.abort();
      railAbort.current?.abort();
    };
  }, [activityGuard]);

  function setDraft(value: string) {
    if (!mounted.current || activeId.current !== convId) return;
    drafts.current.set(activeId.current, value);
    setInput(value);
  }

  // True once the user has sent at least one message → switch hero → chat thread.
  const hasConversation = messages.some((m) => m.role === 'user');

  // Load the context rail. Every read captures its error: a failed count is
  // shown as an error the person can retry, never as a confident zero.
  const loadRail = useCallback(async () => {
    if (!family?.id || !mounted.current) return;
    const request = ++railRequest.current;
    railAbort.current?.abort();
    const abort = new AbortController();
    railAbort.current = abort;
    const supabase = createClient();
    // The FAMILY's day and fortnight, as instants (TIME-003).
    const now = new Date();
    const start = clock.dayStart(0, now);
    const end = clock.dayStart(1, now);
    const in14 = clock.dayStart(14, now);
    setRailLoading(true);
    const calendarRead = readAssistantRailCalendar(supabase, family.id, clock.timeZone, start, end, in14, abort.signal);
    const todayCalendarRead = calendarRead.then(result => ({ data: result.data?.today ?? null, error: result.error }));
    const upcomingCalendarRead = calendarRead.then(result => ({ data: result.data?.upcoming ?? null, error: result.error }));

    const [todayRes, choresRes, upcomingRes, remindersRes, medsRes] = await settleAll([
      todayCalendarRead,
      supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).in('status', ['todo', 'in_progress']).abortSignal(abort.signal),
      upcomingCalendarRead,
      supabase.from('reminders').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).eq('is_done', false).lte('remind_at', end.toISOString()).abortSignal(abort.signal),
      supabase.from('medications').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).eq('is_active', true).abortSignal(abort.signal),
    ]);
    if (!mounted.current || request !== railRequest.current || abort.signal.aborted) return;
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
      { icon: CalendarDays, value: String(todayEvts.length), label: t('assistantModule.glance.eventsToday') },
      { icon: CheckCircle2, value: String(choresRes.count ?? 0), label: t('assistantModule.glance.tasksDue') },
      { icon: Bell, value: String(remindersRes.count ?? 0), label: t('assistantModule.glance.remindersDue') },
      { icon: Pill, value: String(medsRes.count ?? 0), label: t('assistantModule.glance.activeMeds') },
    ]);
    setUpcoming((upcomingRes.data ?? []).map(e => ({
      ...e,
      occurrenceKey: JSON.stringify([e.id, e.starts_at]),
    })));
    setActivity(todayEvts.slice(0, 3).map((e, i) => ({
      icon: CalendarDays,
      text: t('assistantModule.addedToCalendar', { title: e.title }),
      time: fmtRelative(e.created_at),
      color: ['text-emerald-400', 'text-orange-400', 'text-violet-400'][i] ?? 'text-violet-400',
    })));
  }, [family?.id, t, clock, fmtRelative]);

  useEffect(() => { void loadRail(); }, [loadRail]);

  useEffect(() => {
    if (hasConversation && scrollAfterChange.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    scrollAfterChange.current = true;
  }, [messages, hasConversation]);

  // The plan pane, once looked at, has no unseen cards.
  useEffect(() => { if (pane === 'plan' || desktop) setUnseenCards(0); }, [pane, desktop, messages]);

  // Deep link: arriving with "?q=…" (e.g. routed here from Quick Capture) sends
  // that question immediately, then strips it from the URL so a refresh/back
  // doesn't resend. Runs once.
  const prefillSent = useRef(false);

  // Load the conversation list, and rehydrate the active conversation's messages.
  const loadConversations = useCallback(async (offset = 0) => {
    if (!family?.id || !mounted.current) return;
    const request = ++listRequest.current;
    listAbort.current?.abort();
    const abort = new AbortController();
    listAbort.current = abort;
    setListLoading(true);
    const supabase = createClient();
    const { data, error } = await settle(supabase.from('ai_conversations')
      .select('id, title, updated_at').eq('family_id', family.id).eq('user_id', userId)
      .order('updated_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + CONVERSATION_PAGE_SIZE - 1).abortSignal(abort.signal));
    if (!mounted.current || request !== listRequest.current) return;
    setListLoading(false);
    // Keep the prior conversation history on a transient read failure instead of
    // clobbering the sidebar to an empty "no conversations" list.
    setConversationsError(error ? describeDbError(error, t('assistantModule.couldNotLoadYourConversations')) : null);
    if (error) return;
    if (offset === 0) setConversations(data ?? []);
    else setConversations(previous => [...new Map([...previous, ...(data ?? [])].map(row => [row.id, row])).values()]);
    setHasMoreConversations((data?.length ?? 0) === CONVERSATION_PAGE_SIZE);
  }, [family?.id, userId, t]);

  const loadConversation = async (id: string, older = false, resume = false) => {
    if (!mounted.current || (older && pendingThread.current)) return;
    if (!older) {
      activityGuard.invalidate();
      pendingSend.current = null;
      setLoading(false);
      voice.stopSpeaking();
      setMicStatus('idle');
      setVoiceError(null);
    }
    const ticket = activityGuard.begin();
    pendingThread.current = true;
    setThreadLoading(true);
    setThreadRetryId(id);
    const supabase = createClient();
    try {
    // RLS protects the read too, but absence is not an empty thread: the stored
    // id can have been deleted on another device or belong to a former session.
    const ownership = await settle(supabase.from('ai_conversations').select('id')
      .eq('id', id).eq('family_id', family.id).eq('user_id', userId)
      .abortSignal(ticket.controller.signal).maybeSingle());
    if (!ticket.current()) return;
    if (ownership.error) { setThreadError(describeDbError(ownership.error, t('assistantModule.couldNotOpenThatConversation'))); return; }
    if (!ownership.data) {
      if (resume) newChat();
      else setThreadError(t('ai.conversationNotFound'));
      return;
    }
    let query = supabase.from('ai_messages')
      .select('id, role, content, created_at, tool_results, structured_content')
      .eq('conversation_id', id).eq('family_id', family.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE + 1).abortSignal(ticket.controller.signal);
    if (older && historyCursor) query = query.or(`created_at.lt.${historyCursor.created_at},and(created_at.eq.${historyCursor.created_at},id.lt.${historyCursor.id})`);
    const { data, error } = await settle(query);
    if (!ticket.current()) return;
    // A failed message read must not masquerade as an empty conversation (a fresh
    // greeting) — that hides real history. Leave the current view intact so the
    // user can retry rather than switching into a misleading blank thread.
    setThreadError(error ? describeDbError(error, t('assistantModule.couldNotOpenThatConversation')) : null);
    if (error) return;
    const page = (data ?? []).slice(0, MESSAGE_PAGE_SIZE);
    const last = page.at(-1);
    setHasOlder((data?.length ?? 0) > MESSAGE_PAGE_SIZE);
    setHistoryCursor(last ? { id: last.id, created_at: last.created_at } : null);
    activeId.current = id;
    setConvId(id);
    remember(id);
    setThreadRetryId(null);
    setInput(drafts.current.get(id) ?? '');
    setHighlightId(null);
    setUnseenCards(0);
    const loaded = chronologicalMessages(page).map((m) => {
      const structured = structuredContentFrom(m.structured_content);
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
        id: m.id,
        actions: Array.isArray(m.tool_results)
          ? (m.tool_results as { ok?: boolean; summary?: string; error?: string }[]).map((r) => ({ name: '', ok: r?.ok !== false, summary: r?.summary ?? r?.error ?? 'Done' }))
          : undefined,
        cards: m.role === 'assistant' ? withRunCards(structured.cards, structured.runIds) : undefined,
        runIds: structured.runIds,
        ...(m.role === 'assistant' && structured.responseError ? { error: structured.responseError } : {}),
      } as Message;
    });
    scrollAfterChange.current = !older;
    setMessages(previous => ticket.current()
      ? older ? [...new Map([...loaded, ...previous].map(message => [message.id, message])).values()]
        : loaded.length ? loaded : greeting()
      : previous);
    } finally {
      if (ticket.current()) { pendingThread.current = false; setThreadLoading(false); }
      ticket.finish();
    }
  };

  function newChat() {
    if (!mounted.current) return;
    activityGuard.invalidate();
    pendingSend.current = null;
    pendingThread.current = false;
    setLoading(false);
    setThreadLoading(false);
    setThreadError(null);
    setThreadRetryId(null);
    setHistoryCursor(null);
    setHasOlder(false);
    setUnseenCards(0);
    voice.stopSpeaking();
    setMicStatus('idle');
    setVoiceError(null);
    const id = newConversationId();
    activeId.current = id;
    setConvId(id);
    remember(id);
    setMessages(greeting());
    setInput('');
    setHighlightId(null);
    setPane('chat');
  }

  async function deleteConversation(id: string) {
    if (!mounted.current || !confirm(t('assistantModule.deleteThisConversation'))) return;
    // 0255 ("ai runtime lockdown") narrows writes on ai_conversations, and RLS
    // FILTERS a delete rather than refusing it — so without the readback a
    // removal the policy blocked answered `error: null` and the row was dropped
    // from the list on screen while staying in the table. `family_id` answers a
    // different question from the readback: whose conversation it was.
    const { data: removed, error } = await settle(createClient().from('ai_conversations').delete()
      .eq('id', id).eq('family_id', family.id).eq('user_id', userId).select('id'));
    if (!mounted.current) return;
    if (error) {
      console.error('[assistant] conversation delete failed', error);
      setConversationsError(describeDbError(error, t('assistantModule.couldNotDeleteThatConversation')));
      return;
    }
    if (wroteNoRows(removed)) { setConversationsError(t('assistantModule.couldNotDeleteThatConversation')); return; }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    drafts.current.delete(id);
    if (id === activeId.current) newChat();
  }

  async function renameConversation(id: string, current: string) {
    if (!mounted.current) return;
    const title = window.prompt(t('assistantModule.renameConversation'), current || '')?.trim().slice(0, 80);
    if (!title || title === current) return;
    const { data: renamed, error } = await settle(createClient().from('ai_conversations')
      .update({ title }).eq('id', id).eq('family_id', family.id).eq('user_id', userId).select('id'));
    if (!mounted.current) return;
    if (error) {
      console.error('[assistant] conversation rename failed', error);
      setConversationsError(describeDbError(error, t('assistantModule.couldNotRenameThatConversation')));
      return;
    }
    if (wroteNoRows(renamed)) { setConversationsError(t('assistantModule.couldNotRenameThatConversation')); return; }
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }

  useEffect(() => { void loadConversations(); }, [loadConversations]);
  // On first mount, rehydrate the stored conversation (or greet for a new one).
  useEffect(() => {
    if (prefillSent.current) return;
    const q = parsePrefillQuery(window.location.search);
    if (q) {
      // StrictMode's mount cleanup happens before this microtask. Only the live
      // mount may consume the link, so its probe mount cannot send then abort it.
      const ticket = activityGuard.begin();
      queueMicrotask(() => {
        if (!ticket.current()) { ticket.finish(); return; }
        ticket.finish();
        prefillSent.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete('q');
        window.history.replaceState({}, '', url.toString());
        // A deep-linked request starts its own conversation instead of joining a
        // saved thread whose async rehydration might overwrite the new response.
        remember(activeId.current);
        void send(q);
      });
      return;
    }
    let stored: string | null = null;
    try { stored = readAssistantConversation(window.sessionStorage, storageKey); } catch { /* Storage denied. */ }
    if (stored) void loadConversation(stored, false, true);
    else { remember(activeId.current); setMessages(greeting()); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || !mounted.current || activeId.current !== convId || pendingSend.current || pendingThread.current) return;
    if (msg.length > MAX_AI_CHAT_MESSAGE_CHARS) { setThreadError(t('validation.messageTooLong', { max: MAX_AI_CHAT_MESSAGE_CHARS })); return; }
    const conversationId = activeId.current;
    const ticket = activityGuard.begin();
    setDraft('');
    setThreadError(null);
    setHighlightId(null);

    const userMsg: Message = { role: 'user', content: msg, id: generateId() };
    const replyId = generateId();
    pendingSend.current = { controller: ticket.controller, replyId };
    // Add the user turn + an empty assistant bubble we fill as the stream arrives.
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '', id: replyId, actions: [], cards: [], runIds: [] }]);
    setLoading(true);

    const patchReply = (fn: (m: Message) => Message) =>
      setMessages((prev) => ticket.current() ? prev.map((m) => (m.id === replyId ? fn(m) : m)) : prev);
    const addCard = (card: ResultCard) => {
      patchReply((m) => ({ ...m, cards: [...(m.cards ?? []), card] }));
      setUnseenCards((n) => ticket.current() ? n + 1 : n);
    };

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Bubaly-Family-Id': family.id },
        body: JSON.stringify({ conversationId, message: msg }),
        signal: ticket.controller.signal,
      });
      if (!ticket.current()) return;
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: t('assistantModule.sorryIHadTroubleWith') })) as { error?: string };
        patchReply((m) => ({ ...m, error: err.error ?? t('assistantModule.sorryIHadTroubleWith'), retryText: msg }));
        return;
      }
      let finalText = '';
      let failed = false;
      const result = await consumeAssistantStream(res.body, (ev) => {
          if (!ticket.current()) return;
          if (ev.type === 'delta' && ev.text) { finalText += ev.text; patchReply((m) => ({ ...m, content: m.content + ev.text })); }
          else if (ev.type === 'action') patchReply((m) => ({ ...m, actions: [...(m.actions ?? []), { name: ev.name, ok: ev.ok, summary: ev.summary }] }));
          else if (ev.type === 'card') addCard(ev.card);
          else if (ev.type === 'run') {
            patchReply((m) => ({ ...m, runIds: [...new Set([...(m.runIds ?? []), ev.runId])] }));
            addCard(runStatusCard({ runId: ev.runId, status: ev.status, summary: ev.summary }));
          }
          else if (ev.type === 'error') { failed = true; patchReply((m) => ({ ...m, error: ev.error })); }
          else if (ev.type === 'done') {
            finalText = ev.content || finalText;
            if (!ev.persisted) failed = true;
            patchReply((m) => ({ ...m, content: ev.content || m.content,
              ...(!ev.persisted ? { error: m.error || t('mobileAssistant.notSaved') } : {}) }));
          }
      }, ticket.controller.signal);
      if (!ticket.current()) return;
      if (!result.completed) {
        failed = true;
        patchReply((m) => ({ ...m, error: m.error || t('assistantModule.session.interrupted') }));
      }
      // Speak the reply aloud when voice output is enabled on this device.
      if (!failed && finalText.trim() && voice.shouldSpeak()) void voice.speak(finalText);
    } catch (error) {
      if (!ticket.current()) return;
      console.error('[assistant] request failed', error);
      patchReply((m) => ({ ...m, error: t('assistantModule.session.interrupted') }));
    } finally {
      if (ticket.current()) {
        pendingSend.current = null;
        setLoading(false);
        void loadConversations();
      }
      ticket.finish();
    }
  }

  function stopResponse() {
    const pending = pendingSend.current;
    if (!pending || !mounted.current) return;
    pending.controller.abort();
    pendingSend.current = null;
    setLoading(false);
    setMessages(previous => previous.map(message => message.id === pending.replyId
      ? { ...message, error: t('assistantModule.session.stopped') } : message));
    voice.stopSpeaking();
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
    input, setInput: setDraft, loading: loading || threadLoading, voice, voiceError, micStatus,
    onSend: () => void send(),
    // A spoken request is sent exactly like a typed one.
    onTranscript: (text: string) => void send(text),
    onMicStatus: (status: MicStatus) => { if (mounted.current && activeId.current === convId && !pendingThread.current) setMicStatus(status); },
    onVoiceError: (message: string | null) => { if (mounted.current && activeId.current === convId && !pendingThread.current) setVoiceError(message); },
    dismissVoiceError: () => setVoiceError(null),
  };

  const thread = (
    <>
      <div className="mt-4 flex gap-2.5 overflow-x-auto scrollbar-none">
        {CHIPS.map(([Icon, key]) => { const label = t(key); return (
          <button
            key={key} type="button" onClick={() => void send(label)}
            className="focus-ring inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface/40 px-4 text-sm text-fg transition hover:border-brand/40 hover:bg-elevated"
          >
            <Icon className="h-4 w-4 text-brand-text" aria-hidden />
            {label}
          </button>
        ); })}
      </div>

      <div className="mt-7 flex-1 space-y-6 overflow-y-auto overscroll-contain pb-4">
        {hasOlder && (
          <button type="button" disabled={threadLoading} onClick={() => void loadConversation(convId, true)} className="focus-ring min-h-11 rounded-lg border border-border px-3 py-2 text-xs text-brand-text disabled:opacity-50">
            {t('assistantModule.session.loadEarlier')}
          </button>
        )}
        {messages.map((msg) =>
          msg.role === 'assistant' ? (
            <div key={msg.id} className="assistant-message-enter flex gap-3">
              <div className="ai-orb mt-1 h-8 w-8 shrink-0">
                <Sparkles className="h-4 w-4 text-brand-text" aria-hidden />
              </div>
              <div className="min-w-0 max-w-[480px] space-y-2">
                {(msg.content || !msg.error) && <div className="rounded-2xl border border-border bg-surface/40 p-4 text-sm leading-6 whitespace-pre-wrap">
                  {msg.content
                    ? msg.content
                    : ((msg.actions && msg.actions.length > 0) || (msg.cards && msg.cards.length > 0))
                      ? <span className="text-muted">{t('assistant.workingOnIt')}</span>
                      : (
                        <span className="inline-flex items-center gap-1.5" role="status" aria-label={t('assistant.bubalyIsThinking')}>
                          {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-brand motion-reduce:animate-none" style={{ animationDelay: `${i * 0.15}s` }} />)}
                        </span>
                      )}
                </div>}
                {msg.error && (
                  <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                    <p>{msg.error}</p>
                    <button type="button" disabled={loading || threadLoading} onClick={() => void loadConversation(convId)} className="focus-ring mt-2 min-h-11 rounded-lg border border-current px-2 disabled:opacity-50">
                      {t('assistantModule.session.reviewSaved')}
                    </button>
                    {msg.retryText && <button type="button" disabled={loading || threadLoading} onClick={() => setDraft(msg.retryText!)} className="focus-ring ml-2 min-h-11 rounded-lg border border-current px-2 disabled:opacity-50">
                      {t('assistantModule.session.editRetry')}
                    </button>}
                  </div>
                )}
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
                            <LayoutList className="h-3 w-3" aria-hidden /> {cardChipLabel(card, t, plural)}
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
        <Composer key={`${convId}:${threadLoading}`} variant="bar" {...composerProps} />
        <p className="mt-3 text-center text-xs text-muted">{t('assistant.aiCanMakeMistakesPleaseDouble')}</p>
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
        <Composer key={`${convId}:${threadLoading}`} variant="hero" {...composerProps} />
      </div>

      <div className="mt-6 w-full max-w-3xl">
        <p className="mb-3 text-sm font-bold tracking-wide text-fg/90">{t('assistant.popularRequests')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {POPULAR.map(({ icon: Icon, id }) => (
            <button
              key={id}
              type="button"
              onClick={() => void send(t(popularKey(id, 'prompt')))}
              disabled={loading || threadLoading}
              className="ai-suggest-card group flex items-start gap-2.5 p-3 text-left disabled:opacity-50"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text transition group-hover:bg-brand/20">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-fg">{t(popularKey(id, 'title'))}</span>
                <span className="block truncate text-xs text-muted">{t(popularKey(id, 'sub'))}</span>
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
            {/* An h2: the route's h1 is the page's (app/(app)/dashboard/assistant/page.tsx), and this module also renders inside the AI orb on other pages. */}
            <h2 className="text-2xl font-black sm:text-3xl">{t('assistant.familyAi')}</h2>
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
                {/* Presentational; the keyboard path is Escape, bound above. */}
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                <div aria-hidden="true" className="fixed inset-0 z-10" onClick={() => setShowVoiceMenu(false)} />
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
          <button type="button" onClick={newChat} aria-label={t('assistant.newChat')} className="focus-ring coarse:min-h-11 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-3 py-1.5 text-sm font-semibold text-fg transition hover:bg-elevated">
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('assistant.newChat')}</span>
          </button>
        </div>
      </div>

      {threadError && (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          <p>{threadError}</p>
          {threadRetryId && <button type="button" onClick={() => void loadConversation(threadRetryId)} className="focus-ring mt-2 min-h-11 rounded-lg border border-current px-2">{t('mobileAssistant.retry')}</button>}
        </div>
      )}
      {threadLoading && <p role="status" className="text-sm text-muted">{t('assistantModule.session.loading')}</p>}
      {loading && <button type="button" onClick={stopResponse} className="focus-ring inline-flex min-h-11 items-center gap-2 self-start rounded-lg border border-border px-3 text-sm text-fg">
        <Square className="h-4 w-4" aria-hidden /> {t('assistantModule.session.stop')}
      </button>}

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
            loading={listLoading && conversations.length === 0}
            hasMore={hasMoreConversations}
            loadingMore={listLoading}
            onLoadMore={() => void loadConversations(conversations.length)}
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
            prompts={TRY_ASKING.map(({ icon, textKey }) => ({ icon, text: t(textKey) }))}
            loading={railLoading}
            error={railError}
            onRetry={() => void loadRail()}
            onAsk={ask}
          />
        )}
      />
      <p className="sr-only" aria-live="polite">{planCount === 1 ? t('assistantModule.planResultsOne') : planCount > 1 ? t('assistantModule.planResultsMany', { n: planCount }) : ''}</p>
    </div>
  );
}

/* ───────────────────────── Composer ─────────────────────────
   Shared input surface. `hero` = the large welcome textarea with a
   gradient send button; `bar` = the compact docked input. Both share the
   voice-error banner, stop-speaking control, and recording state. */
type VoiceApi = ReturnType<typeof useVoice>;
function Composer({
  variant, input, setInput, loading, voice, voiceError, micStatus,
  onSend, onTranscript, onMicStatus, onVoiceError, dismissVoiceError,
}: {
  variant: 'hero' | 'bar';
  input: string;
  setInput: (v: string) => void;
  loading: boolean;
  voice: VoiceApi;
  voiceError: string | null;
  micStatus: MicStatus;
  onSend: () => void;
  onTranscript: (text: string) => void;
  onMicStatus: (status: MicStatus) => void;
  onVoiceError: (message: string | null) => void;
  dismissVoiceError: () => void;
}) {
  const t = useTranslations();
  const isHero = variant === 'hero';
  const disabled = loading || micStatus === 'transcribing';
  const canSend = !disabled && input.trim().length > 0;
  const capturing = micStatus === 'recording' || micStatus === 'listening';
  const mic = (
    <MicButton
      size={isHero ? 'md' : 'sm'}
      disabled={loading}
      onTranscript={onTranscript}
      onStatusChange={onMicStatus}
      onError={onVoiceError}
    />
  );

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
      {capturing && (
        <p className="mb-2 flex items-center gap-2 text-xs font-medium text-rose-300" role="status">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
          </span>
          {t('assistant.listeningTapTheMicToSend')}
        </p>
      )}

      {isHero ? (
        /* Hero: tall textarea with gradient send button */
        <div className="ai-composer flex items-end gap-2 p-3 sm:gap-3 sm:p-4">
          <textarea
            rows={2}
            className="min-h-[3.5rem] w-full flex-1 resize-none bg-transparent text-base leading-7 outline-none placeholder:text-muted"
            placeholder={micStatus === 'transcribing' ? t('micButton.transcribing') : t('assistant.describeWhatYouNeed')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            enterKeyHint="send"
            disabled={disabled}
            aria-label={t('assistant.askBubaly')}
          />
          {mic}
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
            placeholder={micStatus === 'transcribing' ? t('micButton.transcribing') : t('assistant.askAnythingOrGiveA')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            enterKeyHint="send"
            disabled={disabled}
            aria-label={t('assistant.messageBubaly')}
          />
          {mic}
          <button type="button" onClick={onSend} disabled={!canSend} aria-label={t('assistant.send')} className="ai-send grid h-10 w-10 shrink-0 place-items-center rounded-full text-white disabled:opacity-40">
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
