'use client';

import { useState, useTransition } from 'react';
import { Copy, Check, Share2, Ticket, Mail } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { fmtDate, fmtMoney } from '@/lib/utils/format';
import { applyReferralCodeAction, sendReferralEmailAction } from '@/app/(app)/referrals/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

type Row = { id: string; email: string | null; status: string; rewardCents: number; createdAt: string };

const STATUS_STYLE: Record<string, string> = {
  signed_up: 'bg-blue-500/15 text-blue-300',
  converted: 'bg-emerald-500/15 text-emerald-300',
  rewarded: 'bg-emerald-500/15 text-emerald-300',
  pending: 'bg-elevated text-muted',
  void: 'bg-rose-500/15 text-rose-300',
};
const STATUS_LABEL: Record<string, { label: string; labelKey: string }> = {
  signed_up: { label: 'Signed up', labelKey: 'referralPanel.statusSignedUp' },
  converted: { label: 'Upgraded', labelKey: 'referralPanel.statusConverted' },
  rewarded: { label: 'Rewarded', labelKey: 'referralPanel.statusRewarded' },
  pending: { label: 'Pending', labelKey: 'referralPanel.statusPending' },
  void: { label: 'Void', labelKey: 'referralPanel.statusVoid' },
};

export function ReferralPanel({ code, link, rewardLabel, enabled, alreadyReferred, rows }: {
  code: string; link: string; rewardLabel: string; enabled: boolean; alreadyReferred: boolean; rows: Row[];
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [entry, setEntry] = useState('');
  const [pending, startTransition] = useTransition();
  const [inviteEmail, setInviteEmail] = useState('');
  const [sending, startSending] = useTransition();

  function emailInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = inviteEmail.trim();
    if (!address) return;
    startSending(async () => {
      const res = await sendReferralEmailAction(address);
      if (res.ok) { success(t('referralPanel.inviteEmailSent', { email: res.email })); setInviteEmail(''); }
      else toastError(res.reason);
    });
  }

  async function copy(text: string, which: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch { toastError(t('referralPanel.couldNotCopy')); }
  }

  async function share() {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'Join my family on Bubaly', text: `Use my code ${code} and get ${rewardLabel}!`, url: link });
      } catch { /* user cancelled */ }
    } else {
      copy(link, 'link');
    }
  }

  function apply() {
    const raw = entry.trim();
    if (!raw) return;
    startTransition(async () => {
      const res = await applyReferralCodeAction(raw);
      if (res.ok) { success(t('referralPanel.referralCodeApplied')); setEntry(''); }
      else toastError(res.reason);
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-surface/40 p-6">
        <h2 className="text-base font-semibold">{t('referral.yourReferralLink')}</h2>
        {!enabled && <p className="mt-1 text-sm text-amber-300">{t('referral.theReferralProgramIsCurrentlyPaused')}</p>}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-bg px-4 py-3">
            <span className="text-lg font-bold tracking-widest">{code}</span>
            <button onClick={() => copy(code, 'code')} className="ml-auto rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg" title={t('referral.copyCode')}>
              {copied === 'code' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-border bg-bg px-4 py-3">
            <span className="truncate text-sm text-muted">{link}</span>
            <button onClick={() => copy(link, 'link')} className="ml-auto rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg" title={t('referral.copyLink')}>
              {copied === 'link' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <button onClick={share} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand/90">
            <Share2 className="h-4 w-4" /> {t('referral.share')}
          </button>
        </div>
        {enabled && (
          <form onSubmit={emailInvite} className="mt-5 border-t border-border pt-5" data-testid="referral-email-form">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-brand-text" />
              <h3 className="text-sm font-semibold">{t('referralPanel.emailAnInvite')}</h3>
            </div>
            <p className="mt-1 text-xs text-muted">{t('referralPanel.weLlEmailThemYourCode')}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label htmlFor="referral-invite-email" className="sr-only">{t('referralPanel.friendsEmail')}</label>
              <input
                id="referral-invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="friend@example.com"
                autoComplete="off"
                className="h-11 flex-1 rounded-xl border border-border bg-bg px-4 text-sm outline-none focus:border-brand"
              />
              <button type="submit" disabled={sending || !inviteEmail.trim()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-5 text-sm font-semibold hover:bg-elevated disabled:opacity-60">
                <Mail className="h-4 w-4" /> {sending ? t('referralPanel.sending') : t('referralPanel.sendInvite')}
              </button>
            </div>
          </form>
        )}
      </section>

      {!alreadyReferred && (
        <section className="rounded-3xl border border-border bg-surface/40 p-6">
          <div className="flex items-center gap-2">
            <Ticket className="h-4 w-4 text-brand-text" />
            <h2 className="text-base font-semibold">{t('referral.haveAReferralCode')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted">{t('referral.enterAFriendAposSCode')} {rewardLabel} {t('referral.whenYouUpgrade')}</p>
          <div className="mt-4 flex gap-2">
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value.toUpperCase())}
              placeholder="SMITH-7K4Q"
              className="h-11 flex-1 rounded-xl border border-border bg-bg px-4 text-sm tracking-widest outline-none focus:border-brand"
            />
            <button onClick={apply} disabled={pending || !entry.trim()} className="rounded-xl bg-brand px-5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
              {pending ? t('referralPanel.applying') : t('referralPanel.apply')}
            </button>
          </div>
        </section>
      )}

      <section className="rounded-3xl border border-border bg-surface/40 p-6">
        <h2 className="mb-4 text-base font-semibold">{t('referral.familiesYouAposVeInvited')}</h2>
        {rows.length ? (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{r.email || t('referralPanel.invitedFamily')}</span>
                <span className="shrink-0 text-muted">{fmtDate(r.createdAt)}</span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? 'bg-elevated text-muted'}`}>
                  {STATUS_LABEL[r.status] ? t(STATUS_LABEL[r.status].labelKey) : r.status}
                </span>
                <span className="w-16 shrink-0 text-right font-semibold tabular-nums">
                  {(r.status === 'converted' || r.status === 'rewarded') ? fmtMoney(r.rewardCents) : '—'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-muted">{t('referral.noReferralsYetShareYourLink')}</p>
        )}
      </section>
    </div>
  );
}
