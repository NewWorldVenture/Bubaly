'use client';

import { useState, useMemo, useRef } from 'react';
import {
  Phone, PhoneIncoming, PhoneOff, PhoneForwarded, Voicemail, ShieldCheck,
  ShieldAlert, Ban, Clock, Search, X, ArrowLeft, Settings as SettingsIcon,
  Sparkles, CheckCircle2, PhoneCall, UserCheck, Bell, Check, Loader2,
  PhoneOutgoing, ArrowRight, FileText, AlertTriangle, Inbox as InboxIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Call = Tables<'call_logs'> & { contact?: Tables<'family_contacts'> | null };

/**
 * The family's real contact identity (`family_contact_channels`, 0214) — the
 * number and address inbound calls actually arrive on. It replaces
 * `front_desk_settings` (0092), which no route ever wrote and no telephony ever
 * consulted: a screening toggle that governed nothing.
 */
export type FrontDeskChannel = {
  phone_number: string | null;
  email_local: string | null;
  provisioning_status: string;
  ai_concierge_enabled: boolean;
  forward_to_phone: string | null;
};

/** A voice row the Contact Center filed (`family_inbox_messages`, 0214). */
export type FrontDeskVoiceMessage = {
  id: string;
  from_addr: string | null;
  body: string | null;
  ai_summary: string | null;
  ai_intent: string | null;
  ai_handled: boolean;
  status: string;
  occurred_at: string;
};

/** Which server read failed, so the page says so rather than showing an empty list. */
export type FrontDeskUnavailable = { channel: boolean; voice: boolean };

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

type FilterTab = 'all' | 'important' | 'voicemail' | 'screened' | 'blocked';

/**
 * Stat tiles. Every one of them counts the SAME persisted rows — the voice
 * messages the Contact Center filed — so one failed read invalidates all three
 * together and they can be blanked as a group.
 *
 * There used to be a fourth, labelled "Voicemail", counting `call_logs` rows
 * somebody typed by hand. It sat beside three live numbers, went to 0 without a
 * word when its own query failed, and every live voice row already IS a
 * transcribed voicemail. It is gone; the frozen log keeps its own section.
 */
const STATS = [
  { key: 'calls',  label: 'Calls',  labelKey: 'frontDesk.calls',  icon: '📞', color: 'text-brand-text' },
  // "Filed", not "Handled": `ai_handled` proves a request was persisted, which
  // is Bubaly having taken the message on — not the work being finished.
  { key: 'filed',  label: 'Filed',  labelKey: 'frontDesk.filed',  icon: '📥', color: 'text-green-400' },
  { key: 'urgent', label: 'Urgent', labelKey: 'frontDesk.urgent', icon: '🚨', color: 'text-red-400' },
] as const;

const HOW_IT_WORKS = [
  { icon: PhoneIncoming, text: 'Calls to the family number reach the concierge', textKey: 'frontDesk.callsToTheFamilyNumberReach' },
  { icon: ShieldCheck,   text: 'Each one is classified before anyone is woken',  textKey: 'frontDesk.eachOneIsClassifiedBefore' },
  { icon: UserCheck,     text: 'Urgent calls are forwarded to your fallback',    textKey: 'frontDesk.urgentCallsAreForwardedTo' },
  { icon: Voicemail,     text: 'Voicemail is transcribed into the inbox',        textKey: 'frontDesk.voicemailIsTranscribedInto' },
  { icon: Sparkles,      text: 'Handle it files the message with the planner',   textKey: 'frontDesk.handleItFilesTheMessage' },
] as const;

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

/**
 * The AI Front Desk, pointed at the tables that actually carry telephony.
 *
 * WHAT CHANGED AND WHY: this surface used to read `call_logs` and
 * `front_desk_settings` (0092) — a call log a human typed by hand and a
 * screening toggle nothing consulted. Every real inbound call already lands in
 * `family_inbox_messages` as a `voice` row (0214, the Contact Center webhooks),
 * and the family's real number lives on `family_contact_channels`. So the live
 * half of this page now reads those, and `call_logs` stays as read-only history
 * of what was typed before. Nothing here writes either legacy table any more:
 * a hand-entered "call" that looks like telephony is exactly the claim the
 * honesty rule forbids.
 *
 * Both reads happen on the server (`app/(app)/dashboard/front-desk/page.tsx`)
 * and arrive as props, including which of them failed — `unavailable` renders a
 * retryable notice rather than an empty list that would read as "no calls".
 */
export function FrontDeskModule({ channel, voice, unavailable }: {
  channel: FrontDeskChannel | null;
  voice: FrontDeskVoiceMessage[];
  unavailable?: FrontDeskUnavailable;
}) {
  const tr = useTranslations();
  const { familyId, userId } = useApp();
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Call | null>(null);
  const [showHistory, setShowHistory] = useState(false);

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


  const filtered = useMemo(() => {
    let list = calls;
    switch (filterTab) {
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

  const blockedCount = useMemo(() => calls.filter(c => c.status === 'blocked').length, [calls]);
  // What the family's real number actually did — read from the rows the
  // webhooks filed, never from a toggle.
  const voiceHandled = useMemo(() => voice.filter(v => v.ai_handled).length, [voice]);
  const voiceUrgent = useMemo(() => voice.filter(v => v.ai_intent === 'urgent').length, [voice]);
  const numberLive = channel?.provisioning_status === 'active' && !!channel.phone_number;

  // No mark-read, no delete, no hand-entered call: `call_logs` is frozen
  // history now. Opening a row reads it; nothing about it is written back.
  function openDetail(call: Call) {
    setSelected(call);
  }

  // The legacy log failing must not take the live voice inbox down with it, so
  // its loading/error states are rendered inside its own section below.
  const TABS: { key: FilterTab; labelKey: string }[] = [
    { key: 'all',       labelKey: 'frontDesk.all' },
    { key: 'important', labelKey: 'frontDesk.important' },
    { key: 'voicemail', labelKey: 'frontDesk.voicemail' },
    { key: 'screened',  labelKey: 'frontDesk.screened' },
    { key: 'blocked',   labelKey: 'frontDesk.blocked' },
  ];

  return (
    <div className="module-with-sidebar">
      <div className="module-main">
        <div className="module-page">
          <PageHeader
            title={tr('frontDesk.aiFrontDesk')}
            description={tr('frontDeskModule.yourFamilySAiReceptionist')}
            action={
              <div className="flex items-center gap-2">
                <Link href="/dashboard/contact-center"
                  className="flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg hover:bg-elevated transition">
                  <SettingsIcon className="h-3.5 w-3.5" /> {tr('frontDesk.manageNumberAndAddress')}
                </Link>
              </div>
            }
          />

          {/* The front desk's real identity, read from family_contact_channels.
              It says what is true: a number that is live, one that is still
              being provisioned, or none at all. Never "Guardian is active" off
              a toggle no telephony consulted. */}
          {unavailable?.channel ? (
            <div className="mt-1 mb-4 flex items-center gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-400" />
              <p className="min-w-0 flex-1 text-xs text-muted">{tr('frontDesk.theFrontDeskSettingsCouldNot')}</p>
            </div>
          ) : (
            <div className={cn('mt-1 mb-4 flex items-center gap-3 rounded-2xl border p-4',
              numberLive
                ? 'border-green-500/20 bg-gradient-to-br from-green-500/10 to-transparent'
                : 'border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-transparent')}>
              <div className={cn('grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl',
                numberLive ? 'bg-green-500/15' : 'bg-amber-500/15')}>
                {numberLive ? <ShieldCheck className="h-5 w-5 text-green-400" /> : <ShieldAlert className="h-5 w-5 text-amber-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">
                  {numberLive ? tr('frontDesk.theFamilyNumberIsAnswering') : tr('frontDesk.noFamilyNumberYet')}
                </p>
                <p className="truncate text-xs text-muted">
                  {numberLive
                    ? `${channel?.phone_number}${channel?.ai_concierge_enabled ? '' : ` · ${tr('frontDesk.conciergeOff')}`}`
                    : channel?.provisioning_status === 'pending'
                      ? tr('frontDesk.aNumberHasBeenRequested')
                      : tr('frontDesk.setOneUpInTheContactCenter')}
                </p>
              </div>
              <Link href="/dashboard/contact-center"
                className={cn('flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  numberLive ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25' : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25')}>
                {tr('frontDesk.manage')}
              </Link>
            </div>
          )}

          {/* The live half: voice rows the Contact Center webhooks filed. */}
          <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-surface/30">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Voicemail className="h-4 w-4 text-brand-text" />
              <p className="flex-1 text-sm font-semibold">{tr('frontDesk.callsToTheFamilyNumber')}</p>
              {/* Same rule as the tiles: a count of rows nobody could read is
                  not 0, so the card header carries no number at all. */}
              <span className="text-[11px] text-muted">{unavailable?.voice ? '—' : voice.length}</span>
            </div>
            {unavailable?.voice ? (
              <div className="flex items-center gap-3 px-4 py-6">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" />
                <p className="text-xs text-muted">{tr('frontDesk.theVoiceInboxCouldNotBe')}</p>
              </div>
            ) : voice.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <InboxIcon className="mb-3 h-6 w-6 text-muted opacity-60" />
                <p className="text-sm font-semibold">{tr('frontDesk.nothingHasCalledYet')}</p>
                <p className="mt-1 text-xs text-muted">{tr('frontDesk.everyCallToTheFamilyNumber')}</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {voice.slice(0, 25).map(v => (
                  <div key={v.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-violet-500/15 text-violet-400">
                      <PhoneIncoming className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('truncate text-sm', v.status === 'new' ? 'font-bold' : 'font-medium')}>
                          {v.from_addr || tr('frontDesk.unknownCaller')}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted">{fmtTime(v.occurred_at)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{v.ai_summary || v.body || ''}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {v.ai_intent && (
                          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">{v.ai_intent}</span>
                        )}
                        {/* Only from the row: `ai_handled` is written after a
                            request was persisted, never optimistically — and
                            that is ALL it proves. The run may still be queued,
                            waiting on a parent's answer, or failed, so the
                            badge claims the thing the flag establishes (the
                            message reached Bubaly) and not the outcome. */}
                        {v.ai_handled && (
                          <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
                            {tr('frontDesk.filedWithBubaly')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Link href="/dashboard/inbox"
              className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs font-semibold text-brand-text transition hover:bg-surface/60">
              {tr('frontDesk.seeTheWholeHouseholdInbox')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {/* Outbound counterpart: Bubaly places calls FOR the family. */}
          <Link href="/dashboard/concierge-calls"
            className="mb-4 flex items-center gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4 transition hover:border-brand/40">
            <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
              <PhoneOutgoing className="h-5 w-5 text-brand-text" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{tr('frontDesk.haveBubalyMakeACallFor')}</p>
              <p className="text-xs text-muted">
                {tr('frontDesk.bookRescheduleConfirmOrChaseThe')}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-brand-text" />
          </Link>

          {/* The paper side of the front desk: slips, forms, flyers, bills. */}
          <Link href="/dashboard/paperwork"
            className="mb-4 flex items-center gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4 transition hover:border-brand/40">
            <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
              <FileText className="h-5 w-5 text-brand-text" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{tr('frontDesk.paperworkInboxBubalyReadsItFor')}</p>
              <p className="text-xs text-muted">
                {tr('frontDesk.slipsFormsFlyersAndBillsWhat')}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-brand-text" />
          </Link>

          {/* Stats — every number below is a count of persisted rows, and when
              the read that would have produced them failed there is no number
              to show. An em dash, never a 0: "nothing called" and "the database
              did not answer" are different facts, and three tiles reading
              0 Calls / 0 Filed / 0 Urgent over a failed read assert the first
              while the truth is the second. */}
          <div className="grid-stats">
            {STATS.map(stat => (
              <div key={stat.key} className="stat-card">
                <span className="text-2xl">{stat.icon}</span>
                <div>
                  <div className={cn('text-2xl font-bold', unavailable?.voice ? 'text-muted' : stat.color)}>
                    {unavailable?.voice
                      ? '—'
                      : stat.key === 'calls' ? voice.length
                        : stat.key === 'filed' ? voiceHandled
                          : voiceUrgent}
                  </div>
                  <div className="text-[11px] text-muted">{tr(stat.labelKey)}</div>
                </div>
              </div>
            ))}
          </div>
          {unavailable?.voice && (
            <p className="mt-1 px-1 text-[11px] text-muted">{tr('frontDesk.theseCountsCouldNotBe')}</p>
          )}

          {/* The frozen half: what someone typed into the old call log before
              the family had a number. Readable, never written. */}
          <button type="button" onClick={() => setShowHistory(v => !v)}
            className="mt-2 flex w-full items-center gap-2 rounded-xl border border-border bg-surface/40 px-4 py-3 text-left transition hover:bg-surface/60">
            <Clock className="h-4 w-4 flex-shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{tr('frontDesk.earlierCallLog')}</span>
              <span className="block text-[11px] text-muted">{tr('frontDesk.entriesTypedByHandBeforeThe')}</span>
            </span>
            <span className="flex-shrink-0 text-xs font-semibold text-brand-text">
              {showHistory ? tr('frontDesk.hide') : tr('frontDesk.show')}
            </span>
          </button>

          {showHistory && loading && <div className="mt-4"><SkeletonList /></div>}
          {showHistory && !loading && error && (
            <div className="mt-4"><ErrorState message={error} onRetry={refresh} /></div>
          )}

          {/* Search + tabs */}
          {showHistory && !loading && !error && (
          <>
          <div className="mt-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted pointer-events-none" />
              <input value={search} inputMode="search" enterKeyHint="search" onChange={e => setSearch(e.target.value)}
                placeholder={tr('frontDesk.searchCallsNumbersSummaries')}
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
                  {tr(t.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Call list */}
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface/30">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center">
                <div className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-brand/10">
                  <PhoneIncoming className="h-7 w-7 text-brand-text opacity-60" />
                </div>
                <p className="text-sm font-semibold">{tr('frontDesk.noCallsHere')}</p>
                <p className="mt-1 text-xs text-muted">{tr('frontDesk.nothingWasEverTypedIntoThe')}</p>
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
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          </>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)] lg:pt-0 lg:pb-0 lg:pl-0 lg:pr-0 lg:static lg:inset-auto lg:z-auto lg:w-[400px] lg:rounded-2xl lg:border lg:border-border lg:bg-surface/30 lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto lg:self-start lg:sticky lg:top-4">
          <CallDetail call={selected} familyId={familyId} userId={userId} onClose={() => setSelected(null)} />
        </div>
      )}

      {/* Sidebar */}
      {!selected && (
        <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
          <div className="sidebar-card">
            <p className="mb-3 text-sm font-semibold">{tr('frontDesk.howItWorks')}</p>
            <div className="space-y-3 text-xs text-muted">
              {HOW_IT_WORKS.map((row, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg bg-brand/10">
                    <row.icon className="h-3.5 w-3.5 text-brand-text" />
                  </div>
                  <span className="pt-1">{tr(row.textKey)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="sidebar-card">
            <p className="mb-3 text-sm font-semibold">{tr('frontDesk.byClassification')}</p>
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

    </div>
  );
}

function CallDetail({ call, familyId, userId, onClose }: {
  call: Call; familyId: string; userId: string; onClose: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const st = STATUS_CONFIG[call.status] ?? STATUS_CONFIG.screened;
  const cls = CLASS_CONFIG[call.classification] ?? CLASS_CONFIG.unknown;
  const actions = call.action_items as string[];
  const [addedItems, setAddedItems] = useState<Set<number>>(new Set());
  const [busyItem, setBusyItem] = useState<number | null>(null);
  // One submission id per action item, keyed by CALL AND INDEX — not index alone.
  //
  // `<CallDetail call={selected} />` is rendered without a `key`, so selecting a
  // different call re-renders this instance with a new prop rather than
  // remounting it, and this ref survives. Keyed by position, call B's first
  // action item would reuse call A's id, the server would answer with the row
  // that id already created, and call B's reminder would silently never exist —
  // the exact failure the idempotency key is here to prevent, caused by the key.
  const reminderIds = useRef<Record<string, string>>({});

  const callerLabel = call.contact?.name ?? call.caller_name ?? call.caller_number ?? 'caller';

  // One-tap: turn a call action item into a family reminder.
  async function addReminder(text: string, i: number) {
    if (busyItem !== null) return;
    setBusyItem(i);
    // One id per action item, so tapping the same item again after a failure is
    // the same reminder while a different item is a different one.
    // Through the service. The raw insert sent `status: 'pending'` and, off the
    // urgent branch, `priority: 'normal'` — neither is in 0014's CHECK sets, so
    // Postgres rejected the row and this button never once saved a reminder.
    const result = await createReminderAction({
      title: text.slice(0, 200),
      notes: `From call with ${callerLabel}`,
      kind: 'task',
      priority: call.priority === 'urgent' ? 'high' : 'medium',
      aiSuggested: true,
      submissionId: reminderIds.current[`${call.id}:${i}`] ||= newSubmissionId(),
    });
    setBusyItem(null);
    if (!result.ok) { toastError(result.error); return; }
    setAddedItems(prev => new Set(prev).add(i));
    success(tr('frontDeskModule.addedToReminders'));
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 flex-shrink-0">
        <button onClick={onClose} aria-label={tr('frontDesk.back')} className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className={cn('grid h-9 w-9 place-items-center rounded-xl flex-shrink-0', st.color)}>
          <st.icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{call.contact?.name ?? call.caller_name ?? call.caller_number ?? 'Unknown'}</div>
          <div className="text-[10px] text-muted">{st.label} · {fmtTime(call.received_at)}</div>
        </div>
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
              <Sparkles className="h-3.5 w-3.5 text-brand-text" />
              <span className="text-[10px] font-semibold text-brand-text uppercase tracking-wide">{tr('frontDesk.aiSummary')}</span>
            </div>
            <p className="text-xs leading-relaxed text-fg/80">{call.ai_summary}</p>
          </div>
        )}

        {call.voicemail_url && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">{tr('frontDesk.voicemail')}</p>
            <audio controls src={call.voicemail_url} className="w-full h-9" />
          </div>
        )}

        {actions.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-amber-400" />
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{tr('frontDesk.actionItems')}</p>
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
                      {added ? <><Check className="h-3 w-3" /> {tr('frontDesk.added')}</>
                        : busyItem === i ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <><Bell className="h-3 w-3" /> {tr('frontDesk.remind')}</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {call.transcript && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">{tr('frontDesk.transcript')}</p>
            <p className="text-xs whitespace-pre-wrap leading-relaxed text-fg/80">{call.transcript}</p>
          </div>
        )}

        {call.contact && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">{tr('frontDesk.contact')}</p>
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
