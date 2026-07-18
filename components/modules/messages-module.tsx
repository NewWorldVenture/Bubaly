'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageCircle, Plus, Send, Smile, Paperclip, Reply, Pin, Trash2,
  MoreHorizontal, CheckCheck, ArrowLeft, Search, X, Camera, Loader2,
  Check, Phone, Video, Info, Settings, UserPlus, SlidersHorizontal, Mic,
  Image as ImageIcon, BellOff, Archive, ChevronRight, FileText, Download,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { AiInsight } from '@/components/ai/ai-insight';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { GifPicker } from '@/components/messages/gif-picker';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { fmtDate, firstName } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import {
  convMatchesTab, previewText, shortTime, summarizeConversations, type ConvTab,
} from '@/lib/messages/overview';
import type { Tables, MemberRole } from '@/lib/database.types';

type Conversation = Tables<'family_conversations'>;
type Message = Tables<'family_messages'>;

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
const QUICK_EMOJIS = ['😀', '🎉', '👏', '✅', '🙏', '💪', '🤣', '😍'];

const CONV_TABS: { key: ConvTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'direct', label: 'Direct' },
  { key: 'group', label: 'Groups' },
  { key: 'announcement', label: 'Announcements' },
];

function timeGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff < 1) return 'Today';
  if (diff < 2) return 'Yesterday';
  return fmtDate(iso, 'MMMM d, yyyy');
}

type ConvInsert = {
  family_id: string; name: string | null; kind: string;
  avatar_emoji: string | null; created_by: string;
  member_ids: string[]; participant_ids: string[];
};

/**
 * Insert a conversation, tolerating databases where the participant_ids column
 * hasn't been migrated yet (0017): on a schema error we retry without it so the
 * flow keeps working, just without account-less-member tracking.
 */
async function createConversation(payload: ConvInsert) {
  const supabase = createClient();
  let res = await supabase.from('family_conversations').insert(payload).select('*').single();
  if (res.error && /participant_ids|schema cache|column/i.test(res.error.message)) {
    const legacy: Omit<ConvInsert, 'participant_ids'> = {
      family_id: payload.family_id,
      name: payload.name,
      kind: payload.kind,
      avatar_emoji: payload.avatar_emoji,
      created_by: payload.created_by,
      member_ids: payload.member_ids,
    };
    res = await supabase.from('family_conversations').insert(legacy).select('*').single();
  }
  return res;
}

export function MessagesModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { error: toastError } = useToast();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
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
  const [summaries, setSummaries] = useState<ReturnType<typeof summarizeConversations>>(
    { lastByConv: new Map(), unreadByConv: new Map() },
  );
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [showAbout, setShowAbout] = useState(false); // mobile drawer for the About panel
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const myName = selfMember?.display_name ?? 'You';

  // ── Load conversations ──────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('family_conversations')
      .select('*')
      .eq('family_id', familyId)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (error) {
      // Fail visibly instead of showing an empty inbox on a failed load — an empty
      // list here would make the user think they have no conversations.
      toastError(describeDbError(error));
      setLoadingConvs(false);
      return;
    }
    const rows = data ?? [];
    setConversations(rows);
    setLoadingConvs(false);
    // auto-select first or Family Chat
    if (!activeConv && rows.length > 0) {
      const group = rows.find((c) => c.kind === 'group' && !c.name?.includes('DM')) ?? rows[0];
      setActiveConv(group);
    }
  }, [familyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  // ── Ensure Family Chat exists ───────────────────────────────
  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('family_conversations')
        .select('id')
        .eq('family_id', familyId)
        .eq('kind', 'group')
        .limit(1);
      // If the existence check itself failed, don't treat that as "no chat" and
      // create a DUPLICATE Family Chat — bail out and let the next load retry.
      if (error) return;
      if (!data?.length) {
        await createConversation({
          family_id: familyId,
          name: 'Family Chat',
          kind: 'group',
          avatar_emoji: '👨‍👩‍👧‍👦',
          created_by: userId,
          member_ids: members.map((m) => m.user_id).filter(Boolean) as string[],
          participant_ids: members.map((m) => m.id),
        });
        void loadConversations();
      }
    })();
  }, [familyId, userId, members, loadConversations]);

  // ── Load messages for active conv ──────────────────────────
  const loadMessages = useCallback(async (convId: string) => {
    setLoadingMsgs(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from('family_messages')
      .select('*')
      .eq('conversation_id', convId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) {
      // Surface the failure rather than blanking the thread (which reads as
      // "no messages") — keep whatever is already on screen.
      toastError(describeDbError(error));
      setLoadingMsgs(false);
      return;
    }
    setMessages(data ?? []);
    setLoadingMsgs(false);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    // Mark as read — APPEND me to read_by, never replace it. The old
    // update({ read_by: [me] }) overwrote the array and erased every other
    // reader's receipt. Preferred path is the 0163 RPC (single set-based
    // append); pre-migration we fall back to a correct per-row merge over the
    // rows just loaded.
    void (async () => {
      const { error: rpcErr } = await supabase.rpc('mark_conversation_read', { p_conversation_id: convId });
      if (!rpcErr) return;
      const unread = (data ?? []).filter((m) => !(m.read_by ?? []).includes(userId)).slice(-100);
      for (const m of unread) {
        await supabase.from('family_messages')
          .update({ read_by: [...(m.read_by ?? []), userId] })
          .eq('id', m.id);
      }
    })();
  }, [userId]);

  useEffect(() => {
    if (!activeConv) return;
    void loadMessages(activeConv.id);
  }, [activeConv, loadMessages]);

  // ── Realtime for messages ───────────────────────────────────
  useEffect(() => {
    if (!activeConv) return;
    const supabase = createClient();
    const ch = supabase
      .channel(`msgs:${activeConv.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'family_messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, (payload) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === (payload.new as Message).id)) return prev;
          return [...prev, payload.new as Message];
        });
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'family_messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, (payload) => {
        setMessages((prev) => prev.map((m) => m.id === (payload.new as Message).id ? payload.new as Message : m));
      })
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'family_messages',
      }, (payload) => {
        setMessages((prev) => prev.filter((m) => m.id !== (payload.old as { id: string }).id));
      })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [activeConv]);

  // ── Realtime for conversations ──────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase
      .channel(`convs:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'family_conversations', filter: `family_id=eq.${familyId}` },
        () => { void loadConversations(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [familyId, loadConversations]);

  // ── Per-conversation previews + unread counts ───────────────
  // One bounded scan of the family's recent messages powers every row's last
  // message preview and unread badge. Refreshed whenever conversations change
  // (the last-message trigger bumps family_conversations on every send).
  const loadSummaries = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('family_messages')
      .select('conversation_id, content, kind, attachment_name, sender_name, sender_id, created_at, read_by')
      .eq('family_id', familyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(400);
    if (error) {
      // Previews/unread badges are an enhancement over the conversation list;
      // on a failed load, surface it and keep the prior summaries rather than
      // silently wiping every preview + unread badge to zero.
      toastError(describeDbError(error));
      return;
    }
    setSummaries(summarizeConversations(data ?? [], userId));
  }, [familyId, userId]);

  useEffect(() => { void loadSummaries(); }, [conversations, loadSummaries]);

  // ── Presence: who in the family is online right now ─────────
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`presence:family:${familyId}`, { config: { presence: { key: userId } } });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, Array<{ user_id?: string }>>;
      const ids = new Set<string>();
      Object.values(state).forEach((arr) => arr.forEach((p) => { if (p.user_id) ids.add(p.user_id); }));
      setOnlineIds(ids);
    }).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track({ user_id: userId, at: Date.now() });
    });
    return () => { void supabase.removeChannel(ch); };
  }, [familyId, userId]);

  // ── Per-conversation mute (device-local preference) ─────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`muted-convs:${familyId}`);
      if (raw) setMutedIds(new Set(JSON.parse(raw) as string[]));
    } catch { /* ignore */ }
  }, [familyId]);

  const toggleMute = useCallback((convId: string) => {
    setMutedIds((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId); else next.add(convId);
      try { localStorage.setItem(`muted-convs:${familyId}`, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, [familyId]);

  // ── Send message ───────────────────────────────────────────
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || !activeConv || sending) return;
    if (content.length > 4000) { toastError('Message is too long (max 4000 characters)'); return; }
    const prevReplyTo = replyTo;
    setSending(true);
    setText('');
    setReplyTo(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('family_messages').insert({
        conversation_id: activeConv.id,
        family_id: familyId,
        sender_id: userId,
        sender_name: myName,
        content,
        kind: 'text',
        reply_to_id: prevReplyTo?.id ?? null,
      });
      if (error) {
        // Restore the unsent message so the user doesn't lose their text.
        toastError(describeDbError(error));
        setText(content);
        setReplyTo(prevReplyTo);
      } else {
        inputRef.current?.focus();
      }
    } catch (err) {
      toastError(describeDbError(err));
      setText(content);
      setReplyTo(prevReplyTo);
    } finally {
      setSending(false);
    }
  }

  // ── Send a GIF (picked from the GIF popover) as an image message ───────────
  // GIFs reuse the image render path: a family_messages row with kind 'image'
  // and the (remote, Giphy-hosted) attachment_url — no storage upload needed.
  async function sendGif(url: string, title: string) {
    if (!activeConv || sending) return;
    setShowGifPicker(false);
    setSending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('family_messages').insert({
        conversation_id: activeConv.id,
        family_id: familyId,
        sender_id: userId,
        sender_name: myName,
        content: title || 'GIF',
        kind: 'image',
        attachment_url: url,
      });
      if (error) toastError(describeDbError(error));
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setSending(false);
    }
  }

  // ── Send image/file ─────────────────────────────────────────
  const [uploadingFile, setUploadingFile] = useState(false);
  async function sendFile(file: File) {
    if (!activeConv || uploadingFile) return;
    // 25 MB cap mirrors the storage bucket limit; fail fast with a clear message.
    if (file.size > 25 * 1024 * 1024) { toastError('File is too large (max 25 MB)'); return; }
    setUploadingFile(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop();
      const path = `${familyId}/messages/${Date.now()}.${ext}`;
      const { data: stored, error: upErr } = await supabase.storage.from('family-media').upload(path, file, { upsert: false });
      if (upErr || !stored) { toastError(describeDbError(upErr)); return; }
      const { data: { publicUrl } } = supabase.storage.from('family-media').getPublicUrl(stored.path);
      const isImage = file.type.startsWith('image/');
      const isAudio = file.type.startsWith('audio/');
      const kind = isImage ? 'image' : isAudio ? 'audio' : 'file';
      const { error: insErr } = await supabase.from('family_messages').insert({
        conversation_id: activeConv.id,
        family_id: familyId,
        sender_id: userId,
        sender_name: myName,
        content: isImage || isAudio ? null : file.name,
        kind,
        attachment_url: publicUrl,
        attachment_name: file.name,
        attachment_mime: file.type,
      });
      if (insErr) {
        // Roll back the orphaned upload if the message row failed to insert.
        await supabase.storage.from('family-media').remove([stored.path]);
        toastError(describeDbError(insErr));
      }
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setUploadingFile(false);
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

  async function startRecording() {
    if (recording || uploadingFile || !activeConv) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      toastError('Voice recording isn’t supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
        setRecording(false);
        setRecSeconds(0);
        if (discardRef.current) { chunksRef.current = []; return; }
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        const ext = (type.split('/')[1] || 'webm').split(';')[0];
        await sendFile(new File([blob], `voice-${Date.now()}.${ext}`, { type }));
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSeconds(0);
      recTimerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch {
      toastError('Microphone access was blocked.');
    }
  }
  function stopRecording(discard = false) {
    discardRef.current = discard;
    recorderRef.current?.stop();
  }
  useEffect(() => () => { if (recTimerRef.current) clearInterval(recTimerRef.current); }, []);

  // ── React to message ─────────────────────────────────────────
  async function reactTo(msg: Message, emoji: string) {
    const current = (msg.reactions as Record<string, string[]>) ?? {};
    const existing = current[emoji] ?? [];
    const updated = existing.includes(userId)
      ? { ...current, [emoji]: existing.filter((u) => u !== userId) }
      : { ...current, [emoji]: [...existing, userId] };
    // remove keys with empty arrays
    for (const k of Object.keys(updated)) { if (!updated[k].length) delete updated[k]; }
    setMsgMenu(null);
    const { error } = await createClient().from('family_messages').update({ reactions: updated }).eq('id', msg.id);
    if (error) toastError(describeDbError(error));
  }

  // ── Delete message ──────────────────────────────────────────
  async function deleteMessage(id: string) {
    setMsgMenu(null);
    const { error } = await createClient().from('family_messages').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('sender_id', userId);
    if (error) toastError(describeDbError(error));
  }

  // ── Pin message ─────────────────────────────────────────────
  async function pinMessage(msg: Message) {
    setMsgMenu(null);
    const { error } = await createClient().from('family_messages').update({ is_pinned: !msg.is_pinned }).eq('id', msg.id);
    if (error) toastError(describeDbError(error));
  }

  function selectConversation(conv: Conversation) {
    setActiveConv(conv);
    setMobileShowThread(true);
    setMessages([]);
  }

  const q = search.trim().toLowerCase();
  const filtered = conversations.filter((c) => {
    if (Boolean(c.is_archived) !== showArchived) return false;
    if (!convMatchesTab(c.kind, tab)) return false;
    if (unreadOnly && !(summaries.unreadByConv.get(c.id) ?? 0)) return false;
    if (!q) return true;
    const last = summaries.lastByConv.get(c.id);
    return (c.name ?? '').toLowerCase().includes(q) ||
      (last ? previewText(last, userId).toLowerCase().includes(q) : false);
  });
  const archivedCount = conversations.filter((c) => c.is_archived).length;
  const totalUnread = [...summaries.unreadByConv.values()].reduce((a, b) => a + b, 0);

  // Photos shared in the active conversation → the "Shared Photos" rail.
  const sharedPhotos = useMemo(
    () => messages.filter((m) => m.kind === 'image' && m.attachment_url).slice(-6).reverse(),
    [messages],
  );

  const grouped = messages.reduce<{ label: string; msgs: Message[] }[]>((acc, msg) => {
    const label = timeGroup(msg.created_at);
    const last = acc[acc.length - 1];
    if (!last || last.label !== label) acc.push({ label, msgs: [msg] });
    else last.msgs.push(msg);
    return acc;
  }, []);

  // Resolve the active conversation's roster by family_member id (preferred) or
  // legacy user_id, so account-less members appear as full participants.
  const activeParticipants: Tables<'family_members'>[] = !activeConv
    ? []
    : (activeConv.participant_ids?.length
        ? activeConv.participant_ids.map((id) => members.find((m) => m.id === id))
        : (activeConv.member_ids ?? []).map((uid) => members.find((m) => m.user_id === uid))
      ).filter(Boolean) as Tables<'family_members'>[];

  if (loadingConvs) return <SkeletonList />;

  const memberCount = activeConv
    ? (activeConv.participant_ids?.length || activeConv.member_ids?.length || activeParticipants.length || members.length)
    : 0;
  const isMuted = activeConv ? mutedIds.has(activeConv.id) : false;

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-height)-1rem-4rem-var(--safe-bottom))] flex-col gap-4 lg:h-[calc(100dvh-var(--topbar-height)-1rem)]">
      {/* ── Page header ─────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Messages</h1>
          <p className="mt-0.5 text-xs text-muted sm:text-sm">Stay connected with your family.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setNewConvOpen(true)}><Plus className="h-4 w-4" /> New Message</Button>
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search messages"
              className="h-11 w-56 rounded-xl border border-border bg-surface/60 pl-9 pr-3 text-sm outline-none focus:border-brand" />
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
                className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  tab === t.key ? 'bg-brand/15 text-brand-text' : 'text-muted hover:bg-elevated hover:text-fg')}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <button onClick={() => setFilterOpen((v) => !v)} aria-label="Filter conversations"
              className={cn('grid h-8 w-8 place-items-center rounded-lg border border-border text-muted hover:text-fg',
                unreadOnly && 'border-brand/50 text-brand-text')}>
              <SlidersHorizontal className="h-4 w-4" />
            </button>
            {filterOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-glass">
                  <button onClick={() => { setUnreadOnly((v) => !v); setFilterOpen(false); }}
                    className="flex w-full items-center justify-between px-4 py-2 text-sm hover:bg-surface">
                    Unread only {unreadOnly && <Check className="h-4 w-4 text-brand-text" />}
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
                        {conv.name ?? 'Direct Message'}
                      </p>
                      {last && <span className="shrink-0 text-[11px] text-muted">{shortTime(last.created_at)}</span>}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className={cn('truncate text-xs', unread ? 'font-medium text-fg' : 'text-muted')}>
                        {last ? previewText(last, userId) : 'No messages yet'}
                      </p>
                      {mutedIds.has(conv.id) && <BellOff className="h-3 w-3 shrink-0 text-muted/60" />}
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
            ? <><ArrowLeft className="h-3.5 w-3.5" /> Back to conversations</>
            : <>View archived conversations {archivedCount > 0 && `(${archivedCount})`} <ChevronRight className="h-3.5 w-3.5" /></>}
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
            <p className="text-sm font-medium text-muted">Select a conversation</p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <button onClick={() => setMobileShowThread(false)} className="md:hidden mr-1 text-muted" aria-label="Back to conversations">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="grid h-10 w-10 place-items-center rounded-full bg-brand/20 text-lg">
                {activeConv.avatar_emoji ?? '💬'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{activeConv.name ?? 'Direct Message'}</p>
                <p className="truncate text-[11px] text-muted">
                  {activeConv.kind === 'direct'
                    ? (onlineIds.has(activeParticipants.find((m) => m.user_id !== userId)?.user_id ?? '') ? 'Active now' : 'Direct message')
                    : `${memberCount} members`}
                </p>
              </div>
              <AiInsight kind="messages" params={{ conversationId: activeConv.id }} variant="ghost" iconOnly />
              <button onClick={() => toastError('Video calling isn’t available yet.')} aria-label="Start video call"
                className="rounded-lg p-1.5 text-muted hover:text-fg"><Video className="h-4 w-4" /></button>
              <button onClick={() => toastError('Voice calling isn’t available yet.')} aria-label="Start voice call"
                className="rounded-lg p-1.5 text-muted hover:text-fg"><Phone className="h-4 w-4" /></button>
              <button onClick={() => setShowAbout(true)} aria-label="About this chat"
                className="rounded-lg p-1.5 text-muted hover:text-fg"><Info className="h-4 w-4" /></button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
              {loadingMsgs ? (
                <SkeletonList />
              ) : messages.length === 0 ? (
                <EmptyState icon={MessageCircle} title="No messages yet"
                  description="Say hello to your family!" />
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
                      const replyMsg = msg.reply_to_id ? messages.find((m) => m.id === msg.reply_to_id) : null;

                      return (
                        <div key={msg.id}
                          className={cn('group relative flex', isMine ? 'flex-row-reverse' : 'flex-row', !sameSender && 'mt-3')}
                          onMouseLeave={() => setMsgMenu((prev) => prev === msg.id ? null : prev)}>

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
                                <p className="truncate">{replyMsg.content}</p>
                              </div>
                            )}

                            {/* Bubble */}
                            {msg.deleted_at ? (
                              <div className="rounded-2xl bg-elevated/40 px-4 py-2 text-xs italic text-muted">
                                Message deleted
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
                                  <a href={msg.attachment_url} target="_blank" rel="noreferrer">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={msg.attachment_url} alt={msg.attachment_name ?? 'Photo'}
                                      className="mb-2 max-h-56 rounded-xl object-cover" />
                                  </a>
                                )}
                                {/* File — download card */}
                                {msg.kind === 'file' && msg.attachment_url && (
                                  <a href={msg.attachment_url} target="_blank" rel="noreferrer" download
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
                                  <audio controls preload="none" src={msg.attachment_url}
                                    className="mb-1 h-10 w-56 max-w-full" aria-label="Voice message" />
                                )}
                                {/* Text */}
                                {msg.content && <span>{msg.content}</span>}

                                {/* Timestamp inside bubble */}
                                <span className={cn('ml-2 text-[10px] opacity-60', isMine ? 'text-brand-fg' : 'text-muted')}>
                                  {fmtDate(msg.created_at, 'h:mm a')}
                                  {isMine && <CheckCheck className="ml-0.5 inline h-3 w-3" />}
                                </span>
                              </div>
                            )}

                            {/* Reactions */}
                            {Object.keys(reactions).length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {Object.entries(reactions).map(([emoji, users]) =>
                                  users.length > 0 ? (
                                    <button key={emoji} onClick={() => reactTo(msg, emoji)}
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
                          <div className={cn(
                            'absolute top-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
                            isMine ? 'right-[calc(100%-0.5rem)] -translate-x-1' : 'left-[calc(100%-0.5rem)] translate-x-1',
                          )}>
                            {REACTIONS.slice(0, 3).map((emoji) => (
                              <button key={emoji} onClick={() => reactTo(msg, emoji)}
                                className="rounded-full bg-elevated px-1.5 py-0.5 text-sm hover:bg-border transition">
                                {emoji}
                              </button>
                            ))}
                            <button onClick={() => setReplyTo(msg)}
                              className="rounded-full bg-elevated p-1.5 text-muted hover:text-fg transition">
                              <Reply className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setMsgMenu(msgMenu === msg.id ? null : msg.id)}
                              className="rounded-full bg-elevated p-1.5 text-muted hover:text-fg transition">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                            {/* Dropdown */}
                            {msgMenu === msg.id && (
                              <div className={cn(
                                'absolute top-7 z-20 rounded-xl border border-border bg-elevated shadow-xl min-w-[140px]',
                                isMine ? 'right-0' : 'left-0',
                              )}>
                                <button onClick={() => pinMessage(msg)} className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface/40">
                                  <Pin className="h-3.5 w-3.5" /> {msg.is_pinned ? 'Unpin' : 'Pin'}
                                </button>
                                <button onClick={() => setReplyTo(msg)} className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface/40">
                                  <Reply className="h-3.5 w-3.5" /> Reply
                                </button>
                                {isMine && (
                                  <button onClick={() => deleteMessage(msg.id)} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-danger hover:bg-surface/40">
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
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
                  Replying to <span className="font-semibold text-brand-text">{replyTo.sender_name}</span>:{' '}
                  <span>{replyTo.content?.slice(0, 60)}</span>
                </span>
                <button onClick={() => setReplyTo(null)} className="text-muted hover:text-fg">✕</button>
              </div>
            )}

            {/* Input */}
            <form onSubmit={sendMessage} className="flex items-center gap-2 border-t border-border bg-surface/50 px-4 py-3">
              <div className="flex flex-1 items-center gap-2 rounded-2xl border border-border bg-elevated px-3 py-1.5 focus-within:border-brand/50">
                {/* Hidden file inputs */}
                <input ref={fileRef} type="file" accept="application/pdf,.doc,.docx,.xls,.xlsx,.txt,image/*"
                  className="hidden" onChange={(e) => { if (e.target.files?.[0]) sendFile(e.target.files[0]); e.target.value = ''; }} />
                <input ref={imageRef} type="file" accept="image/*"
                  className="hidden" onChange={(e) => { if (e.target.files?.[0]) sendFile(e.target.files[0]); e.target.value = ''; }} />

                {/* Text input */}
                <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(e as unknown as React.FormEvent); } }}
                  placeholder="Type a message..."
                  className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm placeholder:text-muted focus:outline-none" />

                {/* Trailing tools */}
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingFile} aria-label="Attach file"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg disabled:opacity-50">
                  {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </button>
                <button type="button" onClick={() => imageRef.current?.click()} disabled={uploadingFile} aria-label="Send a photo"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg disabled:opacity-50">
                  <ImageIcon className="h-4 w-4" />
                </button>
                <div className="relative">
                  <button type="button" onClick={() => setShowPicker(!showPicker)} aria-label="Emoji"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-fg">
                    <Smile className="h-4 w-4" />
                  </button>
                  {showPicker && (
                    <div className="absolute bottom-11 right-0 z-20 rounded-xl border border-border bg-elevated p-2 shadow-xl">
                      <div className="grid grid-cols-8 gap-1">
                        {QUICK_EMOJIS.map((e) => (
                          <button key={e} type="button" onClick={() => { setText((t) => t + e); setShowPicker(false); inputRef.current?.focus(); }}
                            className="h-8 w-8 rounded-lg text-lg hover:bg-surface transition">{e}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button type="button" onClick={() => { setShowGifPicker((v) => !v); setShowPicker(false); }} aria-label="GIF"
                    className="grid h-8 shrink-0 place-items-center rounded-full px-2 text-[11px] font-bold text-muted transition hover:bg-surface hover:text-fg">
                    GIF
                  </button>
                  {showGifPicker && <GifPicker onPick={(url, title) => void sendGif(url, title)} onClose={() => setShowGifPicker(false)} />}
                </div>
              </div>

              {/* Send when typing · recording controls while recording · mic when empty */}
              {text.trim() ? (
                <button type="submit" disabled={sending} aria-label="Send message"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                  {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </button>
              ) : recording ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={() => stopRecording(true)} aria-label="Cancel recording"
                    className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-rose-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-rose-400" aria-live="polite">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                    {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
                  </span>
                  <button type="button" onClick={() => stopRecording(false)} aria-label="Stop and send voice message"
                    className="grid h-11 w-11 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90">
                    <Send className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <button type="button" onClick={startRecording} disabled={uploadingFile} aria-label="Record voice message"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                  {uploadingFile ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
                </button>
              )}
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
            <h2 className="font-semibold">About this chat</h2>
            <button onClick={() => setShowAbout(false)} className="rounded-lg p-1 text-muted hover:text-fg xl:hidden" aria-label="Close">
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
                <p className="truncate font-semibold">{activeConv.name ?? 'Direct Message'}</p>
                <p className="text-xs text-muted">
                  {activeConv.kind === 'direct' ? 'Direct message' : `Family group • ${memberCount} members`}
                </p>
              </div>
            </div>
            {activeConv.description && <p className="text-sm text-muted">{activeConv.description}</p>}
          </div>

          {/* Actions */}
          <div className="grid grid-cols-4 gap-1 border-y border-border py-3 text-center text-[11px] text-muted">
            <button onClick={() => setNewConvOpen(true)} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg">
              <UserPlus className="h-5 w-5" /> Add
            </button>
            <button onClick={() => { setShowAbout(false); searchRef.current?.focus(); }} className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg">
              <Search className="h-5 w-5" /> Search
            </button>
            <button onClick={() => toggleMute(activeConv.id)} className={cn('flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg', isMuted && 'text-brand-text')}>
              <BellOff className="h-5 w-5" /> {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <a href="/dashboard/settings#members" className="flex flex-col items-center gap-1 rounded-lg py-1 hover:text-fg">
              <Settings className="h-5 w-5" /> Settings
            </a>
          </div>

          {/* Members */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Members ({activeConv.kind === 'direct' ? Math.max(memberCount, activeParticipants.length) : memberCount})</h3>
              <button onClick={() => setNewConvOpen(true)} className="text-xs font-semibold text-brand-text">Add members</button>
            </div>
            <div className="space-y-2.5">
              {(activeParticipants.length ? activeParticipants : members).map((m) => {
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
                      <p className="truncate text-xs text-muted">{ROLE_LABELS[m.role]}</p>
                    </div>
                    {!isSelf && (
                      <button onClick={() => setNewConvOpen(true)} aria-label={`Message ${m.display_name}`}
                        className="rounded-lg p-1 text-muted/50 transition hover:text-fg group-hover:text-muted">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Shared Photos */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Shared Photos</h3>
              <a href="/dashboard/photos" className="text-xs font-semibold text-brand-text">View all</a>
            </div>
            {sharedPhotos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border py-4 text-center text-xs text-muted">
                Photos shared in this chat appear here.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {sharedPhotos.map((p) => (
                  <a key={p.id} href={p.attachment_url ?? '#'} target="_blank" rel="noreferrer"
                    className="aspect-square overflow-hidden rounded-lg bg-elevated">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.attachment_url ?? ''} alt={p.attachment_name ?? 'Shared photo'} className="h-full w-full object-cover" />
                  </a>
                ))}
              </div>
            )}
          </div>
        </aside>
      )}
      </div>

      {/* New Conversation */}
      {newConvOpen && (
        <NewConversation
          familyId={familyId}
          userId={userId}
          members={members}
          conversations={conversations}
          myName={myName}
          onClose={() => setNewConvOpen(false)}
          onCreated={(conv) => {
            setActiveConv(conv);
            setMobileShowThread(true);
            setNewConvOpen(false);
            void loadConversations();
          }}
        />
      )}
    </div>
  );
}

// ── New Conversation (multi-select, smart groups, two-step) ──────────────────

type Member = Tables<'family_members'>;

const CONV_EMOJIS = ['💬', '👨‍👩‍👧‍👦', '🏠', '📅', '🎉', '🛒', '📚', '⚽', '🎮', '🏖️', '❤️', '🍕'];

/** Smart, role-derived groups for one-tap multi-select. */
const SMART_GROUPS: { key: string; label: string; emoji: string; roles: MemberRole[] | null }[] = [
  { key: 'everyone', label: 'Everyone', emoji: '👨‍👩‍👧‍👦', roles: null },
  { key: 'parents', label: 'Parents', emoji: '🧑‍🤝‍🧑', roles: ['parent', 'adult'] },
  { key: 'kids', label: 'Kids', emoji: '🧒', roles: ['teen', 'child'] },
  { key: 'household', label: 'Household', emoji: '🏠', roles: ['parent', 'adult', 'teen', 'child'] },
];

type Step = 'people' | 'details';
type Tab = 'suggested' | 'contacts' | 'groups';

function NewConversation({ familyId, userId, members, conversations, myName, onClose, onCreated }: {
  familyId: string; userId: string;
  members: Member[];
  conversations: Conversation[];
  myName: string;
  onClose: () => void;
  onCreated: (conv: Conversation) => void;
}) {
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

    // Reuse an existing 1:1 DM instead of creating a duplicate. Match on the
    // participant roster when available, falling back to legacy user-id sets.
    if (isDirect) {
      const targetP = [...participantIds].sort().join(',');
      const targetU = [...memberIds].sort().join(',');
      const existing = conversations.find((c) => {
        if (c.kind !== 'direct') return false;
        if (c.participant_ids?.length) return [...c.participant_ids].sort().join(',') === targetP;
        return [...(c.member_ids ?? [])].sort().join(',') === targetU;
      });
      if (existing) { setLoading(false); onCreated(existing); return; }
    }

    const convName = name.trim() || (isDirect
      ? selectedMembers[0].display_name
      : [myName, ...selectedMembers.map((m) => firstName(m.display_name))].slice(0, 3).join(', ') +
        (selectedMembers.length > 2 ? ` +${selectedMembers.length - 2}` : ''));

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
    if (error || !data) { toastError(describeDbError(error, 'Could not create conversation')); return; }
    onCreated(data);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New Conversation"
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
                  <button onClick={() => toggle(m.id)} aria-label={`Remove ${m.display_name}`} className="rounded-full hover:text-fg">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={selectedMembers.length ? 'Add more…' : 'Search people or groups…'}
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
                        <p className="truncate text-sm font-semibold">{g.label}</p>
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
                        <p className="truncate text-xs text-muted">{ROLE_LABELS[m.role]}</p>
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
              Next {selected.size > 0 && `(${selected.size})`}
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
                <Camera className="h-3.5 w-3.5" /> Choose an icon
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
            <p className="mb-2 text-xs font-semibold text-muted">Members ({selectedMembers.length + 1})</p>
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
                    <p className="truncate text-xs text-muted">{ROLE_LABELS[m.role]}</p>
                  </div>
                  <button onClick={() => toggle(m.id)} aria-label={`Remove ${m.display_name}`} className="rounded-lg p-1.5 text-muted hover:text-danger">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={() => setStep('people')}>
              <ArrowLeft className="h-4 w-4" /> Back
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
