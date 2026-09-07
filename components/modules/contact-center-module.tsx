'use client';

// The Family Operations Center (Family+). Shows the family's central contact
// identity — a dedicated @bubaly.com address + phone number — the AI concierge
// controls, and the unified inbox that every inbound call / text / email routes
// into. Assign controls are parent-only (server-enforced too).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Headset, Mail, Phone, Bot, Mail as MailIcon, MessageSquare, Voicemail,
  Check, Loader2, ArrowRight, Inbox, ShieldCheck, Archive, Circle,
} from 'lucide-react';
import type { Tables } from '@/lib/database.types';
import type { InboxRow } from '@/app/(app)/dashboard/contact-center/page';
import { buildBubalyAddress, normalizeEmailLocal, isValidEmailLocal, BUBALY_DOMAIN } from '@/lib/contact-center/address';
import { formatPhone } from '@/lib/contact-center/phone';
import { intentMeta } from '@/lib/contact-center/routing';
import {
  assignEmailAction, provisionNumberAction, updateConciergeAction, setMessageStatusAction,
} from '@/app/(app)/dashboard/contact-center/actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Channel = Tables<'family_contact_channels'> | null;

const CHANNEL_ICON: Record<string, typeof MailIcon> = { email: MailIcon, sms: MessageSquare, voice: Voicemail };

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ContactCenterModule({ channel, messages, suggestedLocal, twilioReady, canManage }: {
  channel: Channel; messages: InboxRow[]; suggestedLocal: string; twilioReady: boolean; canManage: boolean;
}) {
  const tr = useTranslations();
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState(channel?.email_local ?? suggestedLocal);
  const [greeting, setGreeting] = useState(channel?.ai_greeting ?? '');
  const [forwardTo, setForwardTo] = useState(channel?.forward_to_phone ?? '');
  const [areaCode, setAreaCode] = useState('');

  const email = channel?.email_local ? buildBubalyAddress(channel.email_local) : null;
  const phone = channel?.phone_number ?? null;
  const conciergeOn = channel?.ai_concierge_enabled !== false;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) { setErr(res.error ?? 'Something went wrong.'); return; }
      router.refresh();
    });
  }

  return (
    <div className="module-page space-y-5">
      <header className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><Headset className="h-6 w-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('contactCenter.operationsCenter')}</h1>
          <p className="mt-1 text-sm text-muted">{tr('contactCenterModule.yourFamilySOneAddress')}</p>
        </div>
      </header>

      {err && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}

      {/* Identity cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Email */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center gap-2"><Mail className="h-4 w-4 text-brand-text" /><h2 className="text-sm font-bold">{t('contactCenter.familyEmailAddress')}</h2></div>
          {email ? (
            <p className="text-lg font-semibold tracking-tight">{email}</p>
          ) : (
            <p className="text-sm text-muted">{t('contactCenter.notAssignedYet')}</p>
          )}
          {canManage && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-bg px-2">
                <input
                  value={local}
                  onChange={(e) => setLocal(normalizeEmailLocal(e.target.value))}
                  placeholder="smith-family"
                  aria-label={t('contactCenter.emailAddressName')}
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
                <span className="shrink-0 text-sm text-muted">@{BUBALY_DOMAIN}</span>
              </div>
              <button
                type="button" disabled={pending || !isValidEmailLocal(local) || local === channel?.email_local}
                onClick={() => run(() => assignEmailAction(local))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {email ? 'Update' : 'Assign'}
              </button>
            </div>
          )}
        </div>

        {/* Phone */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center gap-2"><Phone className="h-4 w-4 text-brand-text" /><h2 className="text-sm font-bold">{t('contactCenter.familyPhoneNumber')}</h2></div>
          {phone ? (
            <p className="text-lg font-semibold tracking-tight">{formatPhone(phone)}</p>
          ) : channel?.provisioning_status === 'pending' ? (
            <p className="text-sm text-amber-500">{t('contactCenter.requestedActivatingShortly')}</p>
          ) : (
            <p className="text-sm text-muted">{t('contactCenter.noDedicatedNumberYet')}</p>
          )}
          {canManage && !phone && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                placeholder={t('contactCenter.areaCode')} inputMode="numeric" aria-label={t('contactCenter.preferredAreaCode')}
                className="h-9 w-28 rounded-lg border border-border bg-bg px-3 text-sm outline-none" />
              <button
                type="button" disabled={pending}
                onClick={() => run(() => provisionNumberAction(areaCode))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                {t('contactCenter.getANumber')}
              </button>
            </div>
          )}
          {!twilioReady && !phone && (
            <p className="mt-2 text-xs text-muted">{t('contactCenter.telephonyActivatesOnceTwilioIsConnected')}</p>
          )}
        </div>
      </div>

      {/* AI concierge controls */}
      {canManage && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-brand-text" /><h2 className="text-sm font-bold">{t('contactCenter.aiConcierge')}</h2></div>
            <button
              type="button" disabled={pending}
              onClick={() => run(() => updateConciergeAction({ enabled: !conciergeOn }))}
              className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition',
                conciergeOn ? 'bg-emerald-500/15 text-emerald-500' : 'bg-elevated text-muted')}>
              <ShieldCheck className="h-3.5 w-3.5" /> {conciergeOn ? 'On' : 'Off'}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted">{t('contactCenter.answersCallsTextsSummarizesThemFor')}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">{t('contactCenter.greeting')}</span>
              <textarea
                value={greeting} onChange={(e) => setGreeting(e.target.value)} rows={2}
                placeholder={tr('contactCenter.hiYouveReachedTheSmithsI')}
                className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-brand" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">{t('contactCenter.urgentFallbackNumber')}</span>
              <input
                value={forwardTo} onChange={(e) => setForwardTo(e.target.value)}
                placeholder="+1 555 123 4567"
                className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-brand" />
            </label>
          </div>
          <button
            type="button" disabled={pending}
            onClick={() => run(() => updateConciergeAction({ greeting, forwardTo: forwardTo.trim() || null }))}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold transition hover:bg-elevated disabled:opacity-50">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {t('contactCenter.saveConciergeSettings')}
          </button>
        </div>
      )}

      {/* Unified inbox */}
      <div>
        <div className="mb-3 flex items-center gap-2"><Inbox className="h-4 w-4 text-muted" /><h2 className="text-lg font-bold">{t('contactCenter.inbox')}</h2>
          <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold text-muted">{messages.length}</span>
        </div>
        {messages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <p className="text-sm font-semibold">{t('contactCenter.nothingHereYet')}</p>
            <p className="mt-1 text-xs text-muted">{t('contactCenter.callsTextsAndEmailsToYour')}</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {messages.map((m) => {
              const Icon = CHANNEL_ICON[m.channel] ?? MailIcon;
              const meta = intentMeta(m.ai_intent ?? 'other');
              const outbound = m.direction === 'outbound';
              return (
                <li key={m.id} className={cn('rounded-2xl border border-border bg-card p-4', m.status === 'new' && !outbound && 'ring-1 ring-brand/30')}>
                  <div className="flex items-start gap-3">
                    <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated', meta.tone)}><Icon className="h-4.5 w-4.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {outbound
                          ? <span className="text-[10px] font-bold uppercase tracking-wide text-muted">{t('contactCenter.conciergeReply')}</span>
                          : <span className={cn('text-[10px] font-bold uppercase tracking-wide', meta.tone)}>{meta.emoji} {meta.label}</span>}
                        <span className="text-xs text-muted">{outbound ? `to ${formatPhone(m.to_addr) }` : `from ${m.from_addr ? formatPhone(m.from_addr) : 'unknown'}`}</span>
                        <span className="ml-auto text-[11px] text-muted/70">{timeAgo(m.occurred_at)}</span>
                      </div>
                      <p className="mt-1 text-sm text-fg">{m.ai_summary || m.body}</p>
                      {!outbound && (
                        <div className="mt-2 flex items-center gap-3">
                          {m.status !== 'read' && (
                            <button type="button" disabled={pending} onClick={() => run(() => setMessageStatusAction(m.id, 'read'))}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg disabled:opacity-50"><Circle className="h-3 w-3" /> {t('contactCenter.markRead')}</button>
                          )}
                          {m.status !== 'archived' && (
                            <button type="button" disabled={pending} onClick={() => run(() => setMessageStatusAction(m.id, 'archived'))}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg disabled:opacity-50"><Archive className="h-3 w-3" /> {t('contactCenter.archive')}</button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ArrowRight className="h-3.5 w-3.5" /> {t('contactCenter.everythingRoutesToOnePlaceYour')}
      </p>
    </div>
  );
}
