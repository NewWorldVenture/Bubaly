'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageCircle, Plus, Send, Smile, Paperclip, Reply, Pin, Trash2,
  MoreHorizontal, Check, CheckCheck, ArrowLeft, Users, Search, X, Camera, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { AiInsight } from '@/components/ai/ai-insight';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { fmtRelative, fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables, MemberRole } from '@/lib/database.types';

type Conversation = Tables<'family_conversations'>;
type Message = Tables<'family_messages'>;

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
const QUICK_EMOJIS = ['😀', '🎉', '👏', '✅', '🙏', '💪', '🤣', '😍'];

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
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mobileShowThread, setMobileShowThread] = useState(false);
  const [msgMenu, setMsgMenu] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const myName = selfMember?.display_name ?? 'You';

  // ── Load conversations ──────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('family_conversations')
      .select('*')
      .eq('family_id', familyId)
      .order('last_message_at', { ascending: false, nullsFirst: false });
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
      const { data } = await supabase
        .from('family_conversations')
        .select('id')
        .eq('family_id', familyId)
        .eq('kind', 'group')
        .limit(1);
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
    const { data } = await supabase
      .from('family_messages')
      .select('*')
      .eq('conversation_id', convId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(200);
    setMessages(data ?? []);
    setLoadingMsgs(false);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    // mark as read (best-effort via update)
    void supabase.from('family_messages')
      .update({ read_by: [userId] })
      .eq('conversation_id', convId)
      .not('read_by', 'cs', `{${userId}}`);
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
      const { error: insErr } = await supabase.from('family_messages').insert({
        conversation_id: activeConv.id,
        family_id: familyId,
        sender_id: userId,
        sender_name: myName,
        content: isImage ? null : file.name,
        kind: isImage ? 'image' : 'file',
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

  const filtered = conversations.filter((c) =>
    !search || (c.name ?? '').toLowerCase().includes(search.toLowerCase())
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

  if (loadingConvs) return <LoadingBlock />;

  return (
    <div className="flex h-[calc(100vh-var(--topbar-height)-2rem)] overflow-hidden rounded-2xl border border-border bg-surface/30">

      {/* ── Conversation list ──────────────────────────────── */}
      <div className={cn(
        'flex w-full flex-col border-r border-border lg:w-72 xl:w-80',
        mobileShowThread && 'hidden lg:flex',
      )}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-bold">Messages</h2>
          <button onClick={() => setNewConvOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-brand hover:bg-brand/25 transition">
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-elevated/50 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              className="flex-1 bg-transparent text-sm text-fg placeholder:text-muted outline-none" />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <MessageCircle className="mb-2 h-8 w-8 text-muted/50" />
              <p className="text-sm text-muted">No conversations yet</p>
            </div>
          ) : (
            filtered.map((conv) => {
              const isActive = activeConv?.id === conv.id;
              return (
                <button key={conv.id} onClick={() => selectConversation(conv)}
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-border/40 px-4 py-3 text-left transition',
                    isActive ? 'bg-brand/10' : 'hover:bg-elevated/30',
                  )}>
                  <div className={cn(
                    'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-lg',
                    conv.kind === 'group' ? 'bg-brand/20' : 'bg-elevated',
                  )}>
                    {conv.avatar_emoji ?? (conv.kind === 'group' ? '👨‍👩‍👧‍👦' : '💬')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-sm font-semibold', isActive && 'text-brand')}>
                      {conv.name ?? 'Direct Message'}
                    </p>
                    {conv.last_message_at && (
                      <p className="text-[11px] text-muted">{fmtRelative(conv.last_message_at)}</p>
                    )}
                  </div>
                  {conv.kind === 'group' && <Users className="h-3.5 w-3.5 flex-shrink-0 text-muted/60" />}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Message thread ─────────────────────────────────── */}
      <div className={cn(
        'flex flex-1 flex-col overflow-hidden',
        !mobileShowThread && 'hidden lg:flex',
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
              <button onClick={() => setMobileShowThread(false)} className="lg:hidden mr-1 text-muted">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand/20 text-base">
                {activeConv.avatar_emoji ?? '💬'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{activeConv.name ?? 'Direct Message'}</p>
                <p className="truncate text-[11px] text-muted">
                  {activeConv.kind !== 'group'
                    ? 'Direct message'
                    : activeParticipants.length > 0
                      ? activeParticipants.map((m) => m.display_name.split(' ')[0]).slice(0, 4).join(', ') +
                        (activeParticipants.length > 4 ? ` +${activeParticipants.length - 4}` : '')
                      : `${activeConv.participant_ids?.length || activeConv.member_ids?.length || members.length} members`}
                </p>
              </div>
              <AiInsight kind="messages" params={{ conversationId: activeConv.id }} variant="ghost" iconOnly />
              <button className="rounded-lg p-1.5 text-muted hover:text-fg"><Search className="h-4 w-4" /></button>
              <button className="rounded-lg p-1.5 text-muted hover:text-fg"><MoreHorizontal className="h-4 w-4" /></button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
              {loadingMsgs ? (
                <LoadingBlock />
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
                            {/* Sender name */}
                            {!isMine && !sameSender && (
                              <span className="mb-0.5 ml-1 text-[11px] font-semibold text-brand">
                                {msg.sender_name ?? 'Family member'}
                              </span>
                            )}

                            {/* Reply preview */}
                            {replyMsg && (
                              <div className={cn(
                                'mb-1 rounded-lg border-l-2 border-brand/60 bg-elevated/60 px-3 py-1.5 text-xs text-muted',
                                isMine ? 'border-r-2 border-l-0 text-right' : '',
                              )}>
                                <span className="font-semibold text-brand/80">{replyMsg.sender_name}</span>
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
                                {/* File */}
                                {msg.kind === 'file' && msg.attachment_url && (
                                  <a href={msg.attachment_url} target="_blank" rel="noreferrer"
                                    className="flex items-center gap-2 underline">
                                    <Paperclip className="h-3.5 w-3.5" />
                                    {msg.attachment_name}
                                  </a>
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
                                          ? 'border-brand/50 bg-brand/15 text-brand'
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
                <Reply className="h-3.5 w-3.5 text-brand" />
                <span className="flex-1 truncate text-muted">
                  Replying to <span className="font-semibold text-brand">{replyTo.sender_name}</span>:{' '}
                  <span>{replyTo.content?.slice(0, 60)}</span>
                </span>
                <button onClick={() => setReplyTo(null)} className="text-muted hover:text-fg">✕</button>
              </div>
            )}

            {/* Input */}
            <form onSubmit={sendMessage}
              className="flex items-end gap-2 border-t border-border bg-surface/50 px-4 py-3">
              {/* Attachment */}
              <input ref={fileRef} type="file" accept="image/*,application/pdf,.doc,.docx"
                className="hidden" onChange={(e) => { if (e.target.files?.[0]) sendFile(e.target.files[0]); e.target.value = ''; }} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingFile} aria-label="Attach file"
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50">
                {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </button>

              {/* Emoji */}
              <div className="relative">
                <button type="button" onClick={() => setShowPicker(!showPicker)}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted hover:bg-elevated hover:text-fg transition">
                  <Smile className="h-4 w-4" />
                </button>
                {showPicker && (
                  <div className="absolute bottom-10 left-0 z-20 rounded-xl border border-border bg-elevated p-2 shadow-xl">
                    <div className="grid grid-cols-8 gap-1">
                      {QUICK_EMOJIS.map((e) => (
                        <button key={e} type="button" onClick={() => { setText((t) => t + e); setShowPicker(false); }}
                          className="h-8 w-8 rounded-lg text-lg hover:bg-surface transition">{e}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Text input */}
              <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(e as unknown as React.FormEvent); } }}
                placeholder="Message your family…"
                className="flex-1 rounded-2xl border border-border bg-elevated px-4 py-2 text-sm placeholder:text-muted focus:border-brand/50 focus:outline-none transition" />

              {/* Send */}
              <button type="submit" disabled={!text.trim() || sending}
                className={cn(
                  'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition',
                  text.trim() ? 'bg-brand text-brand-fg hover:bg-brand/80' : 'text-muted',
                )}>
                <Send className="h-4 w-4" />
              </button>
            </form>
          </>
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
      : [myName, ...selectedMembers.map((m) => m.display_name.split(' ')[0])].slice(0, 3).join(', ') +
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
    if (error || !data) { toastError(error?.message ?? 'Could not create conversation'); return; }
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
                <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-brand/15 py-1 pl-1 pr-2 text-xs font-medium text-brand">
                  <Avatar name={m.display_name} color={m.color} size={18} />
                  {m.display_name.split(' ')[0]}
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
                  tab === t ? 'text-brand' : 'text-muted hover:text-fg',
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
                          {gm.length === 0 ? 'No members' : gm.map((m) => m.display_name.split(' ')[0]).join(', ')}
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
