'use client';

import Link from 'next/link';
import { useState, useMemo, useRef } from 'react';
import {
  Phone, MessageSquare, Mail, Instagram, BookOpen, Trophy,
  FileText, Plus, Search, Wand2, X, Archive,
  CheckCircle, Sparkles, ArrowLeft, Bell, Copy, Check, Reply, Send, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { createReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Comm = Tables<'family_communications'> & { contact?: Tables<'family_contacts'> | null };
type Contact = Tables<'family_contacts'>;

const CHANNELS: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  call:      { icon: Phone,         label: 'Call',      color: 'bg-blue-500/15 text-blue-400' },
  sms:       { icon: MessageSquare, label: 'SMS',       color: 'bg-green-500/15 text-green-400' },
  email:     { icon: Mail,          label: 'Email',     color: 'bg-violet-500/15 text-violet-400' },
  whatsapp:  { icon: MessageSquare, label: 'WhatsApp',  color: 'bg-emerald-500/15 text-emerald-400' },
  instagram: { icon: Instagram,     label: 'Instagram', color: 'bg-pink-500/15 text-pink-400' },
  school:    { icon: BookOpen,      label: 'School',    color: 'bg-amber-500/15 text-amber-400' },
  sports:    { icon: Trophy,        label: 'Sports',    color: 'bg-orange-500/15 text-orange-400' },
  note:      { icon: FileText,      label: 'Note',      color: 'bg-slate-500/15 text-slate-400' },
  other:     { icon: FileText,      label: 'Other',     color: 'bg-surface text-muted' },
};

const CATEGORY_LABELS: Record<string, string> = {
  general: 'General', school: 'School', medical: 'Medical', sports: 'Sports',
  social: 'Social', emergency: 'Emergency', financial: 'Financial', legal: 'Legal', other: 'Other',
};

type FilterTab = 'all' | 'unread' | 'call' | 'sms' | 'school' | 'sports' | 'email' | 'archived';

function fmtTime(iso: string) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function InboxModule() {
  const tr = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Comm | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showAiImport, setShowAiImport] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: comms, loading: commsLoading, error: commsError, refresh: refreshComms } = useRealtimeQuery<Comm>({
    table: 'family_communications', familyId, deps: [familyId],
    fetcher: async (supabase) => {
      const { data: rows, error } = await supabase
        .from('family_communications').select('*')
        .eq('family_id', familyId).order('received_at', { ascending: false }).limit(200);
      // useRealtimeQuery degrades missing-relation errors (e.g. the Communications
      // Hub migration not yet applied) to an empty inbox instead of a crash.
      if (error) return { data: null, error };
      if (!rows?.length) return { data: [], error: null };
      const contactIds = [...new Set(rows.map(r => r.contact_id).filter(Boolean))] as string[];
      const { data: cts } = contactIds.length
        ? await supabase.from('family_contacts').select('*').in('id', contactIds)
        : { data: [] as Contact[] };
      const byId = new Map((cts ?? []).map(c => [c.id, c]));
      return { data: rows.map(r => ({ ...r, contact: r.contact_id ? (byId.get(r.contact_id) ?? null) : null })), error: null };
    },
  });

  const { data: contacts, loading: contactsLoading } = useRealtimeQuery<Contact>({
    table: 'family_contacts', familyId, deps: [familyId],
    fetcher: async (supabase) => supabase.from('family_contacts').select('*').eq('family_id', familyId).order('name'),
  });

  const filtered = useMemo(() => {
    let list = comms;
    switch (filterTab) {
      case 'unread':   list = list.filter(c => c.status === 'unread'); break;
      case 'archived': list = list.filter(c => c.status === 'archived'); break;
      case 'call':     list = list.filter(c => c.channel === 'call'); break;
      case 'sms':      list = list.filter(c => c.channel === 'sms'); break;
      case 'school':   list = list.filter(c => c.channel === 'school' || c.category === 'school'); break;
      case 'sports':   list = list.filter(c => c.channel === 'sports' || c.category === 'sports'); break;
      case 'email':    list = list.filter(c => c.channel === 'email'); break;
      default:         list = list.filter(c => c.status !== 'archived'); break;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c =>
        c.subject?.toLowerCase().includes(q) ||
        c.body?.toLowerCase().includes(q) ||
        c.contact?.name?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [comms, filterTab, search]);

  const unreadCount = useMemo(() => comms.filter(c => c.status === 'unread').length, [comms]);

  async function markRead(comm: Comm) {
    if (comm.status !== 'unread') return;
    const supabase = createClient();
    await supabase.from('family_communications').update({ status: 'read' }).eq('id', comm.id);
    void refreshComms();
  }

  async function archive(comm: Comm) {
    if (busyId) return;
    setBusyId(comm.id);
    const supabase = createClient();
    const { error } = await supabase.from('family_communications').update({ status: 'archived' }).eq('id', comm.id);
    setBusyId(null);
    if (error) { toastError(describeDbError(error)); return; }
    if (selected?.id === comm.id) setSelected(null);
    void refreshComms();
  }

  function openDetail(comm: Comm) {
    setSelected(comm);
    void markRead(comm);
  }

  if (commsLoading) return <SkeletonList />;
  if (commsError) return <ErrorState message={commsError} onRetry={refreshComms} />;

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'all',      label: 'All' },
    { key: 'unread',   label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
    { key: 'school',   label: 'School' },
    { key: 'sports',   label: 'Sports' },
    { key: 'call',     label: 'Calls' },
    { key: 'sms',      label: 'SMS' },
    { key: 'email',    label: 'Email' },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <div className="module-with-sidebar">
      <div className="module-main">
        <div className="module-page">
          <PageHeader
            title={tr('inbox.communicationsHub')}
            description={tr('inboxModule.allYourFamilyMessagesCalls')}
            action={
              <div className="flex items-center gap-2">
                <Link href="/dashboard/paperwork"
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:bg-elevated transition">
                  {tr('inbox.paperworkInbox')}
                </Link>
                <button onClick={() => setShowAiImport(true)}
                  className="flex items-center gap-1.5 rounded-lg bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand-text hover:bg-brand/20 transition">
                  <Sparkles className="h-3.5 w-3.5" /> {tr('inbox.aiImport')}
                </button>
                <Button onClick={() => setShowAdd(true)}>
                  <Plus className="h-4 w-4" /> {tr('inbox.logMessage')}
                </Button>
              </div>
            }
          />

          <div className="grid-stats">
            {[
              { label: 'Total',    value: comms.filter(c => c.status !== 'archived').length, icon: '💬', color: 'text-brand-text' },
              { label: 'Unread',   value: unreadCount,                                        icon: '🔵', color: 'text-blue-400' },
              { label: 'School',   value: comms.filter(c => c.channel === 'school' || c.category === 'school').length, icon: '📚', color: 'text-amber-400' },
              { label: 'Urgent',   value: comms.filter(c => c.priority === 'urgent').length,  icon: '⚡', color: 'text-red-400' },
            ].map(s => (
              <div key={s.label} className="stat-card">
                <span className="text-2xl">{s.icon}</span>
                <div>
                  <div className={cn('text-2xl font-bold', s.color)}>{s.value}</div>
                  <div className="text-[11px] text-muted">{s.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted pointer-events-none" />
              <input value={search} inputMode="search" enterKeyHint="search" onChange={e => setSearch(e.target.value)}
                placeholder={tr('inbox.searchMessagesContacts')}
                className="w-full rounded-xl border border-border bg-surface/60 py-2.5 pl-9 pr-4 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/30" />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="tab-bar overflow-x-auto no-scrollbar">
              {TABS.map(t => (
                <button key={t.key} onClick={() => setFilterTab(t.key)}
                  className={cn('tab-item whitespace-nowrap', filterTab === t.key ? 'tab-item-active' : 'tab-item-inactive')}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface/30">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center">
                <div className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-brand/10">
                  <MessageSquare className="h-7 w-7 text-brand-text opacity-60" />
                </div>
                <p className="text-sm font-semibold">{tr('inbox.noMessagesHere')}</p>
                <p className="mt-1 text-xs text-muted">{tr('inbox.logAMessageOrUseAi')}</p>
                <div className="mt-4 flex gap-2">
                  <button onClick={() => setShowAiImport(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-brand/10 px-4 py-2 text-xs font-semibold text-brand-text hover:bg-brand/20 transition">
                    <Sparkles className="h-3.5 w-3.5" /> {tr('inbox.aiImport')}
                  </button>
                  <button onClick={() => setShowAdd(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition">
                    <Plus className="h-3.5 w-3.5" /> {tr('inbox.logMessage')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {filtered.map(comm => {
                  const ch = CHANNELS[comm.channel] ?? CHANNELS.other;
                  const isUnread = comm.status === 'unread';
                  const isSelected = selected?.id === comm.id;
                  return (
                    <button key={comm.id} onClick={() => openDetail(comm)}
                      className={cn(
                        'group w-full flex items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface/60',
                        isSelected && 'bg-brand/5 border-l-2 border-brand',
                      )}>
                      <div className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl', ch.color)}>
                        <ch.icon className="h-[18px] w-[18px]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn('truncate text-sm', isUnread ? 'font-bold' : 'font-medium')}>
                            {comm.contact?.name ?? comm.subject ?? 'No subject'}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted">{fmtTime(comm.received_at)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {comm.contact && comm.subject ? comm.subject : (comm.body?.slice(0, 80) ?? '')}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="text-[10px] text-muted">{ch.label}</span>
                          {comm.category !== 'general' && (
                            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted border border-border/60">
                              {CATEGORY_LABELS[comm.category]}
                            </span>
                          )}
                          {(comm.action_items as unknown[]).length > 0 && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                              {(comm.action_items as unknown[]).length} action{(comm.action_items as unknown[]).length !== 1 ? 's' : ''}
                            </span>
                          )}
                          {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-blue-400 flex-shrink-0" />}
                          {comm.priority === 'urgent' && <span className="h-1.5 w-1.5 rounded-full bg-red-400 flex-shrink-0" />}
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); void archive(comm); }}
                        aria-label={tr('inbox.archive')}
                        className="flex sm:hidden sm:group-hover:flex items-center justify-center h-9 w-9 sm:h-7 sm:w-7 rounded-lg hover:bg-surface text-muted hover:text-fg transition shrink-0">
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)] lg:pt-0 lg:pb-0 lg:pl-0 lg:pr-0 lg:static lg:inset-auto lg:z-auto lg:w-[400px] lg:rounded-2xl lg:border lg:border-border lg:bg-surface/30 lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto lg:self-start lg:sticky lg:top-4">
          <CommDetail comm={selected} familyId={familyId} userId={userId}
            onClose={() => setSelected(null)} onArchive={() => void archive(selected)} onRefresh={refreshComms} />
        </div>
      )}

      {/* Sidebar (when no detail) */}
      {!selected && (
        <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
          <div className="sidebar-card">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">{tr('inbox.contacts')}</p>
              <span className="text-[10px] text-muted">{contacts.length} total</span>
            </div>
            {contactsLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-8 rounded-lg bg-surface animate-pulse" />)}</div>
            ) : contacts.length === 0 ? (
              <p className="text-xs text-muted">{tr('inbox.noContactsYetAddThemIn')}</p>
            ) : (
              <div className="space-y-1.5">
                {contacts.slice(0, 8).map(c => (
                  <div key={c.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60 transition">
                    <Avatar name={c.name} src={c.photo_url} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{c.name}</div>
                      <div className="text-[10px] text-muted capitalize">{c.category}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-card">
            <p className="mb-3 text-sm font-semibold">{tr('inbox.byChannel')}</p>
            <div className="space-y-2">
              {(['school', 'call', 'sms', 'email', 'sports'] as const).map(ch => {
                const count = comms.filter(c => c.channel === ch && c.status !== 'archived').length;
                const cfg = CHANNELS[ch];
                return (
                  <div key={ch} className="flex items-center gap-2">
                    <div className={cn('grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-[10px]', cfg.color)}>
                      <cfg.icon className="h-3 w-3" />
                    </div>
                    <span className="flex-1 text-xs text-muted">{cfg.label}</span>
                    <span className="text-xs font-semibold">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <AddCommModal familyId={familyId} userId={userId} contacts={contacts}
          onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); void refreshComms(); }} />
      )}
      {showAiImport && (
        <AiImportModal familyId={familyId} userId={userId} contacts={contacts}
          onClose={() => setShowAiImport(false)} onSaved={() => { setShowAiImport(false); void refreshComms(); }} />
      )}
    </div>
  );
}

function CommDetail({ comm, familyId, userId, onClose, onArchive, onRefresh }: {
  comm: Comm; familyId: string; userId: string;
  onClose: () => void; onArchive: () => void; onRefresh: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const ch = CHANNELS[comm.channel] ?? CHANNELS.other;
  const actions = comm.action_items as string[];

  const [draft, setDraft] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addedItems, setAddedItems] = useState<Set<number>>(new Set());
  const [busyItem, setBusyItem] = useState<number | null>(null);
  // One submission id per action item, keyed by COMMUNICATION AND INDEX — not
  // index alone. `<CommDetail comm={selected} />` carries no `key`, so selecting
  // a different message reuses this instance and this ref; keyed by position,
  // the next message's first action item would reuse the previous one's id and
  // be answered with the reminder that id already created.
  const reminderIds = useRef<Record<string, string>>({});

  const canReply = comm.direction === 'inbound';

  // ── AI Message Agent: draft a reply ──────────────────────────────────────
  async function generateReply() {
    if (drafting) return;
    setDrafting(true);
    try {
      const contextLines = [
        comm.contact?.name ? `From: ${comm.contact.name}` : null,
        comm.subject ? `Subject: ${comm.subject}` : null,
        comm.body ? `Message: ${comm.body}` : (comm.summary ? `Summary: ${comm.summary}` : null),
        `Channel: ${ch.label}`,
      ].filter(Boolean).join('\n');
      const res = await fetch('/api/ai/assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: `You are a family's AI message agent. Draft a brief, warm, polite reply to the message below on the family's behalf. Match the tone to the channel (${ch.label}). Keep it natural and ready to send — no placeholders, no "[Name]", no preamble. Just the reply text.`,
          messages: [{ role: 'user', content: contextLines }],
          maxTokens: 300,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toastError(data.error ?? 'Could not draft a reply.'); return; }
      setDraft((data.message ?? '').trim());
    } catch {
      toastError(tr('inboxModule.couldNotReachTheAi'));
    } finally {
      setDrafting(false);
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true); success(tr('inboxModule.replyCopied'));
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  // Log the drafted reply as an outbound message in the thread.
  async function logReply() {
    if (!draft.trim() || sendingReply) return;
    setSendingReply(true);
    const supabase = createClient();
    const { error } = await supabase.from('family_communications').insert({
      family_id: familyId, created_by: userId,
      contact_id: comm.contact_id,
      thread_id: comm.thread_id ?? comm.id,
      channel: comm.channel,
      direction: 'outbound',
      subject: comm.subject ? `Re: ${comm.subject}` : null,
      body: draft.trim(),
      category: comm.category,
      status: 'replied',
    });
    if (!error) {
      await supabase.from('family_communications').update({ status: 'replied' }).eq('id', comm.id);
    }
    setSendingReply(false);
    if (error) { toastError(describeDbError(error)); return; }
    success(tr('inboxModule.replyLoggedToTheThread'));
    setDraft('');
    onRefresh();
  }

  // ── Action item → reminder (one tap) ─────────────────────────────────────
  async function addReminder(text: string, i: number) {
    if (busyItem !== null) return;
    setBusyItem(i);
    // Through the service. `status: 'pending'` and `priority: 'normal'` are both
    // outside 0014's CHECK sets, so the raw insert was rejected every time and
    // this one-tap button never saved anything.
    const result = await createReminderAction({
      title: text.slice(0, 200),
      notes: comm.contact?.name ? `From ${comm.contact.name} · ${ch.label}` : `From ${ch.label}`,
      kind: 'task',
      priority: comm.priority === 'urgent' ? 'high' : 'medium',
      aiSuggested: true,
      submissionId: reminderIds.current[`${comm.id}:${i}`] ||= newSubmissionId(),
    });
    setBusyItem(null);
    if (!result.ok) { toastError(result.error); return; }
    setAddedItems(prev => new Set(prev).add(i));
    success(tr('inboxModule.addedToReminders'));
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 flex-shrink-0">
        <button onClick={onClose} aria-label={tr('inbox.back')} className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className={cn('grid h-9 w-9 place-items-center rounded-xl flex-shrink-0', ch.color)}>
          <ch.icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{comm.contact?.name ?? comm.subject ?? 'No subject'}</div>
          <div className="text-[10px] text-muted">{ch.label} · {fmtTime(comm.received_at)}</div>
        </div>
        <button onClick={onArchive} className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-fg" title={tr('inbox.archive')}>
          <Archive className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {comm.category !== 'general' && (
            <span className="rounded-md bg-surface border border-border px-2 py-0.5 text-[11px] font-semibold capitalize">{CATEGORY_LABELS[comm.category]}</span>
          )}
          <span className="rounded-md bg-surface border border-border px-2 py-0.5 text-[11px] font-semibold capitalize">{comm.direction}</span>
          {comm.priority !== 'normal' && (
            <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize',
              comm.priority === 'urgent' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400')}>
              {comm.priority}
            </span>
          )}
        </div>

        {comm.subject && comm.contact && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">{tr('inbox.subject')}</p>
            <p className="text-sm font-medium">{comm.subject}</p>
          </div>
        )}

        {comm.body && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">{tr('inbox.message')}</p>
            <p className="text-sm whitespace-pre-wrap leading-relaxed text-fg/90">{comm.body}</p>
          </div>
        )}

        {comm.summary && (
          <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand-text" />
              <span className="text-[10px] font-semibold text-brand-text uppercase tracking-wide">{tr('inbox.aiSummary')}</span>
            </div>
            <p className="text-xs leading-relaxed text-fg/80">{comm.summary}</p>
          </div>
        )}

        {actions.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <CheckCircle className="h-3.5 w-3.5 text-amber-400" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{tr('inbox.actionItems')}</p>
            </div>
            <div className="space-y-1.5">
              {actions.map((a, i) => {
                const added = addedItems.has(i);
                return (
                  <div key={i} className="flex items-center gap-2 rounded-lg bg-amber-500/8 border border-amber-500/20 px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                    <span className="flex-1 text-xs text-fg/90">{a}</span>
                    <button onClick={() => addReminder(a, i)} disabled={added || busyItem !== null}
                      className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition flex-shrink-0',
                        added ? 'text-green-400' : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25')}>
                      {added ? <><Check className="h-3 w-3" /> {tr('inbox.added')}</>
                        : busyItem === i ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <><Bell className="h-3 w-3" /> {tr('inbox.remind')}</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* AI Message Agent — draft a reply */}
        {canReply && (
          <div className="rounded-xl border border-border bg-surface/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Reply className="h-3.5 w-3.5 text-brand-text" />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{tr('inbox.aiReplyAgent')}</span>
              </div>
              <button onClick={generateReply} disabled={drafting}
                className="flex items-center gap-1 rounded-md bg-brand/10 px-2 py-1 text-[10px] font-semibold text-brand-text hover:bg-brand/20 transition disabled:opacity-60">
                {drafting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                {drafting ? 'Drafting…' : draft ? 'Redraft' : 'Draft reply'}
              </button>
            </div>
            <textarea value={draft} onChange={e => setDraft(e.target.value)}
              placeholder={tr('inbox.tapDraftReplyForAnAi')}
              rows={draft ? 5 : 2}
              className="w-full resize-none rounded-lg border border-border bg-background/60 p-2.5 text-xs leading-relaxed placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/30" />
            {draft && (
              <div className="mt-2 flex items-center justify-end gap-2">
                <button onClick={copyDraft} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium hover:border-brand/40 hover:text-brand-text transition">
                  {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={logReply} disabled={sendingReply}
                  className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-brand/90 transition disabled:opacity-60">
                  {sendingReply ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} {tr('inbox.logReply')}
                </button>
              </div>
            )}
          </div>
        )}

        {comm.contact && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">{tr('inbox.contact')}</p>
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface/60 px-3 py-2.5">
              <Avatar name={comm.contact.name} src={comm.contact.photo_url} size={36} />
              <div>
                <div className="text-sm font-semibold">{comm.contact.name}</div>
                <div className="text-[11px] text-muted capitalize">{comm.contact.category}</div>
                {comm.contact.phone && <div className="text-[11px] text-muted">{comm.contact.phone}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddCommModal({ familyId, userId, contacts, onClose, onSaved }: {
  familyId: string; userId: string; contacts: Contact[];
  onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const subject = String(form.get('subject') ?? '').trim();
    const body = String(form.get('body') ?? '').trim();
    const channel = String(form.get('channel') ?? 'other');
    const direction = String(form.get('direction') ?? 'inbound');
    const category = String(form.get('category') ?? 'general');
    const priority = String(form.get('priority') ?? 'normal');
    const contact_id = String(form.get('contact_id') ?? '') || null;
    const received_at = String(form.get('received_at') ?? '') || new Date().toISOString();

    if (!subject && !body) return toastError(tr('inboxModule.addASubjectOrMessage'));

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('family_communications').insert({
      family_id: familyId, created_by: userId,
      subject: subject || null, body: body || null,
      channel, direction, category, priority,
      contact_id, received_at, status: 'unread',
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={tr('inbox.logCommunication')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inbox.channel')}>
            {id => <Select id={id} name="channel">{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}
          </Field>
          <Field label={tr('inbox.direction')}>
            {id => <Select id={id} name="direction"><option value="inbound">{tr('inbox.inbound')}</option><option value="outbound">{tr('inbox.outbound')}</option></Select>}
          </Field>
        </div>
        <Field label={tr('inbox.contact')}>
          {id => <Select id={id} name="contact_id"><option value="">{tr('inbox.noContact')}</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        </Field>
        <Field label={tr('inbox.subject')}>
          {id => <Input id={id} name="subject" placeholder={tr('inbox.whatWasItAbout')} />}
        </Field>
        <Field label={tr('inbox.messageNotes')}>
          {id => <Textarea id={id} name="body" rows={4} placeholder={tr('inbox.whatWasSaidOrWritten')} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('inbox.category')}>
            {id => <Select id={id} name="category">{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          </Field>
          <Field label={tr('inbox.priority')}>
            {id => <Select id={id} name="priority"><option value="low">Low</option><option value="normal">{tr('inbox.normal')}</option><option value="high">{tr('inbox.high')}</option><option value="urgent">{tr('inbox.urgent')}</option></Select>}
          </Field>
        </div>
        <Field label={tr('inbox.dateTime')}>
          {id => <Input id={id} name="received_at" type="datetime-local" />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('inbox.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : 'Log Message'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const EXAMPLES = [
  'Picture day is next Friday — wear school colors. Order forms due Wednesday.',
  'Soccer practice moved to Tuesdays 5–6:30pm at Lincoln Park starting next week.',
  'Dentist for Emma on the 14th at 9am. Remind me to renew car insurance by month end.',
  'Coach called — Jake made the varsity team! First game is Saturday at 10am.',
];

function AiImportModal({ familyId, userId, contacts, onClose, onSaved }: {
  familyId: string; userId: string; contacts: Contact[];
  onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [contactId, setContactId] = useState('');
  const [result, setResult] = useState<{
    subject: string; body: string; summary: string; action_items: string[]; channel: string; category: string; priority: string;
  } | null>(null);

  async function parse() {
    if (!text.trim() || parsing) return;
    setParsing(true);
    try {
      const res = await fetch('/api/ai/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not process that.'); return; }
      const items: { name: string; summary: string }[] = json.items ?? [];
      const hasSchool = items.some(it => ['event', 'reminder', 'appointment'].includes(it.name));
      setResult({
        subject: text.slice(0, 100),
        body: text,
        summary: items.map(it => it.summary).join(' ') || text.slice(0, 200),
        action_items: items.map(it => it.summary).filter(Boolean),
        channel: hasSchool ? 'school' : 'other',
        category: hasSchool ? 'school' : 'general',
        priority: 'normal',
      });
    } finally {
      setParsing(false);
    }
  }

  async function save() {
    if (!result || saving) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('family_communications').insert({
      family_id: familyId, created_by: userId,
      subject: result.subject, body: result.body, summary: result.summary,
      action_items: result.action_items,
      channel: result.channel, category: result.category, priority: result.priority,
      direction: 'inbound', status: 'unread',
      contact_id: contactId || null,
    });
    setSaving(false);
    if (error) { toastError(describeDbError(error)); return; }
    success(tr('inboxModule.savedToCommunicationsHub'));
    onSaved();
  }

  return (
    <Modal open title={tr('inbox.aiImport')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">{tr('inbox.pasteAnyMessageFromASchool')}</p>
        {!result ? (
          <>
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder={tr('inbox.pasteTextHere')} rows={6}
              className="w-full rounded-xl border border-border bg-surface/60 p-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/30 resize-none" />
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-muted uppercase tracking-wide">{tr('inbox.examples')}</p>
              {EXAMPLES.map((ex, i) => (
                <button key={i} onClick={() => setText(ex)}
                  className="w-full rounded-lg border border-border/60 px-3 py-2 text-left text-xs text-muted hover:bg-surface/60 hover:text-fg transition">
                  {ex}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>{tr('inbox.cancel')}</Button>
              <Button onClick={parse} loading={parsing} disabled={!text.trim()}>
                {parsing ? 'Analyzing…' : <><Wand2 className="h-3.5 w-3.5" /> {tr('inbox.parseWithAi')}</>}
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className="h-3.5 w-3.5 text-brand-text" />
                <span className="text-[10px] font-semibold text-brand-text uppercase tracking-wide">{tr('inbox.aiExtracted')}</span>
              </div>
              <div className="text-sm font-medium">{result.subject}</div>
              <div className="text-xs text-muted">{result.summary}</div>
              {result.action_items.length > 0 && (
                <div className="space-y-1 mt-2">
                  {result.action_items.map((a, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <CheckCircle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Field label={tr('inbox.linkToContactOptional')}>
              {id => (
                <Select id={id} value={contactId} onChange={e => setContactId(e.target.value)}>
                  <option value="">{tr('inbox.noContact')}</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setResult(null)}>{tr('inbox.back')}</Button>
              <Button onClick={save} loading={saving}>{saving ? 'Saving…' : 'Save to Hub'}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
