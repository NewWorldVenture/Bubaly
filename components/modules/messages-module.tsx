'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageCircle, Plus, Send, Smile, Paperclip, Reply, Pin, Trash2,
  MoreHorizontal, CheckCheck, ArrowLeft, Search, X, Camera, Loader2,
  Check, Info, Settings, UserPlus, SlidersHorizontal, Mic,
  Image as ImageIcon, BellOff, Archive, ChevronRight, FileText, Download, Pencil, RefreshCw,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { familyMediaPath, removeFamilyMedia } from '@/lib/storage/family-media';
import { settle } from '@/lib/supabase/settle';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { escapeLike } from '@/lib/supabase/escape-like';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { AiInsight } from '@/components/ai/ai-insight';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { GifPicker } from '@/components/messages/gif-picker';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { roleLabel } from '@/lib/constants/roles';
import { firstName } from '@/lib/utils/format';
import { useFamilyClock, useFormat, type FamilyClock } from '@/components/i18n/use-format';
import type { Format } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import {
  convMatchesTab, previewText, shortTime as shortTimeIn, summarizeConversations, type ConvTab,
} from '@/lib/messages/overview';
import type { Tables, MemberRole, Insertable } from '@/lib/database.types';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { ownChannel } from '@/lib/realtime/own-channel';
import { useFamilyMediaUrls } from '@/lib/storage/use-family-media';
import { FamilyMediaImg } from '@/components/media/family-media-img';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { clearConfirmedDraft, createThreadOwner, mergeThreadRows, reconcileLatestThreadRows, messageReadByOthers, shouldSendOnEnter, type ThreadDraft } from '@/lib/messages/thread-state';
import { fellBackForMissing, MESSAGING_SCHEMA } from '@/lib/messages/schema-compat';
import { readDeviceMutes, writeDeviceMutes } from '@/lib/messages/legacy-schema';
import { readMessageWindow } from '@/lib/messages/reads';
import {
  createFamilyConversation, ensureFamilyChat, familyChatOf, loadConversationSummaries, loadInbox,
  markConversationReadThrough, toggleMessageReaction,
} from '@/lib/messages/workspace-paths';

type Conversation = Tables<'family_conversations'>;
type Message = Tables<'family_messages'>;

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
const QUICK_EMOJIS = ['😀', '🎉', '👏', '✅', '🙏', '💪', '🤣', '😍'];

const CONV_TABS: { key: ConvTab; labelKey: string }[] = [
  { key: 'all', labelKey: 'messagesModule.tab.all' },
  { key: 'direct', labelKey: 'messagesModule.tab.direct' },
  { key: 'group', labelKey: 'messagesModule.tab.group' },
  { key: 'announcement', labelKey: 'messagesModule.tab.announcement' },
];

// Grouped by the FAMILY's calendar day (TIME-003) — "Today" is today where the
// family is, not the last 24 hours on whatever clock the phone keeps.
function timeGroup(iso: string, fmtDate: Format['fmtDate'], clock: FamilyClock): string {
  const day = clock.dayKeyOf(iso);
  if (day === clock.todayKey()) return 'Today';
  if (day === clock.wallKey(clock.addDays(clock.wallToday(), -1))) return 'Yesterday';
  return fmtDate(iso, 'MMMM d, yyyy');
}

const MUTE_FALLBACK = 'Mute is kept on this device only, as before the build-out.';

type ConvInsert = {
  family_id: string; name: string | null; kind: string;
  avatar_emoji: string | null; created_by: string;
  member_ids: string[]; participant_ids: string[];
};

/**
 * Validate membership and deduplicate direct chats in one database transaction.
 * Before 0475 there is no such RPC: insert directly, as before the build-out.
 */
async function createConversation(payload: ConvInsert) {
  return createFamilyConversation(createClient(), payload);
}

export function MessagesModule() {
  const { familyId, userId } = useApp();
  return <MessagesWorkspace key={`${familyId}:${userId}`} />;
}

function MessagesWorkspace() {
  const { fmtDate } = useFormat();
  const clock = useFamilyClock();
  const tr = useTranslations();
  // The date follows the reader and the words come from the catalogue.
  const locale = useLocale();
  const shortTime = (iso: string) => shortTimeIn(iso, new Date(), locale.code, tr);
  const { familyId, userId, members, selfMember, role } = useApp();
  const { error: toastError } = useToast();
  const archiveScope = useMemo(() => ({ familyId, userId, role, memberId: selfMember?.id, active: selfMember?.is_active }),
    [familyId, userId, role, selfMember?.id, selfMember?.is_active]);
  const archiveScopeRef = useRef(archiveScope);
  archiveScopeRef.current = archiveScope;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const activeConvId = activeConv?.id;
  const activeConversationRef = useRef(activeConv);
  activeConversationRef.current = activeConv;
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState('');
  const [sendPending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editMessage, setEditMessage] = useState<Message | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState('CONNECTING');
  const [pageVisible, setPageVisible] = useState(true);
  const [wide, setWide] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [threadSearch, setThreadSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyGallery, setHistoryGallery] = useState<'photos' | 'pinned' | null>(null);
  const [conversationAction, setConversationAction] = useState<{ ticket: number; conversationId: string; origin: ReturnType<ReturnType<typeof createThreadOwner>['capture']>; scope: typeof archiveScope; row: Pick<Conversation, 'id' | 'family_id' | 'created_by' | 'is_family_chat' | 'is_archived'> } | null>(null);
  const archiveSequence = useRef(0);
  const archiveCurrent = useRef<number | null>(null);
  const archiveFlight = useRef<number | null>(null);
  const [changingConversation, setChangingConversation] = useState(false);
  const [replyParents, setReplyParents] = useState<Map<string, Message>>(new Map());
  const [viewingHistory, setViewingHistory] = useState(false);
  const historyRef = useRef(false);
  historyRef.current = viewingHistory;
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const typingChannel = useRef<RealtimeChannel | null>(null);
  const owner = useRef(createThreadOwner());
  const messageOrigin = owner.current.capture();
  type MessageOperation = { origin: typeof messageOrigin; scope: typeof archiveScope; row: Conversation; request: number };
  const sendFlight = useRef<MessageOperation | null>(null);
  const messageActionFlight = useRef(new Map<string, MessageOperation>());
  const drafts = useRef(new Map<string, ThreadDraft<Message>>());
  const draftRef = useRef<ThreadDraft<Message>>({ text: '', reply: null, edit: null });
  const renderedDraft = useMemo(() => ({ text, reply: replyTo, edit: editMessage, conversationId: activeConvId }), [text, replyTo, editMessage, activeConvId]);
  draftRef.current = renderedDraft;
  const alive = useRef(true);
  const threadRef = useRef<HTMLDivElement>(null);
  const liveRows = useRef(new Map<string, Message>());
  const hardDeleted = useRef(new Set<string>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const listRequest = useRef(0);
  const summaryRequest = useRef(0);
  const readPending = useRef(false);
  const sendIds = useRef(new Map<string, string>());
  const sendRequest = useRef(0);
  const sending = sendPending && sendFlight.current !== null && isCurrentMessageOperation(sendFlight.current);
  const micRequest = useRef(0);
  const stoppedStreams = useRef(new WeakSet<MediaStream>());
  const releaseStream = useCallback((stream: MediaStream | null) => {
    if (!stream || stoppedStreams.current.has(stream)) return;
    stoppedStreams.current.add(stream); stream.getTracks().forEach((track) => track.stop());
  }, []);
  const PAGE_SIZE = 50;
  const [showPicker, setShowPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mobileShowThread, setMobileShowThread] = useState(false);
  const [msgMenu, setMsgMenu] = useState<string | null>(null);
  const [tab, setTab] = useState<ConvTab>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  // Escape closes the menu.
  //
  // Its click-outside scrim is `aria-hidden` with `tabIndex={-1}`, which is the
  // honest description of a mouse-only dismiss — and which also silences
  // `click-events-have-key-events` and `no-static-element-interactions`, the two
  // rules that were pointing at the gap. With the rules quiet and no Escape
  // path, a keyboard user could open this menu and had no way out of it but to
  // pick something. Same shape as components/app/ai-orb.tsx:39.
  useEffect(() => {
    if (!(filterOpen)) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilterOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterOpen]);
  const [summaries, setSummaries] = useState<ReturnType<typeof summarizeConversations>>(
    { lastByConv: new Map(), unreadByConv: new Map() },
  );
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [mutedIds, setMutedIds] = useState(new Set<string>());
  const [muteLoading, setMuteLoading] = useState(false);
  // Set when this database turns out not to have 0475 / 0476 yet: the paths
  // that need them fall back to main's behaviour or hide (schema-compat.ts).
  const [legacy0475, setLegacy0475] = useState(false);
  const [legacy0476, setLegacy0476] = useState(false);
  const legacy0476Ref = useRef(false);
  legacy0476Ref.current = legacy0476;
  const membersRef = useRef(members);
  membersRef.current = members;
  const [showAbout, setShowAbout] = useState(false); // mobile drawer for the About panel
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const threadSearchRef = useRef<HTMLInputElement>(null);

  const myName = selfMember?.display_name ?? 'You';

  useEffect(() => {
    alive.current = true;
    const ownership = owner.current;
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => { setWide(media.matches); setPageVisible(document.visibilityState === 'visible'); };
    update();
    media.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => { alive.current = false; ownership.select(null); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    if (!msgMenu && !showPicker && !showGifPicker && !showAbout) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMsgMenu(null); setShowPicker(false); setShowGifPicker(false); setShowAbout(false); inputRef.current?.focus(); } };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [msgMenu, showPicker, showGifPicker, showAbout]);

  function conversationName(conv: Conversation) {
    if (conv.kind !== 'direct') return conv.name || tr('messagesModule.familyChat');
    const other = members.find((member) => member.user_id !== userId && (conv.participant_ids?.includes(member.id) || member.user_id && conv.member_ids?.includes(member.user_id)));
    return other?.display_name || conv.name || tr('messages.directMessage');
  }

  // ── Load conversations ──────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const request = ++listRequest.current;
    const supabase = createClient();
    const { rows, legacy, error } = await loadInbox(supabase, { familyId, userId, selfMemberId: selfMember?.id });
    if (!alive.current || request !== listRequest.current) return;
    if (error || !rows) {
      // Fail visibly instead of showing an empty inbox on a failed load — an empty
      // list here would make the user think they have no conversations.
      setInboxError(describeDbError(error));
      toastError(describeDbError(error));
      setLoadingConvs(false);
      return;
    }
    setInboxError(null);
    // Without 0475 the rows carry no is_family_chat: list them all, as before.
    if (legacy) setLegacy0475(true);
    setConversations(rows);
    setLoadingConvs(false);
    const selected = owner.current.capture().conversationId;
    if (selected) {
      const current = rows.find((conv) => conv.id === selected);
      setActiveConv(current ?? null);
      if (!current) { owner.current.select(null); setMessages([]); setText(''); setReplyTo(null); setEditMessage(null); }
    } else if (rows.length > 0) {
      const requested = rows.find((conv) => conv.id === new URLSearchParams(window.location.search).get('conversation'));
      const familyChat = familyChatOf(rows, legacy);
      const group = requested ?? familyChat ?? rows.find((conv) => !conv.is_archived);
      if (requested) { setMobileShowThread(true); setShowArchived(requested.is_archived); }
      if (group) { owner.current.select(group.id); setActiveConv(group); setShowArchived(Boolean(group.is_archived)); }
    }
  }, [familyId, userId, selfMember?.id, toastError]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  // ── Ensure Family Chat exists ───────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const { error, legacy } = await ensureFamilyChat(supabase, {
        familyId, userId, name: tr('messagesModule.familyChat'), members: membersRef.current,
      });
      if (!alive.current || !active) return;
      if (legacy) setLegacy0475(true);
      // Before 0475 a failed lookup or insert was silent and retried next visit.
      if (error && legacy) console.error('[messages] family chat fallback failed', { message: error.message });
      else if (error) toastError(describeDbError(error, tr('messagesModule.couldNotCreateConversation')));
      else void loadConversations();
    })();
    return () => { active = false; };
  }, [familyId, userId, loadConversations, toastError, tr]);

  // ── Load messages for active conv ──────────────────────────
  // `toastError` is in the deps because it IS a dependency — this callback
  // calls it. It is safe to list: `useToast`'s context value is memoised on
  // `[push]` (see the comment in components/ui/toast.tsx, which says it exists
  // for exactly this), so the identity is stable and adding it cannot make
  // this callback — or the effects that depend on it — re-run per toast.
  const loadMessages = useCallback(async (convId: string, older = false, quiet = false) => {
    if (owner.current.capture().conversationId !== convId) return;
    if (!older && quiet && historyRef.current) return;
    const ticket = owner.current.begin(older ? 'older' : 'history');
    const eventBaseline = new Map(liveRows.current);
    if (older) setLoadingOlder(true); else if (!quiet) setLoadingMsgs(true);
    setLoadError(null);
    const supabase = createClient();
    const oldest = messagesRef.current[0];
    // Reconnect repairs a bounded newest window. Asking for every loaded row
    // can exceed PostgREST's cap and misclassify older history as deleted.
    const count = PAGE_SIZE;
    const { data, error } = await readMessageWindow(supabase, familyId, convId, { cursor: older ? oldest : undefined, take: count + 1 });
    if (!alive.current || !owner.current.accepts(ticket)) return;
    if (error) {
      // Surface the failure rather than blanking the thread (which reads as
      // "no messages") — keep whatever is already on screen.
      toastError(describeDbError(error));
      setLoadError(describeDbError(error));
      setLoadingMsgs(false);
      setLoadingOlder(false);
      return;
    }
    const scroll = threadRef.current;
    const previousHeight = scroll?.scrollHeight ?? 0;
    if (!quiet || messagesRef.current.length <= count) setHasOlder((data?.length ?? 0) > count);
    const arrivedDuringLoad = [...liveRows.current.values()].filter((row) => eventBaseline.get(row.id) !== row);
    setMessages((current) => mergeThreadRows(
      older ? mergeThreadRows(current, (data ?? []).slice(0, count), convId) : reconcileLatestThreadRows(current, (data ?? []).slice(0, count), convId),
      arrivedDuringLoad, convId,
    ).filter((row) => !hardDeleted.current.has(row.id)));
    setLoadingMsgs(false);
    setLoadingOlder(false);
    requestAnimationFrame(() => {
      if (!owner.current.accepts(ticket)) return;
      if (older && scroll) scroll.scrollTop += scroll.scrollHeight - previousHeight;
      else if (!quiet) bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    });
  }, [familyId, toastError]);

  useEffect(() => {
    if (!activeConvId) return;
    void loadMessages(activeConvId);
  }, [activeConvId, loadMessages]);

  // ── Realtime for messages ───────────────────────────────────
  useEffect(() => {
    if (!activeConv) return;
    const convId = activeConv.id;
    const ticket = owner.current.capture();
    const supabase = createClient();
    setConnection('CONNECTING');
    const receive = (message: Message) => {
      if (!alive.current || !owner.current.current(ticket) || message.family_id !== familyId || message.conversation_id !== convId) return;
      liveRows.current.set(message.id, message);
      if (historyRef.current && !messagesRef.current.some((row) => row.id === message.id)) { void loadSummaries(); return; }
      setMessages((current) => mergeThreadRows(current, [message], convId));
      const scroll = threadRef.current;
      if (scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120) requestAnimationFrame(() => { if (owner.current.current(ticket)) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
      void loadSummaries();
    };
    const ch = ownChannel(supabase, `msgs:${activeConv.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'family_messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, (payload) => {
        receive(payload.new as Message);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'family_messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, (payload) => {
        receive(payload.new as Message);
      })
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'family_messages',
      }, (payload) => {
        if (!owner.current.current(ticket)) return;
        const id = (payload.old as { id: string }).id;
        hardDeleted.current.add(id);
        liveRows.current.delete(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
        void loadSummaries();
      })
      .subscribe((status) => {
        if (!owner.current.current(ticket)) return;
        setConnection(status);
        if (status === 'SUBSCRIBED') { void loadMessages(convId, false, true); void loadSummaries(); }
      });
    const recover = () => { if (document.visibilityState === 'visible' && owner.current.current(ticket)) { void loadMessages(convId, false, true); void loadSummaries(); } };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => { window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', recover); void supabase.removeChannel(ch); };
  }, [activeConv?.id, loadMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime for conversations ──────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const ch = ownChannel(supabase, `convs:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'family_conversations', filter: `family_id=eq.${familyId}` },
        () => { void loadConversations(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [familyId, loadConversations]);

  // ── Per-conversation previews + unread counts ───────────────
  // The membership-scoped overview returns exact unread counts across history.
  const loadSummaries = useCallback(async () => {
    const request = ++summaryRequest.current;
    const supabase = createClient();
    const { data, error } = await loadConversationSummaries(supabase, { familyId, userId });
    if (!alive.current || request !== summaryRequest.current) return;
    if (error || !data) {
      // Previews/unread badges are an enhancement over the conversation list;
      // on a failed load, surface it and keep the prior summaries rather than
      // silently wiping every preview + unread badge to zero.
      toastError(describeDbError(error));
      return;
    }
    setSummaries(data);
  }, [familyId, userId, toastError]);

  useEffect(() => { void loadSummaries(); }, [conversations, loadSummaries]);

  // Before 0476 there is no durable mute: fall back to main's device-local one.
  const fallBackToDeviceMutes = useCallback(() => {
    legacy0476Ref.current = true;
    setLegacy0476(true);
    setMutedIds(readDeviceMutes(familyId));
    setMuteLoading(false);
  }, [familyId]);

  useEffect(() => {
    if (!activeConvId || legacy0476Ref.current) return;
    const ticket = owner.current.begin('preference');
    const isCurrent = () => alive.current && owner.current.accepts(ticket);
    setMuteLoading(true);
    void settle(createClient().from('family_conversation_preferences').select('*').eq('conversation_id', activeConvId).eq('user_id', userId).maybeSingle()).then(({ data, error }) => {
      if (!isCurrent()) return;
      setMuteLoading(false);
      if (fellBackForMissing(error, MESSAGING_SCHEMA.conversationPreferences, MUTE_FALLBACK)) { fallBackToDeviceMutes(); return; }
      if (error) { toastError(describeDbError(error)); return; }
      setMutedIds((current) => { const next = new Set(current); if (data?.muted) next.add(activeConvId); else next.delete(activeConvId); return next; });
    });
  }, [activeConvId, userId, toastError, fallBackToDeviceMutes]);

  async function toggleMute() {
    if (!activeConvId || muteLoading) return;
    const convId = activeConvId;
    if (legacy0476) {
      const next = new Set(mutedIds);
      if (next.has(convId)) next.delete(convId); else next.add(convId);
      writeDeviceMutes(familyId, next);
      setMutedIds(next);
      return;
    }
    setMuteLoading(true);
    const { data, error } = await settle(createClient().from('family_conversation_preferences').upsert({ conversation_id: convId, user_id: userId, muted: !mutedIds.has(convId) }, { onConflict: 'conversation_id,user_id' }).select('*').single());
    if (!alive.current) return;
    if (owner.current.capture().conversationId === convId) setMuteLoading(false);
    if (fellBackForMissing(error, MESSAGING_SCHEMA.conversationPreferences, MUTE_FALLBACK)) {
      fallBackToDeviceMutes();
      toastError(tr('errors.thatChangeWasNotSaved'));
      return;
    }
    if (error || !data) { toastError(describeDbError(error)); return; }
    setMutedIds((current) => { const next = new Set(current); if (data.muted) next.add(convId); else next.delete(convId); return next; });
  }

  const threadVisible = pageVisible && (wide || mobileShowThread) && !showAbout && !historyGallery && !settingsOpen && !conversationAction;
  useEffect(() => {
    // Typing rides a private Realtime topic that only 0475 authorizes; main
    // had no typing indicator, so without 0475 there is none.
    if (!activeConvId || legacy0475) return;
    const ticket = owner.current.capture();
    const supabase = createClient();
    const typers = new Map<string, number>();
    const publish = () => { if (owner.current.current(ticket)) setTypingIds([...typers].filter(([, at]) => at > Date.now() - 6000).map(([id]) => id)); };
    const channel = supabase.channel(`messages:${activeConvId}`, { config: { private: true } })
      .on('broadcast', { event: 'typing' }, ({ payload }: { payload: { user_id?: string; typing?: boolean } }) => {
        if (!payload.user_id || payload.user_id === userId || !members.some((member) => member.user_id === payload.user_id)) return;
        if (payload.typing) typers.set(payload.user_id, Date.now()); else typers.delete(payload.user_id);
        publish();
      }).subscribe();
    typingChannel.current = channel;
    const timer = setInterval(publish, 1500);
    return () => { typingChannel.current = null; clearInterval(timer); setTypingIds([]); void supabase.removeChannel(channel); };
  }, [activeConvId, userId, members, legacy0475]);

  useEffect(() => {
    const channel = typingChannel.current;
    if (!channel) return;
    const send = (typing: boolean) => { void channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: userId, typing } }); };
    const timer = setTimeout(() => send(Boolean(text.trim()) && threadVisible), 250);
    const expiry = setTimeout(() => send(false), 4000);
    return () => { clearTimeout(timer); clearTimeout(expiry); send(false); };
  }, [text, threadVisible, userId, activeConv?.id]);
  useEffect(() => {
    const newest = messages[messages.length - 1];
    if (!activeConvId || !newest || viewingHistory || !threadVisible || !nearBottom || loadingMsgs || readPending.current || !messages.some((row) => !row.deleted_at && row.sender_id !== userId && !row.read_by?.includes(userId))) return;
    const ticket = owner.current.capture();
    const isCurrent = () => alive.current && owner.current.current(ticket);
    readPending.current = true;
    const supabase = createClient();
    void (async () => {
      const { error, legacy } = await markConversationReadThrough(supabase, { conversationId: activeConvId, messageId: newest.id, familyId, userId, rows: messages });
      if (!isCurrent()) return;
      if (legacy) setLegacy0475(true);
      readPending.current = false;
      if (error) { toastError(describeDbError(error)); return; }
      setMessages((rows) => rows.map((row) => {
        if (row.created_at > newest.created_at || (row.created_at === newest.created_at && row.id > newest.id)) return row;
        const read = { ...row, read_by: [...new Set([...(row.read_by ?? []), userId])] };
        liveRows.current.set(row.id, read);
        return read;
      }));
      void loadSummaries();
    })();
  }, [messages, activeConvId, familyId, threadVisible, nearBottom, loadingMsgs, userId, toastError, loadSummaries, viewingHistory]);

  // ── Presence: who in the family is online right now ─────────
  useEffect(() => {
    const supabase = createClient();
    // 0475 authorizes the private family topic; before it, the old public one.
    const ch = supabase.channel(`presence:family:${familyId}`, { config: legacy0475 ? { presence: { key: userId } } : { private: true, presence: { key: userId } } });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, Array<{ user_id?: string }>>;
      const ids = new Set<string>();
      Object.values(state).forEach((arr) => arr.forEach((p) => { if (p.user_id) ids.add(p.user_id); }));
      setOnlineIds(ids);
    }).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track({ user_id: userId, at: Date.now() });
    });
    return () => { void supabase.removeChannel(ch); };
  }, [familyId, userId, legacy0475]);

  function acceptMessage(message: Message) {
    if (!alive.current) return;
    if (owner.current.capture().conversationId === message.conversation_id) {
      liveRows.current.set(message.id, message);
      setMessages((rows) => mergeThreadRows(rows, [message], message.conversation_id));
    }
    void loadSummaries();
    void loadConversations();
  }

  function isCurrentMessageOrigin() {
    return alive.current && archiveScopeRef.current === archiveScope && archiveScope.active !== false
      && owner.current.current(messageOrigin) && activeConv?.id === messageOrigin.conversationId
      && activeConv?.family_id === familyId && sameArchiveRow(activeConversationRef.current, activeConv);
  }
  function isCurrentMessageOperation(operation: MessageOperation) {
    return alive.current && archiveScopeRef.current === operation.scope && operation.scope.active !== false
      && owner.current.current(operation.origin) && sameArchiveRow(activeConversationRef.current, operation.row);
  }
  function beginMessageOperation(): MessageOperation | null {
    if (!activeConv || !isCurrentMessageOrigin()) return null;
    return { origin: messageOrigin, scope: archiveScope, row: { ...activeConv }, request: ++sendRequest.current };
  }
  function confirmsMessage(message: Message, payload: Insertable<'family_messages'> & { id: string }) {
    return message.id === payload.id && message.family_id === payload.family_id && message.conversation_id === payload.conversation_id
      && message.sender_id === payload.sender_id && message.kind === payload.kind && message.content === (payload.content ?? null)
      && message.reply_to_id === (payload.reply_to_id ?? null) && message.attachment_url === (payload.attachment_url ?? null)
      && !message.deleted_at;
  }
  async function insertMessage(payload: Insertable<'family_messages'> & { id: string }, current: () => boolean): Promise<Message> {
    if (!current() || typeof payload.sender_id !== 'string' || !payload.sender_id
      || typeof payload.family_id !== 'string' || !payload.family_id
      || typeof payload.conversation_id !== 'string' || !payload.conversation_id) throw new Error(tr('messagesChat.sendUnconfirmed'));
    const supabase = createClient();
    const response = await supabase.from('family_messages').insert(payload).select('*').single();
    if (!current()) throw new Error(tr('messagesChat.sendUnconfirmed'));
    if (response.data && !response.error && confirmsMessage(response.data, payload)) return response.data;
    // Retain the same client id across retries. A retired visit must not issue
    // another read; its next current visit can reconcile an already saved row.
    const check = await supabase.from('family_messages').select('*').eq('id', payload.id).eq('family_id', payload.family_id).eq('conversation_id', payload.conversation_id).eq('sender_id', payload.sender_id).maybeSingle();
    if (!current()) throw new Error(tr('messagesChat.sendUnconfirmed'));
    if (check.data && !check.error && confirmsMessage(check.data, payload)) return check.data;
    throw response.error ?? check.error ?? new Error(tr('messagesChat.sendUnconfirmed'));
  }

  // ── Send message ───────────────────────────────────────────
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!isCurrentMessageOrigin() || draftRef.current !== renderedDraft || sending
      || sendFlight.current && isCurrentMessageOperation(sendFlight.current)) return;
    const content = renderedDraft.text.trim();
    if (!content || !activeConv || (activeConv.is_archived && !renderedDraft.edit)) return;
    if (content.length > 4000) { toastError(tr('validation.messageTooLong', { max: 4000 })); return; }
    const submitted = renderedDraft;
    if (submitted.edit && (submitted.edit.family_id !== familyId || submitted.edit.conversation_id !== activeConv.id || submitted.edit.sender_id !== userId)) return;
    const operation = beginMessageOperation(); if (!operation) return;
    sendFlight.current = operation;
    const current = () => isCurrentMessageOperation(operation) && sendFlight.current === operation;
    const convId = activeConv.id;
    const key = JSON.stringify([convId, content, submitted.reply?.id, submitted.edit?.id]);
    const id = sendIds.current.get(key) ?? crypto.randomUUID();
    sendIds.current.set(key, id);
    setSending(true);
    try {
      let message: Message;
      if (submitted.edit) {
        const { data, error } = await createClient().from('family_messages').update({ content }).eq('id', submitted.edit.id).eq('family_id', familyId).eq('sender_id', userId).eq('conversation_id', convId).is('deleted_at', null).select('*').single();
        if (!current()) return;
        if (error || !data || data.id !== submitted.edit.id || data.family_id !== familyId || data.conversation_id !== convId || data.sender_id !== userId || data.content !== content || data.deleted_at) throw error ?? new Error(tr('messagesChat.editFailed'));
        message = data;
      } else message = await insertMessage({
        id, conversation_id: convId, family_id: familyId, sender_id: userId, sender_name: myName,
        content, kind: 'text', reply_to_id: submitted.reply?.conversation_id === convId && submitted.reply.family_id === familyId ? submitted.reply.id : null,
      }, current);
      if (!current()) return;
      acceptMessage(message);
      sendIds.current.delete(key);
      const next = draftRef.current === submitted ? clearConfirmedDraft(submitted, submitted) : draftRef.current;
      drafts.current.set(convId, next);
      if (draftRef.current === submitted) {
        draftRef.current = next;
        setText(next.text); setReplyTo(next.reply); setEditMessage(next.edit);
        inputRef.current?.focus();
        requestAnimationFrame(() => { if (current()) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
      }
    } catch (err) { if (current()) toastError(describeDbError(err)); }
    finally {
      const stillCurrent = current();
      if (sendFlight.current === operation) sendFlight.current = null;
      if (stillCurrent) setSending(false);
    }
  }

  // ── Send a GIF (picked from the GIF popover) as an image message ───────────
  // GIFs reuse the image render path: a family_messages row with kind 'image'
  // and the (remote, Giphy-hosted) attachment_url — no storage upload needed.
  async function sendGif(url: string, title: string) {
    if (!isCurrentMessageOrigin() || draftRef.current !== renderedDraft || !activeConv || activeConv.is_archived
      || sendFlight.current && isCurrentMessageOperation(sendFlight.current)) return;
    const operation = beginMessageOperation(); if (!operation) return;
    sendFlight.current = operation;
    const current = () => isCurrentMessageOperation(operation) && sendFlight.current === operation;
    setShowGifPicker(false);
    const convId = activeConv.id;
    const reply = renderedDraft.reply?.conversation_id === convId && renderedDraft.reply.family_id === familyId ? renderedDraft.reply.id : null;
    const key = JSON.stringify([convId, url, reply]);
    const id = sendIds.current.get(key) ?? crypto.randomUUID();
    sendIds.current.set(key, id); setSending(true);
    try {
      const message = await insertMessage({ id, conversation_id: convId, family_id: familyId, sender_id: userId,
        sender_name: myName, content: title || 'GIF', kind: 'image', attachment_url: url, reply_to_id: reply }, current);
      if (!current()) return;
      acceptMessage(message); sendIds.current.delete(key);
      if (draftRef.current === renderedDraft) { draftRef.current = { ...renderedDraft, reply: null }; setReplyTo(null); }
    } catch (err) { if (current()) toastError(describeDbError(err)); }
    finally {
      const stillCurrent = current();
      if (sendFlight.current === operation) sendFlight.current = null;
      if (stillCurrent) setSending(false);
    }
  }

  // ── Send image/file ─────────────────────────────────────────
  const [uploadPending, setUploadingFile] = useState(false);
  const uploadFlight = useRef<MessageOperation | null>(null);
  const uploadingFile = uploadPending && uploadFlight.current !== null && isCurrentMessageOperation(uploadFlight.current);
  type AttachmentAttempt = { familyId: string; userId: string; file: File; convId: string; replyId: string | null; id: string; path: string; uploaded: boolean; discarding?: boolean };
  const [failedAttachment, setFailedAttachment] = useState<AttachmentAttempt | null>(null);
  const attachmentAttempts = useRef(new Map<string, AttachmentAttempt>());
  const failedAttachmentRef = useRef(failedAttachment);
  failedAttachmentRef.current = failedAttachment;
  const uploadLock = useRef(false);
  function rememberAttachment(attempt: AttachmentAttempt | null) {
    if (attempt) attachmentAttempts.current.set(attempt.convId, attempt);
    else if (failedAttachmentRef.current) attachmentAttempts.current.delete(failedAttachmentRef.current.convId);
    failedAttachmentRef.current = attempt; setFailedAttachment(attempt);
  }
  async function sendFile(file: File) {
    if (!isCurrentMessageOrigin() || draftRef.current !== renderedDraft || !activeConv || activeConv.is_archived || recording || requestingMic.current
      || uploadFlight.current && isCurrentMessageOperation(uploadFlight.current)) return;
    // 25 MB cap mirrors the storage bucket limit; fail fast with a clear message.
    if (file.size > 25 * 1024 * 1024) { toastError(tr('validation.fileTooLarge', { max: 25 })); return; }
    const previousAttempt = attachmentAttempts.current.get(activeConv.id);
    // Destructive cleanup remains pending even if its original visit retires.
    // Do not race an issued deletion by retrying or replacing its object.
    if (previousAttempt?.discarding) return;
    const attempt = previousAttempt?.file === file ? previousAttempt : {
      familyId, userId, file, convId: activeConv.id, replyId: renderedDraft.reply?.conversation_id === activeConv.id && renderedDraft.reply.family_id === familyId ? renderedDraft.reply.id : null,
      id: crypto.randomUUID(), path: familyMediaPath(familyId, `messages/${activeConv.id}/${userId}`, file.name), uploaded: false,
    };
    if (attempt.convId !== activeConv.id || attempt.familyId !== familyId || attempt.userId !== userId) return;
    const operation = beginMessageOperation(); if (!operation) return;
    uploadFlight.current = operation;
    const current = () => isCurrentMessageOperation(operation) && uploadFlight.current === operation;
    rememberAttachment(attempt);
    uploadLock.current = true;
    setUploadingFile(true);
    try {
      const supabase = createClient();
      if (!attempt.uploaded) {
        const { data: stored, error: upErr } = await supabase.storage.from('family-media').upload(attempt.path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
        if ((upErr || !stored) && String((upErr as { statusCode?: string } | null)?.statusCode) !== '409' && !/already exists/i.test(upErr?.message ?? '')) throw upErr ?? new Error(tr('messagesChat.uploadUnconfirmed'));
        attempt.uploaded = true;
      }
      if (!current()) return;
      const isImage = file.type.startsWith('image/');
      const isAudio = file.type.startsWith('audio/');
      const kind = isImage ? 'image' : isAudio ? 'audio' : 'file';
      const message = await insertMessage({
        id: attempt.id, conversation_id: attempt.convId,
        family_id: familyId,
        sender_id: userId,
        sender_name: myName,
        content: isImage || isAudio ? null : file.name,
        kind,
        attachment_url: attempt.path,
        attachment_name: file.name,
        attachment_mime: file.type,
        reply_to_id: attempt.replyId,
      }, current);
      if (!current()) return;
      acceptMessage(message);
      if (failedAttachmentRef.current === attempt) rememberAttachment(null);
      if (draftRef.current === renderedDraft) { draftRef.current = { ...renderedDraft, reply: null }; setReplyTo(null); }
    } catch (err) {
      if (current()) { rememberAttachment(attempt); toastError(describeDbError(err)); }
    } finally {
      const stillCurrent = current();
      if (uploadFlight.current === operation) { uploadFlight.current = null; uploadLock.current = false; }
      if (stillCurrent) setUploadingFile(false);
    }
  }

  async function discardAttachment() {
    if (!isCurrentMessageOrigin() || !failedAttachment || failedAttachment.discarding || uploadingFile || failedAttachment.convId !== activeConv?.id
      || failedAttachment.familyId !== familyId || failedAttachment.userId !== userId) return;
    const attempt = failedAttachment;
    const operation = beginMessageOperation(); if (!operation) return;
    const current = () => isCurrentMessageOperation(operation) && failedAttachmentRef.current === attempt;
    attempt.discarding = true;
    try {
    const supabase = createClient();
    const check = await settle(supabase.from('family_messages').select('*').eq('id', attempt.id).eq('family_id', familyId).eq('conversation_id', attempt.convId).eq('sender_id', userId).maybeSingle());
    if (!current()) return;
    if (check.error) { toastError(describeDbError(check.error)); return; }
    if (check.data) {
      if (check.data.id !== attempt.id || check.data.family_id !== familyId || check.data.conversation_id !== attempt.convId || check.data.sender_id !== userId) { toastError(tr('messagesChat.sendUnconfirmed')); return; }
      acceptMessage(check.data);
    } else if (attempt.uploaded) {
      // A transport/confirmation error can still mean the object was removed.
      // A later retry must re-upload (or safely reconcile an existing object).
      attempt.uploaded = false;
      const removal = await removeFamilyMedia(supabase, attempt.path);
      if (!current()) return;
      if (removal.error) { toastError(describeDbError(removal.error)); return; }
    }
    if (current()) rememberAttachment(null);
    } finally {
      attempt.discarding = false;
      if (current()) rememberAttachment(attempt);
    }
  }

  // ── Record voice message ─────────────────────────────────────
  // Uses MediaRecorder → uploads the clip through the same sendFile path
  // (kind 'audio'). Discardable, with a live timer; no extra deps.
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);
  const requestingMic = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const [micPending, setMicPending] = useState(false);

  async function startRecording() {
    if (!isCurrentMessageOrigin() || recording || requestingMic.current || uploadingFile || sending || !activeConv || activeConv.is_archived) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      toastError(tr('messagesModule.voiceRecordingIsnTSupported'));
      return;
    }
    const ticket = owner.current.capture();
    const request = ++micRequest.current;
    requestingMic.current = true;
    setMicPending(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current || !owner.current.current(ticket) || activeConversationRef.current?.is_archived) { releaseStream(stream); return; }
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => { if (alive.current && owner.current.current(ticket) && recorderRef.current === rec && e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        releaseStream(stream);
        if (!alive.current || !owner.current.current(ticket) || recorderRef.current !== rec) return;
        if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
        recorderRef.current = null;
        streamRef.current = null;
        if (alive.current) { setRecording(false); setRecSeconds(0); }
        if (discardRef.current || !alive.current || !owner.current.current(ticket)) { chunksRef.current = []; return; }
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        const ext = (type.split('/')[1] || 'webm').split(';')[0];
        await sendFile(new File([blob], `voice-${Date.now()}.${ext}`, { type }));
      };
      rec.onerror = () => { stopRecording(true); if (alive.current) toastError(tr('messagesChat.recordingFailed')); };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSeconds(0);
      const started = Date.now();
      recTimerRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        setRecSeconds(seconds);
        if (seconds >= 300) stopRecording(false);
      }, 1000);
    } catch {
      releaseStream(streamRef.current);
      streamRef.current = null;
      if (alive.current && owner.current.current(ticket)) toastError(tr('messagesModule.microphoneAccessWasBlocked'));
    } finally {
      if (alive.current && request === micRequest.current && owner.current.current(ticket)) { requestingMic.current = false; setMicPending(false); }
    }
  }
  const stopRecording = useCallback((discard = false) => {
    discardRef.current = discard;
    if (discard) {
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
      setRecording(false); setRecSeconds(0);
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    releaseStream(streamRef.current);
  }, [releaseStream]);
  useEffect(() => { if (activeConv?.is_archived) stopRecording(true); }, [activeConv?.is_archived, stopRecording]);
  useEffect(() => () => {
    discardRef.current = true;
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    releaseStream(streamRef.current);
  }, [releaseStream]);

  // ── React to message ─────────────────────────────────────────
  function sameMessageActionRow(current: Message | undefined, rendered: Message, action: 'delete' | 'pin' | 'reaction') {
    return !!current && current.id === rendered.id && current.family_id === rendered.family_id
      && current.conversation_id === rendered.conversation_id && current.sender_id === rendered.sender_id
      && !current.deleted_at && !rendered.deleted_at
      && (action !== 'pin' || current.is_pinned === rendered.is_pinned)
      && (action !== 'delete' || current.content === rendered.content && current.edited_at === rendered.edited_at)
      && (action !== 'reaction' || JSON.stringify(current.reactions) === JSON.stringify(rendered.reactions));
  }
  function beginMessageAction(message: Message, action: 'delete' | 'pin' | 'reaction') {
    if (!isCurrentMessageOrigin() || message.family_id !== familyId || message.conversation_id !== activeConv?.id
      || action === 'delete' && message.sender_id !== userId
      || !sameMessageActionRow(messagesRef.current.find(row => row.id === message.id), message, action)) return null;
    const previous = messageActionFlight.current.get(message.id);
    if (previous && isCurrentMessageOperation(previous)) return null;
    const operation = beginMessageOperation();
    if (operation) messageActionFlight.current.set(message.id, operation);
    return operation;
  }
  function currentMessageAction(operation: MessageOperation, message: Message, action: 'delete' | 'pin' | 'reaction') {
    return isCurrentMessageOperation(operation) && messageActionFlight.current.get(message.id) === operation
      && sameMessageActionRow(messagesRef.current.find(row => row.id === message.id), message, action);
  }
  function matchesMessageActionResult(result: Message, message: Message) {
    return result.id === message.id && result.family_id === message.family_id
      && result.conversation_id === message.conversation_id && result.sender_id === message.sender_id;
  }
  async function reactTo(msg: Message, emoji: string) {
    const operation = beginMessageAction(msg, 'reaction'); if (!operation) return;
    setMsgMenu(null);
    try {
      const { data, error, legacy } = await toggleMessageReaction(createClient(), { message: msg, emoji, userId, familyId });
      if (legacy) setLegacy0475(true);
      if (!currentMessageAction(operation, msg, 'reaction')) return;
      if (error) toastError(describeDbError(error));
      else if (!data || !matchesMessageActionResult(data, msg) || data.deleted_at) toastError(tr('errors.thatChangeWasNotSaved'));
      else acceptMessage(data);
    } finally { if (messageActionFlight.current.get(msg.id) === operation) messageActionFlight.current.delete(msg.id); }
  }

  // ── Delete message ──────────────────────────────────────────
  async function deleteMessage(msg: Message) {
    const operation = beginMessageAction(msg, 'delete'); if (!operation) return;
    setMsgMenu(null);
    try {
      const { data, error } = await settle(createClient().from('family_messages').update({ deleted_at: new Date().toISOString() }).eq('id', msg.id).eq('sender_id', userId).eq('family_id', familyId).eq('conversation_id', msg.conversation_id).is('deleted_at', null).select('*'));
      if (!currentMessageAction(operation, msg, 'delete')) return;
      if (error) toastError(describeDbError(error));
      else if (data?.length !== 1 || !matchesMessageActionResult(data[0], msg) || !data[0].deleted_at) toastError(tr('errors.thatChangeWasNotSaved'));
      else acceptMessage(data[0]);
    } finally { if (messageActionFlight.current.get(msg.id) === operation) messageActionFlight.current.delete(msg.id); }
  }

  // ── Pin message ─────────────────────────────────────────────
  async function pinMessage(msg: Message) {
    const operation = beginMessageAction(msg, 'pin'); if (!operation) return;
    setMsgMenu(null);
    try {
      const { data, error } = await settle(createClient().from('family_messages').update({ is_pinned: !msg.is_pinned }).eq('id', msg.id).eq('family_id', familyId).eq('conversation_id', msg.conversation_id).is('deleted_at', null).select('*'));
      if (!currentMessageAction(operation, msg, 'pin')) return;
      if (error) toastError(describeDbError(error));
      else if (data?.length !== 1 || !matchesMessageActionResult(data[0], msg) || data[0].deleted_at || data[0].is_pinned !== !msg.is_pinned) toastError(tr('errors.thatChangeWasNotSaved'));
      else acceptMessage(data[0]);
    } finally { if (messageActionFlight.current.get(msg.id) === operation) messageActionFlight.current.delete(msg.id); }
  }

  function selectConversation(conv: Conversation) {
    if (owner.current.capture().conversationId === conv.id) { setMobileShowThread(true); return; }
    const previous = owner.current.capture().conversationId;
    if (previous) drafts.current.set(previous, draftRef.current);
    stopRecording(true);
    sendRequest.current++; sendFlight.current = null; setSending(false);
    uploadFlight.current = null; uploadLock.current = false; setUploadingFile(false);
    const attachment = attachmentAttempts.current.get(conv.id) ?? null; failedAttachmentRef.current = attachment; setFailedAttachment(attachment);
    micRequest.current++; requestingMic.current = false; setMicPending(false);
    owner.current.select(conv.id);
    liveRows.current.clear();
    hardDeleted.current.clear();
    readPending.current = false;
    const draft = drafts.current.get(conv.id) ?? { text: '', reply: null, edit: null };
    setText(draft.text); setReplyTo(draft.reply); setEditMessage(draft.edit);
    setMsgMenu(null); setShowPicker(false); setShowGifPicker(false); setThreadSearch(''); setSearchResults([]);
    setHasOlder(false); setLoadingOlder(false); setLoadError(null); setNearBottom(true); setShowAbout(false);
    setHistoryGallery(null); retireArchiveAction(); setSettingsOpen(false); setReplyParents(new Map());
    setShowArchived(Boolean(conv.is_archived));
    setViewingHistory(false); historyRef.current = false;
    setActiveConv(conv);
    setMobileShowThread(true);
    setMessages([]);
    messagesRef.current = [];
  }

  useEffect(() => {
    if (!activeConvId || !threadSearch.trim()) { setSearchResults([]); setSearching(false); return; }
    const ticket = owner.current.begin('search');
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void createClient().from('family_messages').select('*').eq('family_id', familyId).eq('conversation_id', activeConvId)
        .is('deleted_at', null).ilike('content', `%${escapeLike(threadSearch.trim())}%`)
        .order('created_at', { ascending: false }).limit(100).abortSignal(controller.signal).then(({ data, error }) => {
          if (controller.signal.aborted || !owner.current.accepts(ticket)) return;
          setSearching(false);
          if (error) toastError(describeDbError(error));
          else setSearchResults(data ?? []);
        }, (error) => {
          if (controller.signal.aborted || !owner.current.accepts(ticket)) return;
          setSearching(false); toastError(describeDbError(error));
        });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeConvId, familyId, threadSearch, toastError]);

  const jumpOrigin = owner.current.capture();
  function isCurrentJump(message: Message) {
    return alive.current && owner.current.current(jumpOrigin) && Boolean(jumpOrigin.conversationId)
      && message.family_id === familyId && message.conversation_id === jumpOrigin.conversationId;
  }
  async function jumpToMessage(message: Message) {
    if (!isCurrentJump(message)) return;
    const ticket = owner.current.begin('jump');
    setThreadSearch(''); setShowAbout(false);
    if (!messagesRef.current.some((row) => row.id === message.id)) {
      const { data, error } = await readMessageWindow(createClient(), familyId, message.conversation_id, { cursor: message, inclusive: true, take: PAGE_SIZE + 1 });
      if (!owner.current.accepts(ticket)) return;
      if (error) { toastError(describeDbError(error)); return; }
      setMessages(mergeThreadRows([], (data ?? []).slice(0, PAGE_SIZE), message.conversation_id));
      setViewingHistory(true); historyRef.current = true;
      setHasOlder((data?.length ?? 0) > PAGE_SIZE);
    }
    requestAnimationFrame(() => { if (owner.current.accepts(ticket)) document.getElementById(`message-${message.id}`)?.scrollIntoView({ block: 'center' }); });
  }

  function sameArchiveRow(row: Conversation | null, snapshot: Pick<Conversation, 'id' | 'family_id' | 'created_by' | 'is_family_chat' | 'is_archived'> | null) {
    return row !== null && snapshot !== null && row.id === snapshot.id && row.family_id === snapshot.family_id
      && row.created_by === snapshot.created_by && row.is_family_chat === snapshot.is_family_chat && row.is_archived === snapshot.is_archived;
  }
  function canArchiveConversation() {
    return sameArchiveRow(activeConversationRef.current, activeConv) && alive.current && archiveScopeRef.current === archiveScope && archiveScope.active !== false
      && activeConv?.family_id === familyId && !activeConv.is_family_chat
      && (activeConv.created_by === userId || role === 'parent' || role === 'adult');
  }
  function openArchiveAction() {
    if (archiveCurrent.current !== (conversationAction?.ticket ?? null)
      || isCurrentArchiveAction() && archiveFlight.current === conversationAction?.ticket) return;
    if (!activeConv || !canArchiveConversation() || !owner.current.current(jumpOrigin) || owner.current.capture().conversationId !== activeConv.id) return;
    const ticket = ++archiveSequence.current;
    archiveCurrent.current = ticket;
    archiveFlight.current = null;
    setChangingConversation(false);
    setConversationAction({ ticket, conversationId: activeConv.id, origin: owner.current.capture(), scope: archiveScope, row: { id: activeConv.id, family_id: activeConv.family_id, created_by: activeConv.created_by, is_family_chat: activeConv.is_family_chat, is_archived: activeConv.is_archived } });
  }
  function isCurrentArchiveAction() {
    return canArchiveConversation() && conversationAction !== null && sameArchiveRow(activeConversationRef.current, conversationAction.row) && conversationAction.scope === archiveScope
      && archiveCurrent.current === conversationAction.ticket && owner.current.current(conversationAction.origin)
      && conversationAction.conversationId === activeConv?.id;
  }
  function retireArchiveAction() {
    archiveCurrent.current = null;
    archiveFlight.current = null;
    setConversationAction(null);
    setChangingConversation(false);
  }
  function closeArchiveAction() {
    if (!isCurrentArchiveAction() || archiveFlight.current === conversationAction?.ticket) return;
    retireArchiveAction();
  }
  async function archiveConversation() {
    if (!isCurrentArchiveAction() || !activeConv || !conversationAction || archiveFlight.current === conversationAction.ticket) return;
    const ticket = conversationAction.ticket;
    archiveFlight.current = ticket;
    const archived = !activeConv.is_archived;
    setChangingConversation(true);
    try {
      const { data, error } = await createClient().from('family_conversations').update({ is_archived: archived }).eq('id', activeConv.id).eq('family_id', familyId).select('*').single();
      if (!isCurrentArchiveAction()) return;
      if (error || !data || data.id !== activeConv.id || data.family_id !== familyId || data.is_archived !== archived) throw error ?? new Error(tr('errors.thatChangeWasNotSaved'));
      setActiveConv(data); setShowArchived(archived);
      retireArchiveAction();
      void loadConversations();
    } catch (error) { if (isCurrentArchiveAction()) toastError(describeDbError(error)); }
    finally {
      if (isCurrentArchiveAction() && archiveFlight.current === ticket) { archiveFlight.current = null; setChangingConversation(false); }
    }
  }

  // Quoted messages can predate the current page. Fetch only missing parents,
  // under the same conversation RLS, without treating them as loaded history.
  useEffect(() => {
    const ids = [...new Set(messages.map((message) => message.reply_to_id).filter((id): id is string => Boolean(id)))].filter((id) => !messages.some((message) => message.id === id));
    if (!activeConvId || !ids.length) { setReplyParents(new Map()); return; }
    const ticket = owner.current.begin('reply-parents');
    const controller = new AbortController();
    void settle(createClient().from('family_messages').select('*').eq('conversation_id', activeConvId).in('id', ids).abortSignal(controller.signal)).then(({ data, error }) => {
      if (!error && !controller.signal.aborted && owner.current.accepts(ticket)) setReplyParents(new Map((data ?? []).map((message) => [message.id, message])));
    });
    return () => controller.abort();
  }, [activeConvId, messages]);

  const q = search.trim().toLowerCase();
  const filtered = conversations.filter((c) => {
    if (Boolean(c.is_archived) !== showArchived) return false;
    if (!convMatchesTab(c.kind, tab)) return false;
    if (unreadOnly && !(summaries.unreadByConv.get(c.id) ?? 0)) return false;
    if (!q) return true;
    const last = summaries.lastByConv.get(c.id);
      return conversationName(c).toLowerCase().includes(q) ||
      (last ? previewText(last, userId).toLowerCase().includes(q) : false);
  });
  const archivedCount = conversations.filter((c) => c.is_archived).length;
  const totalUnread = [...summaries.unreadByConv.values()].reduce((a, b) => a + b, 0);

  // Photos shared in the active conversation → the "Shared Photos" rail.
  const sharedPhotos = useMemo(
    () => messages.filter((m) => !m.deleted_at && m.kind === 'image' && m.attachment_url).slice(-6).reverse(),
    [messages],
  );
  // SEC-001: attachments are private conversations. Every image, file and voice
  // note below is read through a URL signed with this viewer's session; a Giphy
  // link in the same field is external and passes through unchanged.
  const media = useFamilyMediaUrls(messages.map((m) => m.attachment_url));

  const grouped = messages.reduce<{ label: string; msgs: Message[] }[]>((acc, msg) => {
    const label = timeGroup(msg.created_at, fmtDate, clock);
    const last = acc[acc.length - 1];
    if (!last || last.label !== label) acc.push({ label, msgs: [msg] });
    else last.msgs.push(msg);
    return acc;
  }, []);

  // Resolve the active conversation's roster by family_member id (preferred) or
  // legacy user_id, so account-less members appear as full participants.
  const activeParticipants: Tables<'family_members'>[] = !activeConv ? [] : members.filter((member) =>
    activeConv.is_family_chat ? member.is_active : activeConv.participant_ids?.includes(member.id)
      || !!member.user_id && activeConv.member_ids?.includes(member.user_id)
      || (!activeConv.participant_ids?.length && !activeConv.member_ids?.length && member.user_id === activeConv.created_by));

  if (loadingConvs) return <SkeletonList />;
  if (inboxError && !conversations.length) return <div role="alert" className="rounded-xl border border-danger/40 p-4 text-sm"><p>{inboxError}</p><Button type="button" variant="ghost" onClick={() => { setLoadingConvs(true); void loadConversations(); }}>{tr('messagesChat.retryLoad')}</Button></div>;

  const memberCount = activeParticipants.length;
  const canManageConversation = activeConv && selfMember?.is_active !== false && (activeConv.created_by === userId || role === 'parent' || role === 'adult');

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-height)-1rem-4rem-var(--safe-bottom))] flex-col gap-4 lg:h-[calc(100dvh-var(--topbar-height)-1rem)]">
      {inboxError && <div role="alert" className="rounded-xl border border-danger/40 p-3 text-sm"><p>{inboxError}</p><Button type="button" variant="ghost" onClick={() => void loadConversations()}>{tr('messagesChat.retryLoad')}</Button></div>}
      {/* ── Page header ─────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{tr('messages.messages')}</h1>
          <p className="mt-0.5 text-xs text-muted sm:text-sm">{tr('messages.stayConnectedWithYourFamily')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setNewConvOpen(true)}><Plus className="h-4 w-4" /> {tr('messages.newMessage')}</Button>
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('messages.searchMessages')}
              aria-label={tr('messagesChat.searchConversations')}
              className="h-11 w-full sm:w-56 rounded-xl border border-border bg-surface/60 pl-9 pr-3 text-sm outline-none focus:border-brand" />
          </div>
        </div>
      </div>

      {/* ── 3-panel workspace ───────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-surface/30">

      {/* ── Conversation list ──────────────────────────────── */}
      <div className={cn(
        // Master-detail from md up (iPad portrait included) — below md one pane
        // shows at a time, toggled by mobileShowThread.
        'flex w-full flex-col border-r border-border md:w-72 lg:w-80 xl:w-[22rem]',
        mobileShowThread && 'hidden md:flex',
      )}>
        {/* Tabs + filter */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="flex flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
            {CONV_TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key} className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  tab === t.key ? 'bg-brand/15 text-brand-text' : 'text-muted hover:bg-elevated hover:text-fg')}>
                {tr(t.labelKey)}
              </button>
            ))}
          </div>
          <div className="relative">
            <button onClick={() => setFilterOpen((v) => !v)} aria-label={tr('messages.filterConversations')}
              className={cn('grid h-8 w-8 place-items-center rounded-lg border border-border text-muted hover:text-fg',
                unreadOnly && 'border-brand/50 text-brand-text')}>
              <SlidersHorizontal className="h-4 w-4" />
            </button>
            {filterOpen && (
              <>
                  <button className="fixed inset-0 z-10 cursor-default" aria-hidden tabIndex={-1} onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-glass">
                  <button onClick={() => { setUnreadOnly((v) => !v); setFilterOpen(false); }}
                    className="flex w-full items-center justify-between px-4 py-2 text-sm hover:bg-surface">
                    {tr('messages.unreadOnly')} {unreadOnly && <Check className="h-4 w-4 text-brand-text" />}
                  </button>
                  <button onClick={() => { setShowArchived((v) => !v); setFilterOpen(false); }}
                    className="flex w-full items-center justify-between px-4 py-2 text-sm hover:bg-surface">
                    {showArchived ? 'Hide archived' : 'Show archived'} <Archive className="h-4 w-4 text-muted" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <MessageCircle className="mb-2 h-8 w-8 text-muted/50" />
              <p className="text-sm text-muted">
                {showArchived ? 'No archived conversations' : unreadOnly ? 'No unread conversations' : 'No conversations yet'}
              </p>
            </div>
          ) : (
            filtered.map((conv) => {
              const isActive = activeConv?.id === conv.id;
              const last = summaries.lastByConv.get(conv.id);
              const unread = summaries.unreadByConv.get(conv.id) ?? 0;
              return (
                <button key={conv.id} onClick={() => selectConversation(conv)}
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-border/40 px-3 py-3 text-left transition',
                    isActive ? 'bg-brand/10' : 'hover:bg-elevated/30',
                  )}>
                  <div className={cn(
                    'grid h-12 w-12 flex-shrink-0 place-items-center rounded-full text-lg',
                    conv.kind === 'direct' ? 'bg-elevated' : 'bg-brand/20',
                  )}>
                    {conv.avatar_emoji ?? (conv.kind === 'direct' ? '💬' : '👨‍👩‍👧‍👦')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className={cn('truncate text-sm font-semibold', isActive && 'text-brand-text')}>
                        {conversationName(conv)}
                      </p>
                      {last && <span className="shrink-0 text-[11px] text-muted">{shortTime(last.created_at)}</span>}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className={cn('truncate text-xs', unread ? 'font-medium text-fg' : 'text-muted')}>
                        {last ? previewText(last, userId) : 'No messages yet'}
                      </p>
                      {unread > 0 && (
                        <span className="grid h-5 min-w-[1.25rem] shrink-0 place-items-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-brand-fg">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* View archived */}
        <button onClick={() => setShowArchived((v) => !v)}
          className="flex items-center justify-center gap-1.5 border-t border-border py-3 text-xs font-semibold text-brand-text hover:bg-elevated/30">
          {showArchived
            ? <><ArrowLeft className="h-3.5 w-3.5" /> {tr('messages.backToConversations')}</>
            : <>{tr('messages.viewArchivedConversations')} {archivedCount > 0 && `(${archivedCount})`} <ChevronRight className="h-3.5 w-3.5" /></>}
        </button>
      </div>

      {/* ── Message thread ─────────────────────────────────── */}
      <div className={cn(
        'flex flex-1 flex-col overflow-hidden',
        !mobileShowThread && 'hidden md:flex',
      )}>
        {!activeConv ? (
          <div className="flex flex-1 flex-col items-center justify-center">
            <MessageCircle className="mb-3 h-12 w-12 text-muted/40" />
            <p className="text-sm font-medium text-muted">{tr('messages.selectAConversation')}</p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <button onClick={() => setMobileShowThread(false)} className="md:hidden mr-1 text-muted" aria-label={tr('messages.backToConversations')}>
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="grid h-10 w-10 place-items-center rounded-full bg-brand/20 text-lg">
                {activeConv.avatar_emoji ?? '💬'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{conversationName(activeConv)}</p>
                <p className="truncate text-[11px] text-muted">
                  {activeConv.kind === 'direct'
                    ? (onlineIds.has(activeParticipants.find((m) => m.user_id !== userId)?.user_id ?? '') ? 'Active now' : 'Direct message')
                    : `${memberCount} members`}
                </p>
              </div>
              <AiInsight kind="messages" params={{ conversationId: activeConv.id }} variant="ghost" iconOnly />
              {/* A "Start video call" and a "Start voice call" button used to sit
                  here. They rendered unconditionally, were styled exactly like
                  the working "About this chat" button beside them, carried
                  affirmative labels, and their only effect was an ERROR toast
                  saying the feature does not exist (F-F10).

                  That is the one place in the signed-in app that advertised a
                  capability it does not have, and it contradicted a rule this
                  repo states about itself twice — lib/constants/navigation.ts:
                  "No 'coming soon' stubs: if a console section isn't built yet,
                  it isn't listed." The capability-gated surfaces that do it
                  right read the capability and simply do not offer the control:
                  /wallet/cards passes caps.issuing and caps.physicalCards down
                  rather than rendering a button that apologises.

                  Removed rather than disabled. A greyed-out control still makes
                  the promise; the absence of one makes none. */}
              <button onClick={() => setShowAbout(true)} aria-label={tr('messages.aboutThisChat')}
                className="rounded-lg p-1.5 text-muted hover:text-fg"><Info className="h-4 w-4" /></button>
            </div>

            {connection !== 'SUBSCRIBED' && <div role="status" className="flex items-center justify-between gap-2 bg-elevated px-4 py-2 text-xs text-muted"><span>{connection === 'CONNECTING' ? tr('messagesChat.connecting') : tr('messagesChat.interrupted')}</span><button type="button" onClick={() => void loadMessages(activeConv.id, false, true)} className="rounded p-2 hover:text-fg" aria-label={tr('messagesChat.refresh')}><RefreshCw className="h-4 w-4" /></button></div>}
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <Search className="h-4 w-4 shrink-0 text-muted" />
              <input ref={threadSearchRef} value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} aria-label={tr('messagesChat.searchThread')} placeholder={tr('messagesChat.searchThread')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
              {threadSearch && <button type="button" onClick={() => setThreadSearch('')} aria-label={tr('messagesChat.clearSearch')}><X className="h-4 w-4" /></button>}
            </div>
            {viewingHistory && <button type="button" onClick={() => { setViewingHistory(false); historyRef.current = false; setMessages([]); messagesRef.current = []; void loadMessages(activeConv.id); }} className="border-b border-border px-4 py-2 text-sm text-brand-text">{tr('messagesChat.latest')}</button>}
            {threadSearch && <div className="max-h-56 overflow-y-auto border-b border-border p-3" aria-label={tr('messagesChat.searchResults')} aria-live="polite">
              {searching ? <p className="text-sm text-muted">{tr('messagesChat.searching')}</p> : searchResults.length === 0 ? <p className="text-sm text-muted">{tr('messagesChat.noMatches')}</p> : <>{searchResults.length === 100 && <p className="text-xs text-muted">{tr('messagesChat.searchLimit')}</p>}{searchResults.map((message) => <button type="button" key={message.id} onClick={() => void jumpToMessage(message)} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-elevated"><span className="block text-xs text-muted">{message.sender_name} · {fmtDate(message.created_at, 'MMM d, h:mm a')}</span><span className="block truncate text-sm">{message.content}</span></button>)}</>}
            </div>}

            {/* Messages */}
            <div ref={threadRef} onScroll={(event) => { const node = event.currentTarget; setNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 120); }} aria-label={tr('messagesChat.messageList')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-1">
              {loadError && <div role="alert" className="rounded-xl border border-danger/40 p-3 text-sm"><p>{loadError}</p><button type="button" onClick={() => void loadMessages(activeConv.id)} className="mt-2 font-semibold">{tr('messagesChat.retryLoad')}</button></div>}
              {hasOlder && <div className="text-center"><Button variant="ghost" disabled={loadingOlder} onClick={() => void loadMessages(activeConv.id, true)}>{loadingOlder ? tr('messagesChat.loadingOlder') : tr('messagesChat.loadOlder')}</Button></div>}
              {loadingMsgs ? (
                <SkeletonList />
              ) : messages.length === 0 && !loadError ? (
                <EmptyState icon={MessageCircle} title={tr('messages.noMessagesYet')}
                  description={tr('messagesModule.sayHelloToYourFamily')} />
              ) : (
                grouped.map(({ label, msgs }) => (
                  <div key={label}>
                    {/* Date divider */}
                    <div className="my-4 flex items-center gap-3">
                      <div className="h-px flex-1 bg-border/50" />
                      <span className="rounded-full bg-elevated px-3 py-1 text-[11px] text-muted">{label}</span>
                      <div className="h-px flex-1 bg-border/50" />
                    </div>

                    {msgs.map((msg, i) => {
                      const isMine = msg.sender_id === userId;
                      const prevMsg = msgs[i - 1];
                      const sameSender = prevMsg?.sender_id === msg.sender_id;
                      const reactions = (msg.reactions as Record<string, string[]>) ?? {};
                      const replyMsg = msg.reply_to_id ? messages.find((m) => m.id === msg.reply_to_id) ?? replyParents.get(msg.reply_to_id) : null;

                      return (
                        <div key={msg.id} id={`message-${msg.id}`}
                          className={cn('group relative flex', isMine ? 'flex-row-reverse' : 'flex-row', !sameSender && 'mt-3')}>

                          {/* Avatar */}
                          {!isMine && !sameSender && (
                            <div className="mr-2 mt-auto flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-xs font-bold">
                              {(msg.sender_name ?? '?')[0].toUpperCase()}
                            </div>
                          )}
                          {!isMine && sameSender && <div className="mr-2 w-7" />}

                          <div className={cn('flex max-w-[75%] flex-col', isMine && 'items-end')}>
                            {/* Sender name (incl. "You" on own messages, matching the mock) */}
                            {!sameSender && (
                              <span className={cn('mb-0.5 text-[11px] font-semibold',
                                isMine ? 'mr-1 text-muted' : 'ml-1 text-brand-text')}>
                                {isMine ? `${myName} (You)` : (msg.sender_name ?? 'Family member')}
                              </span>
                            )}

                            {/* Reply preview */}
                            {replyMsg && (
                              <div className={cn(
                                'mb-1 rounded-lg border-l-2 border-brand/60 bg-elevated/60 px-3 py-1.5 text-xs text-muted',
                                isMine ? 'border-r-2 border-l-0 text-right' : '',
                              )}>
                                <span className="font-semibold text-brand-text/80">{replyMsg.sender_name}</span>
                                <p className="truncate">{replyMsg.deleted_at ? tr('messages.messageDeleted') : replyMsg.content || previewText(replyMsg, userId)}</p>
                              </div>
                            )}

                            {/* Bubble */}
                            {msg.deleted_at ? (
                              <div className="rounded-2xl bg-elevated/40 px-4 py-2 text-xs italic text-muted">
                                {tr('messages.messageDeleted')}
                              </div>
                            ) : (
                              <div className={cn(
                                'relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                                isMine
                                  ? 'rounded-br-md bg-brand text-brand-fg'
                                  : 'rounded-bl-md bg-elevated text-fg',
                                sameSender && isMine && 'rounded-tr-md',
                                sameSender && !isMine && 'rounded-tl-md',
                              )}>
                                {/* Image */}
                                {msg.kind === 'image' && msg.attachment_url && (
                                  <a href={media(msg.attachment_url) ?? undefined} target="_blank" rel="noreferrer">
                                    <FamilyMediaImg src={msg.attachment_url} alt={msg.attachment_name ?? 'Photo'}
                                      className="mb-2 max-h-56 rounded-xl object-cover"
                                      fallback={<span className="mb-2 block h-40 w-56 max-w-full rounded-xl bg-surface/40" />} />
                                  </a>
                                )}
                                {/* File — download card */}
                                {msg.kind === 'file' && msg.attachment_url && (
                                  <a href={media(msg.attachment_url) ?? undefined} target="_blank" rel="noreferrer" download
                                    aria-disabled={media(msg.attachment_url) ? undefined : true}
                                    className={cn(
                                      'flex min-w-[13rem] items-center gap-3 rounded-xl border p-2.5',
                                      isMine ? 'border-brand-fg/25 bg-brand-fg/10' : 'border-border bg-surface/50',
                                    )}>
                                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
                                      <FileText className="h-5 w-5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium">{msg.attachment_name ?? 'File'}</span>
                                      <span className="block text-[11px] opacity-70">
                                        {(msg.attachment_mime?.split('/')[1] ?? 'file').toUpperCase()}
                                      </span>
                                    </span>
                                    <Download className="h-4 w-4 shrink-0 opacity-70" />
                                  </a>
                                )}
                                {/* Voice message — inline audio player ('voice' is the
                                    legacy/seed kind; 'audio' is what the recorder sends). */}
                                {(msg.kind === 'audio' || msg.kind === 'voice') && msg.attachment_url && (
                                  <audio controls preload="none" src={media(msg.attachment_url) ?? undefined}
                                    className="mb-1 h-10 w-56 max-w-full" aria-label={tr('messages.voiceMessage')} />
                                )}
                                {/* Text */}
                                {msg.is_pinned && <span className="mb-1 flex items-center gap-1 text-[11px]"><Pin className="h-3 w-3" /> {tr('messagesChat.pinned')}</span>}
                                {msg.content && <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{msg.content}</span>}

                                {/* Timestamp inside bubble */}
                                <span className={cn('ml-2 text-[10px] opacity-60', isMine ? 'text-brand-fg' : 'text-muted')}>
                                  {fmtDate(msg.created_at, 'h:mm a')}
                                  {msg.edited_at && <span> · {tr('messagesChat.edited')}</span>}
                                  {isMine && (messageReadByOthers(msg.read_by, msg.sender_id) ? <span title={tr('messagesChat.read')} aria-label={tr('messagesChat.read')}><CheckCheck className="ml-0.5 inline h-3 w-3" /></span> : <span title={tr('messagesChat.sent')} aria-label={tr('messagesChat.sent')}><Check className="ml-0.5 inline h-3 w-3" /></span>)}
                                </span>
                              </div>
                            )}

                            {/* Reactions */}
                            {!msg.deleted_at && Object.keys(reactions).length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {Object.entries(reactions).map(([emoji, users]) =>
                                  users.length > 0 ? (
                                    <button key={emoji} onClick={() => reactTo(msg, emoji)} aria-label={tr('messagesChat.reactionCount', { emoji, count: users.length })} aria-pressed={users.includes(userId)}
                                      className={cn(
                                        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition',
                                        users.includes(userId)
                                          ? 'border-brand/50 bg-brand/15 text-brand-text'
                                          : 'border-border bg-elevated hover:bg-elevated/70',
                                      )}>
                                      {emoji} {users.length}
                                    </button>
                                  ) : null
                                )}
                              </div>
                            )}
                          </div>

                          {/* Hover actions */}
                          {!msg.deleted_at && <div className="relative flex items-start gap-0.5 px-1">
                            {REACTIONS.slice(0, 3).map((emoji) => (
                              <button key={emoji} onClick={() => reactTo(msg, emoji)} aria-label={tr('messagesChat.react', { emoji })}
                                className="hidden xl:block rounded-full bg-elevated px-1.5 py-0.5 text-sm hover:bg-border transition">
                                {emoji}
                              </button>
                            ))}
                            <button aria-label={tr('a11y.reply')} onClick={() => { draftRef.current = { ...draftRef.current, reply: msg, edit: null }; setReplyTo(msg); setEditMessage(null); inputRef.current?.focus(); }}
                              className="hidden xl:block rounded-full bg-elevated p-1.5 text-muted hover:text-fg transition">
                              <Reply className="h-3.5 w-3.5" />
                            </button>
                            <button aria-label={tr('a11y.moreActions')} aria-expanded={msgMenu === msg.id} onClick={() => setMsgMenu(msgMenu === msg.id ? null : msg.id)}
                              className="rounded-full bg-elevated p-2.5 text-muted hover:text-fg transition focus-visible:ring-2 focus-visible:ring-brand">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                            {/* Dropdown */}
                            {msgMenu === msg.id && (
                              <div className={cn(
                                'absolute top-7 z-20 rounded-xl border border-border bg-elevated shadow-xl min-w-[140px]',
                                isMine ? 'left-0' : 'right-0',
                              )}>
                                <div className="flex border-b border-border p-1">{REACTIONS.map((emoji) => <button type="button" key={emoji} aria-label={tr('messagesChat.react', { emoji })} onClick={() => void reactTo(msg, emoji)} className="rounded p-1.5 hover:bg-surface">{emoji}</button>)}</div>
                                <button onClick={() => pinMessage(msg)} className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface/40">
                                  <Pin className="h-3.5 w-3.5" /> {msg.is_pinned ? 'Unpin' : 'Pin'}
                                </button>
                                <button onClick={() => { draftRef.current = { ...draftRef.current, reply: msg, edit: null }; setReplyTo(msg); setEditMessage(null); setMsgMenu(null); inputRef.current?.focus(); }} className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface/40">
                                  <Reply className="h-3.5 w-3.5" /> {tr('messages.reply')}
                                </button>
                                {isMine && (
                                  <>
                                  {msg.kind === 'text' && <button type="button" onClick={() => { draftRef.current = { ...draftRef.current, edit: msg, reply: null, text: msg.content ?? '' }; setEditMessage(msg); setReplyTo(null); setText(msg.content ?? ''); setMsgMenu(null); inputRef.current?.focus(); }} className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface/40"><Pencil className="h-3.5 w-3.5" /> {tr('messagesChat.edit')}</button>}
                                  <button onClick={() => deleteMessage(msg)} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-danger hover:bg-surface/40">
                                    <Trash2 className="h-3.5 w-3.5" /> {tr('messages.delete')}
                                  </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>

            {/* Reply banner */}
            {replyTo && (
              <div className="flex items-center gap-2 border-t border-brand/20 bg-brand/5 px-4 py-2 text-xs">
                <Reply className="h-3.5 w-3.5 text-brand-text" />
                <span className="flex-1 truncate text-muted">
                  {tr('messages.replyingTo')} <span className="font-semibold text-brand-text">{replyTo.sender_name}</span>:{' '}
                  <span>{replyTo.content?.slice(0, 60)}</span>
                </span>
                <button onClick={() => { draftRef.current = { ...draftRef.current, reply: null }; setReplyTo(null); }} aria-label={tr('messagesChat.cancelReply')} className="text-muted hover:text-fg">✕</button>
              </div>
            )}

            {editMessage && <div className="flex items-center justify-between gap-2 border-t border-brand/20 bg-brand/5 px-4 py-2 text-xs"><span>{tr('messagesChat.editing')}</span><button type="button" aria-label={tr('messagesChat.cancelEdit')} onClick={() => { draftRef.current = { ...draftRef.current, edit: null, text: '' }; setEditMessage(null); setText(''); }}><X className="h-4 w-4" /></button></div>}
            {!uploadingFile && failedAttachment?.convId === activeConv.id && <div role="alert" className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs"><span className="flex-1">{tr('messagesChat.attachmentUnconfirmed', { name: failedAttachment.file.name })}</span><button type="button" disabled={uploadingFile} onClick={() => void sendFile(failedAttachment.file)} className="font-semibold">{tr('messagesChat.retryAttachment')}</button><button type="button" disabled={uploadingFile} onClick={() => void discardAttachment()} className="text-muted">{tr('messagesChat.discard')}</button></div>}
            {typingIds.length > 0 && <p role="status" className="px-4 py-1 text-xs text-muted">{tr('messagesChat.typing', { names: typingIds.map((id) => members.find((member) => member.user_id === id)?.display_name).filter(Boolean).join(', ') })}</p>}

            {/* Input */}
            {activeConv.is_archived && <p role="status" className="border-t border-border px-4 py-2 text-xs text-muted">{tr('messagesChat.archivedReadOnly')}</p>}
            <form onSubmit={sendMessage} className="flex shrink-0 items-end gap-2 border-t border-border bg-surface/50 px-3 py-2 sm:px-4 sm:py-3">
              <fieldset disabled={Boolean(activeConv.is_archived && !editMessage)} className="contents">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-2xl border border-border bg-elevated px-3 py-1.5 focus-within:border-brand/50">
                {/* Hidden file inputs */}
                <input ref={fileRef} type="file" accept="application/pdf,.doc,.docx,.xls,.xlsx,.txt,image/*"
                  className="hidden" onChange={(e) => { if (e.target.files?.[0]) sendFile(e.target.files[0]); e.target.value = ''; }} />
                <input ref={imageRef} type="file" accept="image/*"
                  className="hidden" onChange={(e) => { if (e.target.files?.[0]) sendFile(e.target.files[0]); e.target.value = ''; }} />

                {/* Text input */}
                <textarea ref={inputRef} value={text} onChange={(e) => { draftRef.current = { ...draftRef.current, text: e.target.value }; setText(e.target.value); }} rows={2} maxLength={4000} disabled={recording || micPending}
                  onKeyDown={(e) => { if (shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void sendMessage(e); } }}
                  enterKeyHint="send"
                  aria-label={tr('messages.typeAMessage')}
                  placeholder={tr('messages.typeAMessage')}
                  className="max-h-40 min-w-0 basis-full resize-y bg-transparent px-1 py-1.5 text-sm placeholder:text-muted focus:outline-none disabled:opacity-50" />

                {/* Trailing tools */}
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingFile || recording || micPending || Boolean(editMessage) || Boolean(failedAttachment)} aria-label={tr('messages.attachFile')}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg disabled:opacity-50">
                  {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </button>
                <button type="button" onClick={() => imageRef.current?.click()} disabled={uploadingFile || recording || micPending || Boolean(editMessage) || Boolean(failedAttachment)} aria-label={tr('messages.sendAPhoto')}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg disabled:opacity-50">
                  <ImageIcon className="h-4 w-4" />
                </button>
                <div className="relative">
                  <button type="button" disabled={recording || micPending} onClick={() => setShowPicker(!showPicker)} aria-label={tr('messages.emoji')} aria-expanded={showPicker}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg">
                    <Smile className="h-4 w-4" />
                  </button>
                  {showPicker && (
                    <div className="absolute bottom-11 left-0 z-20 rounded-xl border border-border bg-elevated p-2 shadow-xl">
                      <div className="grid grid-cols-4 gap-1">
                        {QUICK_EMOJIS.map((e) => (
                          <button key={e} type="button" onClick={() => { const next = draftRef.current.text + e; draftRef.current = { ...draftRef.current, text: next }; setText(next); setShowPicker(false); inputRef.current?.focus(); }}
                            className="h-8 w-8 rounded-lg text-lg hover:bg-surface transition">{e}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button type="button" disabled={recording || micPending || sending || Boolean(editMessage)} onClick={() => { setShowGifPicker((v) => !v); setShowPicker(false); }} aria-label="GIF" aria-expanded={showGifPicker}
                    className="grid h-8 shrink-0 place-items-center rounded-full px-2 text-[11px] font-bold text-muted transition hover:bg-surface hover:text-fg">
                    GIF
                  </button>
                  {showGifPicker && <GifPicker onPick={(url, title) => void sendGif(url, title)} onClose={() => setShowGifPicker(false)} />}
                </div>
              </div>

              {/* Send when typing · recording controls while recording · mic when empty */}
              {text.trim() && !recording ? (
                <button type="submit" disabled={sending} aria-label={tr('messages.sendMessage')}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                  {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </button>
              ) : recording ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={() => stopRecording(true)} aria-label={tr('messages.cancelRecording')}
                    className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-rose-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-rose-400" aria-live="polite">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                    {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
                  </span>
                  <button type="button" onClick={() => stopRecording(false)} aria-label={tr('messages.stopAndSendVoiceMessage')}
                    className="grid h-11 w-11 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90">
                    <Send className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <button type="button" onClick={startRecording} disabled={uploadingFile || micPending || sending || Boolean(failedAttachment)} aria-label={tr('messages.recordVoiceMessage')}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                  {uploadingFile || micPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
                </button>
              )}
              </fieldset>
            </form>
          </>
        )}
      </div>

      {/* ── About this chat ─────────────────────────────────── */}
      {activeConv && (
        <aside className={cn(
          'flex-col gap-5 overflow-y-auto border-l border-border bg-surface/20 p-5',
          showAbout
            ? 'fixed inset-0 z-40 flex w-full bg-bg pt-[calc(1.25rem+var(--safe-top))] xl:relative xl:inset-auto xl:z-auto xl:w-80 xl:bg-surface/20 xl:pt-5'
            : 'hidden xl:flex xl:w-80',
        )}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{tr('messages.aboutThisChat')}</h2>
            <button onClick={() => setShowAbout(false)} className="rounded-lg p-1 text-muted hover:text-fg xl:hidden" aria-label={tr('messages.close')}>
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Group card */}
          <div>
            <div className="mb-3 flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand/20 text-xl">
                {activeConv.avatar_emoji ?? (activeConv.kind === 'direct' ? '💬' : '👨‍👩‍👧‍👦')}
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold">{conversationName(activeConv)}</p>
                <p className="text-xs text-muted">
                  {activeConv.kind === 'direct' ? tr('messages.directMessage') : memberCount === 1 ? tr('messages.familyGroupOne') : tr('messages.familyGroupMany', { n: memberCount })}
                </p>
              </div>
            </div>
            {activeConv.description && <p className="text-sm text-muted">{activeConv.description}</p>}
          </div>

          {/* Actions */}
          <div className="grid grid-cols-3 gap-1 border-y border-border py-3 text-center text-[11px] text-muted">

            <button onClick={() => { setShowAbout(false); threadSearchRef.current?.focus(); }} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg">
              <Search className="h-5 w-5" /> {tr('messages.search')}
            </button>
            <button type="button" onClick={() => void toggleMute()} disabled={muteLoading} aria-pressed={mutedIds.has(activeConv.id)} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg disabled:opacity-50"><BellOff className="h-5 w-5" />{mutedIds.has(activeConv.id) ? tr('messagesChat.unmute') : tr('messagesChat.mute')}</button>
            {canManageConversation && !activeConv.is_family_chat && <button type="button" onClick={openArchiveAction} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg"><Archive className="h-5 w-5" />{activeConv.is_archived ? tr('messagesChat.restore') : tr('messagesChat.archive')}</button>}
            {canManageConversation && activeConv.kind !== 'direct' && <button type="button" onClick={() => setSettingsOpen(true)} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg">
              <Settings className="h-5 w-5" /> {tr('messages.settings')}
            </button>}

          </div>

          {/* Members */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">{tr('messages.members')}{activeConv.kind === 'direct' ? Math.max(memberCount, activeParticipants.length) : memberCount})</h3>

            </div>
            <div className="space-y-2.5">
              {activeParticipants.map((m) => {
                const online = m.user_id ? onlineIds.has(m.user_id) : false;
                const isSelf = m.user_id === userId;
                return (
                  <div key={m.id} className="group flex items-center gap-3">
                    <div className="relative shrink-0">
                      <Avatar name={m.display_name} color={m.color} size={36} />
                      {online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-emerald-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.display_name}{isSelf && <span className="text-muted"> (You)</span>}</p>
                      <p className="truncate text-xs text-muted">{roleLabel(tr, m.role)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Shared Photos */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">{tr('messages.sharedPhotos')}</h3>
              <button type="button" onClick={() => setHistoryGallery('photos')} aria-label={tr('messagesChat.allPhotos')} className="text-xs font-semibold text-brand-text">{tr('messagesChat.viewAll')}</button>
            </div>
            {sharedPhotos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border py-4 text-center text-xs text-muted">
                {tr('messages.photosSharedInThisChatAppear')}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {sharedPhotos.map((p) => (
                  <a key={p.id} href={media(p.attachment_url) ?? undefined} target="_blank" rel="noreferrer"
                    className="aspect-square overflow-hidden rounded-lg bg-elevated">
                    <FamilyMediaImg src={p.attachment_url} alt={p.attachment_name ?? 'Shared photo'} className="h-full w-full object-cover" />
                  </a>
                ))}
              </div>
            )}
          </div>
          <div><div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-semibold">{tr('messagesChat.pinnedLoaded')}</h3><button type="button" onClick={() => setHistoryGallery('pinned')} aria-label={tr('messagesChat.pinnedHistory')} className="shrink-0 text-xs font-semibold text-brand-text">{tr('messagesChat.viewAll')}</button></div>{messages.filter((message) => message.is_pinned && !message.deleted_at).map((message) => <button key={message.id} type="button" onClick={() => void jumpToMessage(message)} className="mb-1 block w-full rounded-lg border border-border p-2 text-left text-xs"><span className="font-semibold">{message.sender_name}</span><span className="block truncate">{message.content || previewText(message, userId)}</span></button>)}</div>
        </aside>
      )}
      </div>

      {/* New Conversation */}
      {newConvOpen && (
        <NewConversation
          familyId={familyId}
          userId={userId}
          members={members}
          myName={myName}
          onClose={() => setNewConvOpen(false)}
          onCreated={(conv) => {
            selectConversation(conv);
            setNewConvOpen(false);
            void loadConversations();
          }}
        />
      )}
      {settingsOpen && activeConv && <ConversationSettings conversation={activeConv} members={members} userId={userId} onClose={() => setSettingsOpen(false)} onSaved={(conv) => { if (owner.current.capture().conversationId === conv.id) setActiveConv(conv); setSettingsOpen(false); void loadConversations(); }} />}
      {historyGallery && activeConv && <ConversationHistory key={`${activeConv.id}:${historyGallery}`} familyId={familyId} conversationId={activeConv.id} kind={historyGallery} userId={userId} onClose={() => setHistoryGallery(null)} onJump={(message) => { if (!isCurrentJump(message)) return; setHistoryGallery(null); void jumpToMessage(message); }} />}
      {conversationAction && activeConv && isCurrentArchiveAction() && <Modal open onClose={closeArchiveAction} title={tr('messagesChat.confirmArchive')} description={tr('messagesChat.archiveConfirm')}><div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={changingConversation} onClick={closeArchiveAction}>{tr('messagesChat.cancel')}</Button><Button type="button" loading={changingConversation} onClick={() => void archiveConversation()}>{tr(activeConv.is_archived ? 'messagesChat.restore' : 'messagesChat.archive')}</Button></div></Modal>}
    </div>
  );
}

// ── New Conversation (multi-select, smart groups, two-step) ──────────────────

type Member = Tables<'family_members'>;

/** Pins/photos query the entire accessible history, not just the open page. */
function ConversationHistory({ familyId, conversationId, kind, userId, onClose, onJump }: {
  familyId: string; conversationId: string; kind: 'photos' | 'pinned'; userId: string; onClose: () => void; onJump: (message: Message) => void;
}) {
  const tr = useTranslations();
  const [rows, setRows] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const media = useFamilyMediaUrls(rows.map((row) => row.attachment_url));
  const load = useCallback(async (cursor?: Message) => {
    const current = ++request.current;
    setLoading(true); setError(null);
    const { data, error: failure } = await readMessageWindow(createClient(), familyId, conversationId, { cursor, kind, take: 51 });
    if (current !== request.current) return;
    setLoading(false);
    if (failure) { setError(describeDbError(failure)); return; }
    setMore((data?.length ?? 0) > 50);
    setRows((previous) => mergeThreadRows(cursor ? previous : [], (data ?? []).slice(0, 50), conversationId).reverse());
  }, [familyId, conversationId, kind]);
  useEffect(() => { const requests = request; void load(); return () => { requests.current++; }; }, [load]);
  return <Modal open onClose={onClose} title={tr(kind === 'photos' ? 'messagesChat.allPhotos' : 'messagesChat.pinnedHistory')}>
    {error && <div role="alert" className="mb-3 text-sm text-danger">{error}<Button type="button" variant="ghost" onClick={() => void load(rows.at(-1))}>{tr('messagesChat.historyRetry')}</Button></div>}
    {!loading && !error && !rows.length && <p className="py-4 text-sm text-muted">{tr('messagesChat.emptyHistory')}</p>}
    <div className={kind === 'photos' ? 'grid grid-cols-2 gap-3 sm:grid-cols-3' : 'space-y-2'}>{rows.map((message) => kind === 'photos' ? <a key={message.id} href={media(message.attachment_url) ?? undefined} target="_blank" rel="noreferrer" className="min-w-0 overflow-hidden rounded-xl border border-border"><FamilyMediaImg src={message.attachment_url} alt={message.attachment_name ?? tr('messages.sharedPhotos')} className="aspect-square w-full object-cover" /><span className="block truncate p-2 text-xs">{message.attachment_name || message.sender_name}</span></a> : <button key={message.id} type="button" onClick={() => onJump(message)} className="block w-full rounded-xl border border-border p-3 text-left"><span className="block text-xs font-semibold">{message.sender_name}</span><span className="block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.content || previewText(message, userId)}</span></button>)}</div>
    {(loading || more) && <Button type="button" variant="ghost" loading={loading} onClick={() => void load(rows.at(-1))} className="mt-3 w-full">{tr('messagesChat.olderResults')}</Button>}
  </Modal>;
}

function ConversationSettings({ conversation, members, userId, onClose, onSaved }: {
  conversation: Conversation; members: Member[]; userId: string; onClose: () => void; onSaved: (conv: Conversation) => void;
}) {
  const { error: toastError } = useToast();
  const [name, setName] = useState(conversation.name ?? '');
  const tr = useTranslations();
  const [description, setDescription] = useState(conversation.description ?? '');
  const [saving, setSaving] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      const patch = { name: name.trim(), description: description.trim() || null };
      const { data, error } = await createClient().from('family_conversations').update(patch).eq('id', conversation.id).eq('family_id', conversation.family_id).select('*').single();
      if (error || !data) throw error ?? new Error(tr('messagesChat.settingsFailed'));
      onSaved(data);
    } catch (error) { toastError(describeDbError(error)); }
    finally { setSaving(false); }
  }
  return <Modal open onClose={onClose} title={tr('messagesChat.settings')}><form onSubmit={save} className="space-y-4">
    <label className="block text-sm">{tr('messagesChat.name')}<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required /></label>
    <label className="block text-sm">{tr('messagesChat.description')}<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} className="mt-1 w-full rounded-xl border border-border bg-elevated p-3" /></label>
    {conversation.is_family_chat && <p className="text-sm text-muted">{tr('messagesChat.familyRoster')}</p>}
    <p className="text-xs text-muted">{tr('messagesChat.membershipNotice')}</p>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} type="button">{tr('messagesChat.cancel')}</Button><Button type="submit" loading={saving} disabled={!name.trim()}>{tr('messagesChat.saveSettings')}</Button></div>
  </form></Modal>;
}

const CONV_EMOJIS = ['💬', '👨‍👩‍👧‍👦', '🏠', '📅', '🎉', '🛒', '📚', '⚽', '🎮', '🏖️', '❤️', '🍕'];

/** Smart, role-derived groups for one-tap multi-select. */
const SMART_GROUPS: { key: string; labelKey: string; emoji: string; roles: MemberRole[] | null }[] = [
  { key: 'everyone', labelKey: 'messagesModule.group.everyone', emoji: '👨‍👩‍👧‍👦', roles: null },
  { key: 'parents', labelKey: 'messagesModule.group.parents', emoji: '🧑‍🤝‍🧑', roles: ['parent', 'adult'] },
  { key: 'kids', labelKey: 'messagesModule.group.kids', emoji: '🧒', roles: ['teen', 'child'] },
  { key: 'household', labelKey: 'messagesModule.group.household', emoji: '🏠', roles: ['parent', 'adult', 'teen', 'child'] },
];

type Step = 'people' | 'details';
type Tab = 'suggested' | 'contacts' | 'groups';

function NewConversation({ familyId, userId, members, myName, onClose, onCreated }: {
  familyId: string; userId: string;
  members: Member[];
  myName: string;
  onClose: () => void;
  onCreated: (conv: Conversation) => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [step, setStep] = useState<Step>('people');
  const [tab, setTab] = useState<Tab>('suggested');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()); // family_member.id
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('💬');
  const [loading, setLoading] = useState(false);

  const others = members.filter((m) => m.is_active && m.user_id !== userId);
  const byId = new Map(members.map((m) => [m.id, m]));
  const selectedMembers = [...selected].map((id) => byId.get(id)).filter(Boolean) as Member[];

  const groupMembers = useCallback(
    (roles: MemberRole[] | null) => (roles ? others.filter((m) => roles.includes(m.role)) : others),
    [others],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGroup(roles: MemberRole[] | null) {
    const ids = groupMembers(roles).map((m) => m.id);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  const q = search.trim().toLowerCase();
  const peopleList = (tab === 'contacts'
    ? [...others].sort((a, b) => a.display_name.localeCompare(b.display_name))
    : others
  ).filter((m) => !q || m.display_name.toLowerCase().includes(q));

  async function create() {
    if (selected.size === 0 || loading) return;
    setLoading(true);

    const selfMemberId = members.find((m) => m.user_id === userId)?.id;
    // member_ids = account holders (user_ids), for read/access logic.
    const memberIds = [...new Set([
      userId,
      ...selectedMembers.map((m) => m.user_id).filter(Boolean) as string[],
    ])];
    // participant_ids = the full roster by family_member id (incl. account-less).
    const participantIds = [...new Set([
      ...(selfMemberId ? [selfMemberId] : []),
      ...selectedMembers.map((m) => m.id),
    ])];
    const isDirect = selectedMembers.length === 1;

    // The RPC checks both recorded rosters before reusing a direct chat.

    const convName = name.trim() || (isDirect
      ? selectedMembers[0].display_name
      : [myName, ...selectedMembers.map((m) => firstName(m.display_name))].slice(0, 3).join(', ') +
        (selectedMembers.length > 2 ? ` +${selectedMembers.length - 2}` : ''));

    try {
    const { data, error } = await createConversation({
      family_id: familyId,
      name: convName,
      kind: isDirect ? 'direct' : 'group',
      avatar_emoji: isDirect ? null : emoji,
      created_by: userId,
      member_ids: memberIds,
      participant_ids: participantIds,
    });

    setLoading(false);
    if (error || !data) { toastError(describeDbError(error, tr('messagesModule.couldNotCreateConversation'))); return; }
    onCreated(data);
    } catch (error) { toastError(describeDbError(error)); }
    finally { setLoading(false); }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('messages.newConversation')}
      description={step === 'people' ? 'Start a conversation with the people who matter most.' : 'Name it and pick an icon (optional).'}
      className="max-w-2xl"
    >
      {step === 'people' ? (
        <div className="space-y-4">
          {/* To: chips + search */}
          <div className="rounded-xl border border-border bg-surface/40 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="pl-1 text-xs font-semibold text-muted">To:</span>
              {selectedMembers.map((m) => (
                <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-brand/15 py-1 pl-1 pr-2 text-xs font-medium text-brand-text">
                  <Avatar name={m.display_name} color={m.color} size={18} />
                  {firstName(m.display_name)}
                  <button onClick={() => toggle(m.id)} aria-label={tr('itemAction.remove', { name: m.display_name })} className="rounded-full hover:text-fg">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                aria-label={tr('messagesChat.findMembers')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={selectedMembers.length ? tr('uiText.addMore') : tr('uiText.searchPeopleOrGroups')}
                className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted"
              />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            {(['suggested', 'contacts', 'groups'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={cn(
                  'relative px-3 py-2 text-sm font-medium capitalize transition',
                  tab === t ? 'text-brand-text' : 'text-muted hover:text-fg',
                )}>
                {t}
                {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="max-h-[42vh] overflow-y-auto pr-1">
            {tab === 'groups' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {SMART_GROUPS.map((g) => {
                  const gm = groupMembers(g.roles);
                  const on = gm.length > 0 && gm.every((m) => selected.has(m.id));
                  return (
                    <button key={g.key} onClick={() => toggleGroup(g.roles)} disabled={gm.length === 0}
                      className={cn(
                        'flex items-center gap-3 rounded-xl border p-3 text-left transition disabled:opacity-40',
                        on ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:bg-elevated',
                      )}>
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elevated text-lg">{g.emoji}</div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{tr(g.labelKey)}</p>
                        <p className="truncate text-xs text-muted">
                          {gm.length === 0 ? 'No members' : gm.map((m) => firstName(m.display_name)).join(', ')}
                        </p>
                      </div>
                      <SelectDot on={on} />
                    </button>
                  );
                })}
              </div>
            ) : peopleList.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">
                {others.length === 0 ? 'Invite family members in Settings to start chatting.' : 'No people match your search.'}
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {peopleList.map((m) => {
                  const on = selected.has(m.id);
                  return (
                    <button key={m.id} onClick={() => toggle(m.id)}
                      className={cn(
                        'flex items-center gap-3 rounded-xl border p-2.5 text-left transition',
                        on ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:bg-elevated',
                      )}>
                      <Avatar name={m.display_name} color={m.color} size={38} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{m.display_name}</p>
                        <p className="truncate text-xs text-muted">{roleLabel(tr, m.role)}</p>
                      </div>
                      <SelectDot on={on} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-xs text-muted">
              {selected.size === 0 ? 'Select at least one person' : `${selected.size} selected`}
            </p>
            <Button onClick={() => setStep('details')} disabled={selected.size === 0}>
              {tr('messages.next')} {selected.size > 0 && `(${selected.size})`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Icon + name */}
          <div className="flex items-center gap-3">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand/15 text-2xl">{emoji}</div>
            <div className="flex-1">
              <Input
                aria-label={tr('messagesChat.name')}
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={selectedMembers.length === 1 ? selectedMembers[0].display_name : 'Conversation name (optional)'}
                autoFocus
              />
            </div>
          </div>

          {/* Icon picker (skip for 1:1 DMs) */}
          {selectedMembers.length > 1 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
                <Camera className="h-3.5 w-3.5" /> {tr('messages.chooseAnIcon')}
              </p>
              <div className="flex flex-wrap gap-2">
                {CONV_EMOJIS.map((e) => (
                  <button key={e} type="button" onClick={() => setEmoji(e)}
                    className={cn('rounded-xl p-2 text-lg transition hover:bg-elevated', emoji === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Members */}
          <div>
            <p className="mb-2 text-xs font-semibold text-muted">{tr('messages.members')}{selectedMembers.length + 1})</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2">
                <Avatar name={myName} size={32} />
                <p className="flex-1 truncate text-sm font-medium">{myName}</p>
                <span className="text-xs text-muted">You</span>
              </div>
              {selectedMembers.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2">
                  <Avatar name={m.display_name} color={m.color} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.display_name}</p>
                    <p className="truncate text-xs text-muted">{roleLabel(tr, m.role)}</p>
                  </div>
                  <button onClick={() => toggle(m.id)} aria-label={tr('itemAction.remove', { name: m.display_name })} className="rounded-lg p-1.5 text-muted hover:text-danger">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => setStep('people')}>
              <ArrowLeft className="h-4 w-4" /> {tr('messages.back')}
            </Button>
            <Button onClick={create} loading={loading} disabled={selectedMembers.length === 0}>
              {selectedMembers.length === 1 ? 'Start chatting' : 'Create'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The +/✓ select toggle used in the people grid. */
function SelectDot({ on }: { on: boolean }) {
  return (
    <span className={cn(
      'grid h-6 w-6 shrink-0 place-items-center rounded-full border transition',
      on ? 'border-brand bg-brand text-brand-fg' : 'border-border text-muted',
    )}>
      {on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
    </span>
  );
}
