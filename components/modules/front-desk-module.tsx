'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Phone, PhoneIncoming, PhoneOff, PhoneForwarded, Voicemail, ShieldCheck,
  ShieldAlert, Ban, Clock, Search, X, ArrowLeft, Settings as SettingsIcon,
  Sparkles, CheckCircle2, PhoneCall, UserCheck, Trash2, Bell, Check, Loader2, CalendarPlus,
  PhoneOutgoing, ArrowRight, FileText,
} from 'lucide-react';
import Link from 'next/link';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { isManager } from '@/lib/constants/roles';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Call = Tables<'call_logs'> & { contact?: Tables<'family_contacts'> | null };
type Settings = Tables<'front_desk_settings'>;

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  screened:  { icon: ShieldCheck,     label: 'Screened',  color: 'bg-blue-500/15 text-blue-400' },
  answered:  { icon: PhoneCall,       label: 'Answered',  color: 'bg-green-500/15 text-green-400' },
  voicemail: { icon: Voicemail,       label: 'Voicemail', color: 'bg-violet-500/15 text-violet-400' },
  blocked:   { icon: Ban,             label: 'Blocked',   color: 'bg-red-500/15 text-red-400' },
  missed:    { icon: PhoneOff,        label: 'Missed',    color: 'bg-amber-500/15 text-amber-400' },
  forwarded: { icon: PhoneForwarded,  label: 'Forwarded', color: 'bg-teal-500/15 text-teal-400' },
};

const CLASS_CONFIG: Record<string, { label: string; color: string }> = {
  important:    { label: 'Important',    color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  known:        { label: 'Known',        color: 'bg-green-500/15 text-green-400 border-green-500/30' },
  unknown:      { label: 'Unknown',      color: 'bg-surface text-muted border-border' },
  spam:         { label: 'Spam',         color: 'bg-red-500/15 text-red-400 border-red-500/30' },
  robocall:     { label: 'Robocall',     color: 'bg-red-500/15 text-red-400 border-red-500/30' },
  telemarketer: { label: 'Telemarketer', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
};

type FilterTab = 'all' | 'unread' | 'important' | 'voicemail' | 'screened' | 'blocked';

function fmtTime(iso: string) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDuration(secs: number | null) {
  if (!secs) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function FrontDeskModule() {
  const { familyId, userId, role } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Call | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: calls, loading, error, refresh } = useRealtimeQuery<Call>({
    table: 'call_logs', familyId, deps: [familyId],
    fetcher: async (supabase) => {
      const { data: rows, error } = await supabase
        .from('call_logs').select('*')
        .eq('family_id', familyId).order('received_at', { ascending: false }).limit(200);
      if (error) return { data: null, error };
      if (!rows?.length) return { data: [], error: null };
      const contactIds = [...new Set(rows.map(r => r.contact_id).filter(Boolean))] as string[];
      const { data: cts } = contactIds.length
        ? await supabase.from('family_contacts').select('*').in('id', contactIds)
        : { data: [] as Tables<'family_contacts'>[] };
      const byId = new Map((cts ?? []).map(c => [c.id, c]));
      return { data: rows.map(r => ({ ...r, contact: r.contact_id ? (byId.get(r.contact_id) ?? null) : null })), error: null };
    },
  });

  const { data: settingsRows, refresh: refreshSettings } = useRealtimeQuery<Settings>({
    table: 'front_desk_settings', familyId, deps: [familyId],
    fetcher: async (supabase) => supabase.from('front_desk_settings').select('*').eq('family_id', familyId),
  });
  const settings = settingsRows[0] ?? null;

  const filtered = useMemo(() => {
    let list = calls;
    switch (filterTab) {
      case 'unread':    list = list.filter(c => !c.is_read); break;
      case 'important': list = list.filter(c => c.classification === 'important' || c.priority === 'urgent' || c.priority === 'high'); break;
      case 'voicemail': list = list.filter(c => c.status === 'voicemail'); break;
      case 'screened':  list = list.filter(c => c.status === 'screened'); break;
      case 'blocked':   list = list.filter(c => c.status === 'blocked'); break;
      default: break;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c =>
        c.caller_name?.toLowerCase().includes(q) ||
        c.caller_number?.toLowerCase().includes(q) ||
        c.contact?.name?.toLowerCase().includes(q) ||
        c.ai_summary?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [calls, filterTab, search]);

  const unreadCount = useMemo(() => calls.filter(c => !c.is_read).length, [calls]);
  const blockedCount = useMemo(() => calls.filter(c => c.status === 'blocked').length, [calls]);
  const vmCount = useMemo(() => calls.filter(c => c.status === 'voicemail').length, [calls]);

  async function markRead(call: Call) {
    if (call.is_read) return;
    const supabase = createClient();
    await supabase.from('call_logs').update({ is_read: true }).eq('id', call.id);
    void refresh();
  }

  async function deleteCall(call: Call) {
    if (busyId) return;
    setBusyId(call.id);
    const supabase = createClient();
    const { error } = await supabase.from('call_logs').delete().eq('id', call.id);
    setBusyId(null);
    if (error) { toastError(describeDbError(error)); return; }
    if (selected?.id === call.id) setSelected(null);
    void refresh();
  }

  function openDetail(call: Call) {
    setSelected(call);
    void markRead(call);
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'all',       label: 'All' },
    { key: 'unread',    label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
    { key: 'important', label: 'Important' },
    { key: 'voicemail', label: `Voicemail${vmCount > 0 ? ` (${vmCount})` : ''}` },
    { key: 'screened',  label: 'Screened' },
    { key: 'blocked',   label: 'Blocked' },
  ];

  return (
    <div className="module-with-sidebar">
      <div className="module-main">
        <div className="module-page">
          <PageHeader
            title="AI Front Desk"
            description="Your family's AI receptionist — every call screened, answered, and summarized."
            action={
              <div className="flex items-center gap-2">
                {manager && (
                  <button onClick={() => setShowSettings(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg hover:bg-elevated transition">
                    <SettingsIcon className="h-3.5 w-3.5" /> Settings
                  </button>
                )}
                <Button onClick={() => setShowLog(true)}>
                  <Phone className="h-4 w-4" /> Log Call
                </Button>
              </div>
            }
          />

          {/* Guardian status banner */}
          <div className={cn('mt-1 mb-4 flex items-center gap-3 rounded-2xl border p-4',
            settings?.enabled
              ? 'border-green-500/20 bg-gradient-to-br from-green-500/10 to-transparent'
              : 'border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-transparent')}>
            <div className={cn('grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl',
              settings?.enabled ? 'bg-green-500/15' : 'bg-amber-500/15')}>
              {settings?.enabled ? <ShieldCheck className="h-5 w-5 text-green-400" /> : <ShieldAlert className="h-5 w-5 text-amber-400" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">
                {settings?.enabled ? 'Call Guardian is active' : 'Call Guardian is off'}
              </p>
              <p className="text-xs text-muted">
                {settings?.enabled
                  ? `Screening mode: ${settings.screening_mode} · ${settings.voicemail_enabled ? 'Voicemail on' : 'Voicemail off'}`
                  : 'Turn on to screen unknown callers and block spam automatically.'}
              </p>
            </div>
            {manager && (
              <button onClick={() => setShowSettings(true)}
                className={cn('flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  settings?.enabled ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25' : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25')}>
                {settings?.enabled ? 'Manage' : 'Turn on'}
              </button>
            )}
          </div>

          {/* Outbound counterpart: Bubaly places calls FOR the family. */}
          <Link href="/dashboard/concierge-calls"
            className="mb-4 flex items-center gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4 transition hover:border-brand/40">
            <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
              <PhoneOutgoing className="h-5 w-5 text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">Have Bubaly make a call for you</p>
              <p className="text-xs text-muted">
                Book, reschedule, confirm or chase — the AI dials out with a ready call plan.
              </p>
            </div>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-brand" />
          </Link>

          {/* The paper side of the front desk: slips, forms, flyers, bills. */}
          <Link href="/dashboard/paperwork"
            className="mb-4 flex items-center gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4 transition hover:border-brand/40">
            <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
              <FileText className="h-5 w-5 text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">Paperwork Inbox — Bubaly reads it for you</p>
              <p className="text-xs text-muted">
                Slips, forms, flyers and bills → what to sign, pay and return, with the dates on your calendar.
              </p>
            </div>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-brand" />
          </Link>

          {/* Stats */}
          <div className="grid-stats">
            {[
              { label: 'Total Calls', value: calls.length,    icon: '📞', color: 'text-brand' },
              { label: 'Unread',      value: unreadCount,      icon: '🔵', color: 'text-blue-400' },
              { label: 'Voicemails',  value: vmCount,          icon: '🎙️', color: 'text-violet-400' },
              { label: 'Spam Blocked', value: blockedCount,    icon: '🛡️', color: 'text-red-400' },
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

          {/* Search + tabs */}
          <div className="mt-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted pointer-events-none" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search calls, numbers, summaries…"
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

          {/* Call list */}
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface/30">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center">
                <div className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-brand/10">
                  <PhoneIncoming className="h-7 w-7 text-brand opacity-60" />
                </div>
                <p className="text-sm font-semibold">No calls here</p>
                <p className="mt-1 text-xs text-muted">When the AI Front Desk handles a call, it shows up here.</p>
                <button onClick={() => setShowLog(true)}
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition">
                  <Phone className="h-3.5 w-3.5" /> Log a Call
                </button>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {filtered.map(call => {
                  const st = STATUS_CONFIG[call.status] ?? STATUS_CONFIG.screened;
                  const cls = CLASS_CONFIG[call.classification] ?? CLASS_CONFIG.unknown;
                  const isSelected = selected?.id === call.id;
                  return (
                    <button key={call.id} onClick={() => openDetail(call)}
                      className={cn('group w-full flex items-center gap-3 px-4 py-3.5 text-left transition hover:bg-surface/60',
                        isSelected && 'bg-brand/5 border-l-2 border-brand')}>
                      <div className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl', st.color)}>
                        <st.icon className="h-[18px] w-[18px]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn('truncate text-sm', !call.is_read ? 'font-bold' : 'font-medium')}>
                            {call.contact?.name ?? call.caller_name ?? call.caller_number ?? 'Unknown caller'}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted">{fmtTime(call.received_at)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {call.ai_summary ?? call.caller_number ?? st.label}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] text-muted">{st.label}</span>
                          <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', cls.color)}>{cls.label}</span>
                          {call.duration_secs ? <span className="text-[10px] text-muted flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />{fmtDuration(call.duration_secs)}</span> : null}
                          {(call.action_items as unknown[]).length > 0 && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                              {(call.action_items as unknown[]).length} action{(call.action_items as unknown[]).length !== 1 ? 's' : ''}
                            </span>
                          )}
                          {!call.is_read && <span className="h-1.5 w-1.5 rounded-full bg-blue-400 flex-shrink-0" />}
                        </div>
                      </div>
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
        <div className="fixed inset-0 z-50 bg-background flex flex-col pt-[var(--safe-top)] lg:pt-0 lg:static lg:inset-auto lg:z-auto lg:w-[400px] lg:rounded-2xl lg:border lg:border-border lg:bg-surface/30 lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto lg:self-start lg:sticky lg:top-4">
          <CallDetail call={selected} familyId={familyId} userId={userId} onClose={() => setSelected(null)} onDelete={() => void deleteCall(selected)} canDelete={manager} />
        </div>
      )}

      {/* Sidebar */}
      {!selected && (
        <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
          <div className="sidebar-card">
            <p className="mb-3 text-sm font-semibold">How it works</p>
            <div className="space-y-3 text-xs text-muted">
              {[
                { icon: PhoneIncoming, text: 'Every call is answered by your AI receptionist' },
                { icon: ShieldCheck,   text: 'Spam & robocalls are blocked automatically' },
                { icon: UserCheck,     text: 'Known contacts ring through to you' },
                { icon: Voicemail,     text: 'Messages are transcribed & summarized' },
                { icon: Sparkles,      text: 'Action items are extracted for you' },
              ].map((row, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg bg-brand/10">
                    <row.icon className="h-3.5 w-3.5 text-brand" />
                  </div>
                  <span className="pt-1">{row.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="sidebar-card">
            <p className="mb-3 text-sm font-semibold">By Classification</p>
            <div className="space-y-2">
              {(['important', 'known', 'unknown', 'spam'] as const).map(c => {
                const count = calls.filter(call => call.classification === c).length;
                const cfg = CLASS_CONFIG[c];
                return (
                  <div key={c} className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full flex-shrink-0', cfg.color.split(' ')[1].replace('text', 'bg'))} />
                    <span className="flex-1 text-xs text-muted">{cfg.label}</span>
                    <span className="text-xs font-semibold">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showSettings && manager && (
        <FrontDeskSettingsModal familyId={familyId} settings={settings}
          onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); void refreshSettings(); }} />
      )}
      {showLog && (
        <LogCallModal familyId={familyId} userId={userId}
          onClose={() => setShowLog(false)} onSaved={() => { setShowLog(false); void refresh(); }} />
      )}
    </div>
  );
}

function CallDetail({ call, familyId, userId, onClose, onDelete, canDelete }: {
  call: Call; familyId: string; userId: string; onClose: () => void; onDelete: () => void; canDelete: boolean;
}) {
  const { success, error: toastError } = useToast();
  const st = STATUS_CONFIG[call.status] ?? STATUS_CONFIG.screened;
  const cls = CLASS_CONFIG[call.classification] ?? CLASS_CONFIG.unknown;
  const actions = call.action_items as string[];
  const [addedItems, setAddedItems] = useState<Set<number>>(new Set());
  const [busyItem, setBusyItem] = useState<number | null>(null);

  const callerLabel = call.contact?.name ?? call.caller_name ?? call.caller_number ?? 'caller';

  // One-tap: turn a call action item into a family reminder.
  async function addReminder(text: string, i: number) {
    if (busyItem !== null) return;
    setBusyItem(i);
    const supabase = createClient();
    const { error } = await supabase.from('family_reminders').insert({
      family_id: familyId, created_by: userId,
      title: text.slice(0, 200),
      notes: `From call with ${callerLabel}`,
      kind: 'task', priority: call.priority === 'urgent' ? 'high' : 'normal',
      status: 'pending', ai_suggested: true,
    });
    setBusyItem(null);
    if (error) { toastError(describeDbError(error)); return; }
    setAddedItems(prev => new Set(prev).add(i));
    success('Added to reminders');
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 flex-shrink-0">
        <button onClick={onClose} aria-label="Back" className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className={cn('grid h-9 w-9 place-items-center rounded-xl flex-shrink-0', st.color)}>
          <st.icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{call.contact?.name ?? call.caller_name ?? call.caller_number ?? 'Unknown'}</div>
          <div className="text-[10px] text-muted">{st.label} · {fmtTime(call.received_at)}</div>
        </div>
        {canDelete && (
          <button onClick={onDelete} className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-red-400" title="Delete">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          <span className={cn('rounded-md border px-2 py-0.5 text-[11px] font-semibold', cls.color)}>{cls.label}</span>
          <span className="rounded-md bg-surface border border-border px-2 py-0.5 text-[11px] font-semibold capitalize">{call.direction}</span>
          {call.priority !== 'normal' && (
            <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize',
              call.priority === 'urgent' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400')}>
              {call.priority}
            </span>
          )}
        </div>

        {call.caller_number && (
          <div className="flex items-center gap-2 text-sm">
            <Phone className="h-3.5 w-3.5 text-muted" />
            <span>{call.caller_number}</span>
            {call.duration_secs ? <span className="text-xs text-muted">· {fmtDuration(call.duration_secs)}</span> : null}
          </div>
        )}

        {call.ai_summary && (
          <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              <span className="text-[10px] font-semibold text-brand uppercase tracking-wide">AI Summary</span>
            </div>
            <p className="text-xs leading-relaxed text-fg/80">{call.ai_summary}</p>
          </div>
        )}

        {call.voicemail_url && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">Voicemail</p>
            <audio controls src={call.voicemail_url} className="w-full h-9" />
          </div>
        )}

        {actions.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-amber-400" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Action Items</p>
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
                      {added ? <><Check className="h-3 w-3" /> Added</>
                        : busyItem === i ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <><Bell className="h-3 w-3" /> Remind</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {call.transcript && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Transcript</p>
            <p className="text-xs whitespace-pre-wrap leading-relaxed text-fg/80">{call.transcript}</p>
          </div>
        )}

        {call.contact && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">Contact</p>
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface/60 px-3 py-2.5">
              <Avatar name={call.contact.name} src={call.contact.photo_url} size={36} />
              <div>
                <div className="text-sm font-semibold">{call.contact.name}</div>
                <div className="text-[11px] text-muted capitalize">{call.contact.category}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FrontDeskSettingsModal({ familyId, settings, onClose, onSaved }: {
  familyId: string; settings: Settings | null; onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [blockSpam, setBlockSpam] = useState(settings?.block_spam ?? true);
  const [blockUnknown, setBlockUnknown] = useState(settings?.block_unknown ?? false);
  const [voicemail, setVoicemail] = useState(settings?.voicemail_enabled ?? true);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const greeting = String(form.get('greeting') ?? '').trim();
    const screening_mode = String(form.get('screening_mode') ?? 'smart');
    const forward_number = String(form.get('forward_number') ?? '').trim() || null;

    if (greeting.length > 1000) return toastError('Greeting is too long (max 1000 characters)');

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('front_desk_settings').upsert({
      family_id: familyId,
      enabled, screening_mode, voicemail_enabled: voicemail,
      block_spam: blockSpam, block_unknown: blockUnknown,
      forward_number, greeting: greeting || undefined,
    }, { onConflict: 'family_id' });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  const Toggle = ({ on, onClick, label, desc }: { on: boolean; onClick: () => void; label: string; desc: string }) => (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-left transition hover:bg-surface/60">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] text-muted">{desc}</div>
      </div>
      <div className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition', on ? 'bg-brand' : 'bg-elevated')}>
        <div className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </div>
    </button>
  );

  return (
    <Modal open title="Front Desk Settings" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Toggle on={enabled} onClick={() => setEnabled(v => !v)}
          label="Enable AI Front Desk" desc="Answer & screen every incoming call" />
        <Field label="AI greeting">
          {id => <Textarea id={id} name="greeting" rows={3} defaultValue={settings?.greeting ?? ''}
            placeholder="Hi! You've reached the family. I'm their AI assistant — how can I help?" />}
        </Field>
        <Field label="Screening mode">
          {id => (
            <Select id={id} name="screening_mode" defaultValue={settings?.screening_mode ?? 'smart'}>
              <option value="off">Off — ring everything through</option>
              <option value="smart">Smart — AI decides (recommended)</option>
              <option value="strict">Strict — screen all unknown callers</option>
              <option value="allowlist">Allowlist — only known contacts</option>
            </Select>
          )}
        </Field>
        <Toggle on={blockSpam} onClick={() => setBlockSpam(v => !v)}
          label="Block spam & robocalls" desc="Automatically reject flagged numbers" />
        <Toggle on={blockUnknown} onClick={() => setBlockUnknown(v => !v)}
          label="Block unknown callers" desc="Send unrecognized numbers to voicemail" />
        <Toggle on={voicemail} onClick={() => setVoicemail(v => !v)}
          label="Voicemail" desc="Take & transcribe messages when you can't answer" />
        <Field label="Forward urgent calls to (optional)">
          {id => <Input id={id} name="forward_number" defaultValue={settings?.forward_number ?? ''} placeholder="+1 555 123 4567" />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : 'Save Settings'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const VALID_CLASS = new Set(Object.keys(CLASS_CONFIG));
const VALID_PRIORITY = new Set(['low', 'normal', 'high', 'urgent']);

function LogCallModal({ familyId, userId, onClose, onSaved }: {
  familyId: string; userId: string; onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // Controlled fields so "Analyze with AI" can populate them.
  const [callerName, setCallerName] = useState('');
  const [callerNumber, setCallerNumber] = useState('');
  const [status, setStatus] = useState('screened');
  const [classification, setClassification] = useState('unknown');
  const [priority, setPriority] = useState('normal');
  const [summary, setSummary] = useState('');
  const [transcript, setTranscript] = useState('');
  const [actionItems, setActionItems] = useState<string[]>([]);

  // The AI Call Guardian brain: read the transcript, classify the caller, extract
  // a summary + action items + priority. Fills the form for one-tap review & save.
  async function analyze() {
    if (!transcript.trim() || analyzing) return;
    setAnalyzing(true);
    try {
      const res = await fetch('/api/ai/assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: `You are an AI call-screening assistant for a family. Read the call transcript or voicemail and respond with ONLY a JSON object (no markdown, no prose) of this exact shape:
{"summary": string, "classification": one of ["important","known","unknown","spam","robocall","telemarketer"], "priority": one of ["low","normal","high","urgent"], "action_items": string[]}
Keep the summary to one sentence. action_items are concrete follow-ups for the family (empty array if none).`,
          messages: [{ role: 'user', content: `${callerName ? `Caller: ${callerName}\n` : ''}${callerNumber ? `Number: ${callerNumber}\n` : ''}Transcript:\n${transcript}` }],
          maxTokens: 400,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toastError(data.error ?? 'Could not analyze the call.'); return; }
      let parsed: { summary?: string; classification?: string; priority?: string; action_items?: unknown };
      try {
        const raw = String(data.message ?? '').replace(/```json\s*|\s*```/g, '').trim();
        parsed = JSON.parse(raw);
      } catch {
        // Fall back to using the raw text as the summary if it isn't valid JSON.
        setSummary(String(data.message ?? '').slice(0, 500));
        success('AI summary added');
        return;
      }
      if (parsed.summary) setSummary(String(parsed.summary).slice(0, 500));
      if (parsed.classification && VALID_CLASS.has(parsed.classification)) setClassification(parsed.classification);
      if (parsed.priority && VALID_PRIORITY.has(parsed.priority)) setPriority(parsed.priority);
      if (Array.isArray(parsed.action_items)) setActionItems(parsed.action_items.map(String).filter(Boolean).slice(0, 10));
      success('AI analyzed the call');
    } catch {
      toastError('Could not reach the AI. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    if (!callerName.trim() && !callerNumber.trim()) return toastError('Add a caller name or number');

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('call_logs').insert({
      family_id: familyId, created_by: userId,
      caller_name: callerName.trim() || null, caller_number: callerNumber.trim() || null,
      status, classification, priority,
      ai_summary: summary.trim() || null, transcript: transcript.trim() || null,
      action_items: actionItems,
      direction: 'inbound', is_read: false,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Log a Call" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Caller name">{id => <Input id={id} value={callerName} onChange={e => setCallerName(e.target.value)} placeholder="Dr. Smith's office" />}</Field>
          <Field label="Number">{id => <Input id={id} value={callerNumber} onChange={e => setCallerNumber(e.target.value)} placeholder="+1 555 …" />}</Field>
        </div>

        <Field label="Transcript / Voicemail / Notes">
          {id => <Textarea id={id} value={transcript} onChange={e => setTranscript(e.target.value)} rows={3} placeholder="Paste the voicemail or what was discussed…" />}
        </Field>
        <button type="button" onClick={analyze} disabled={!transcript.trim() || analyzing}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand/10 px-3 py-2 text-xs font-semibold text-brand hover:bg-brand/20 transition disabled:opacity-50">
          {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {analyzing ? 'Analyzing…' : 'Analyze with AI'}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            {id => <Select id={id} value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}
          </Field>
          <Field label="Classification">
            {id => <Select id={id} value={classification} onChange={e => setClassification(e.target.value)}>{Object.entries(CLASS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}
          </Field>
        </div>
        <Field label="Priority">
          {id => <Select id={id} value={priority} onChange={e => setPriority(e.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}
        </Field>
        <Field label="AI summary">
          {id => <Input id={id} value={summary} onChange={e => setSummary(e.target.value)} placeholder="Confirming Emma's appointment for Thursday 3pm" />}
        </Field>

        {actionItems.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Action items (AI)</p>
            <div className="space-y-1">
              {actionItems.map((a, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-amber-500/8 border border-amber-500/20 px-2.5 py-1.5">
                  <CheckCircle2 className="h-3 w-3 text-amber-400 flex-shrink-0" />
                  <span className="flex-1 text-[11px] text-fg/90">{a}</span>
                  <button type="button" onClick={() => setActionItems(items => items.filter((_, j) => j !== i))} className="text-muted hover:text-red-400">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : 'Log Call'}</Button>
        </div>
      </form>
    </Modal>
  );
}
