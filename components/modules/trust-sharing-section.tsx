'use client';

// components/modules/trust-sharing-section.tsx — "Access & Sharing" (M23).
//
// The permission model was already real (permission_grants, trust_delegations,
// evaluateTrust) but only reachable through an admin-shaped form: pick a
// subject kind, a domain, a capability, an expiry. This section says the same
// thing in the words a parent uses — "babysitter tonight", "grandparent this
// week" — and writes the same rows through the same server action.
//
// Two rules this file must keep:
//   1. Nothing here claims a scope the database does not enforce. A delegation
//      governs ACTIONS (what a person, and Bubaly acting for them, may do); it
//      does not narrow what the family's shared pages show. The note at the
//      bottom says so in as many words.
//   2. No button that does nothing: every preset writes a real delegation row
//      and the list below is rendered from the rows the page read back.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Share2, Clock, Check, ShieldAlert, Users, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { DOMAIN_LABELS, CAPABILITY_LABELS, type Capability } from '@/lib/trust/engine';
import {
  SHARING_PRESETS, delegationFromPreset, summarizeMemberAccess,
  type SharingPreset,
} from '@/lib/trust/sharing-presets';
import { createSharingPresetAction } from '@/app/(app)/dashboard/trust/actions';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

type Member = { id: string; name: string; role: string; color: string | null };
type Grant = { member_id: string; domain: string; capability: string; effect: string };
type Delegation = { to_member_id: string; domains: string[]; expires_at: string; revoked_at?: string | null };

// Catalogue keys for the trust vocabulary. The engine's DOMAIN_LABELS /
// CAPABILITY_LABELS / ROLE_LABELS are module-level English data; these keys are
// their translated twins, and an unknown value still falls back to the English
// label rather than rendering a raw key.
const DOMAIN_KEYS: Record<string, string> = Object.fromEntries(
  Object.keys(DOMAIN_LABELS).filter((d) => d !== 'all').map((d) => [d, `trustDomain.${camel(d)}`]),
);
const ROLE_KEYS: Record<string, string> = {
  parent: 'trustRole.parent', adult: 'trustRole.adult', teen: 'trustRole.teen',
  child: 'trustRole.child', caregiver: 'trustRole.caregiver', guest: 'trustRole.guest',
};

function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function TrustSharingSection({ members, grants, delegations, canManage }: {
  members: Member[]; grants: Grant[]; delegations: Delegation[]; canManage: boolean;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const [preset, setPreset] = useState<SharingPreset | null>(null);

  const domainLabel = (d: string) => (DOMAIN_KEYS[d] ? tr(DOMAIN_KEYS[d]) : DOMAIN_LABELS[d] ?? d);
  const capabilityLabel = (c: string) =>
    ((CAPABILITY_LABELS as Record<string, string>)[c] ? tr(`trustCapability.${c}`) : c);

  return (
    <section className="mb-4 space-y-4 rounded-2xl border border-border bg-surface/30 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
          <Share2 className="h-4 w-4 text-brand-text" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold">{tr('trustSharing.accessSharing')}</h2>
          <p className="mt-0.5 text-xs text-muted">{tr('trustSharing.handSomeoneAuthority')}</p>
        </div>
      </div>

      {/* Presets — one tap writes a real, expiring delegation row. */}
      {canManage && (
        <div className="grid gap-2 sm:grid-cols-2">
          {SHARING_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p)}
              className="rounded-xl border border-border bg-surface/40 p-3 text-left transition hover:border-brand/50 hover:bg-brand/5"
            >
              <p className="text-sm font-semibold">{tr(p.labelKey)}</p>
              <p className="mt-0.5 text-[11px] text-muted">{tr(p.descriptionKey)}</p>
              <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-amber-400">
                <Clock className="h-3 w-3" /> {durationLabel(tr, p)}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Per-member summary — derived, read-only, and careful about what it claims. */}
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          <Users className="h-3.5 w-3.5" /> {tr('trustSharing.whatEachPersonCanDo')}
        </h3>
        {members.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface/40 p-4 text-xs text-muted">
            {tr('trustSharing.noFamilyMembersYet')}
          </p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => {
              const summary = summarizeMemberAccess({
                memberId: m.id, role: m.role, grants, delegations,
              });
              return (
                <li key={m.id} className="rounded-xl border border-border bg-surface/40 p-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={m.name} color={m.color} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{m.name}</p>
                      <p className="text-[11px] text-muted">
                        {ROLE_KEYS[summary.role] ? tr(ROLE_KEYS[summary.role]) : summary.role}
                      </p>
                    </div>
                    <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                      summary.automationTrusted
                        ? 'border-green-500/30 bg-green-500/10 text-green-400'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-400')}>
                      {summary.automationTrusted ? tr('trustSharing.bubalyCanAct') : tr('trustSharing.bubalyAsksFirst')}
                    </span>
                  </div>

                  <dl className="mt-2 space-y-1 text-[11px]">
                    <Line term={tr('trustSharing.canDo')}>
                      {summary.capabilities.map((c: Capability) => capabilityLabel(c)).join(' · ')}
                    </Line>
                    {summary.approvalDomains.length > 0 && (
                      <Line term={tr('trustSharing.needsApprovalIn')}>
                        {summary.approvalDomains.map(domainLabel).join(' · ')}
                      </Line>
                    )}
                    {summary.denied.length > 0 && (
                      <Line term={tr('trustSharing.blockedFrom')}>
                        {summary.denied.map((g) => `${domainLabel(g.domain)} (${capabilityLabel(g.capability)})`).join(' · ')}
                      </Line>
                    )}
                    {summary.allowed.length > 0 && (
                      <Line term={tr('trustSharing.alsoAllowed')}>
                        {summary.allowed.map((g) => `${domainLabel(g.domain)} (${capabilityLabel(g.capability)})`).join(' · ')}
                      </Line>
                    )}
                    {summary.delegatedDomains.length > 0 && summary.delegationExpiresAt && (
                      <Line term={tr('trustSharing.sharedWithThemNow')}>
                        {summary.delegatedDomains.map(domainLabel).join(' · ')}
                        {' — '}
                        {tr('trustSharing.untilWhen', { when: fmtWhen(summary.delegationExpiresAt, locale.code) })}
                      </Line>
                    )}
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-border/60 bg-surface/20 p-3 text-[11px] text-muted">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
        {tr('trustSharing.actionsNotReadsNote')}
      </p>

      {preset && (
        <SharePresetModal
          preset={preset}
          members={members}
          onClose={() => setPreset(null)}
        />
      )}
    </section>
  );
}

function Line({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="flex-shrink-0 font-medium text-muted">{term}</dt>
      <dd className="min-w-0 text-fg/90">{children}</dd>
    </div>
  );
}

function SharePresetModal({ preset, members, onClose }: {
  preset: SharingPreset; members: Member[]; onClose: () => void;
}) {
  const tr = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const managers = useMemo(() => members.filter((m) => m.role === 'parent' || m.role === 'adult'), [members]);
  const [fromMemberId, setFrom] = useState(managers[0]?.id ?? members[0]?.id ?? '');
  const [toMemberId, setTo] = useState('');
  const [loading, setLoading] = useState(false);

  // Nobody delegates to themselves, so the recipient list never offers the
  // person handing over — and the selected recipient is derived rather than
  // stored, so switching the sender cannot leave a stale (or impossible)
  // choice sitting in the box.
  const recipients = members.filter((m) => m.id !== fromMemberId);
  const toMember = recipients.some((m) => m.id === toMemberId) ? toMemberId : recipients[0]?.id ?? '';

  // Shown BEFORE the share is made, from the same pure mapping the server uses,
  // so the preview cannot drift from what is actually written.
  const preview = delegationFromPreset(preset, { fromMemberId, toMemberId: toMember });

  async function share() {
    if (loading) return;
    if (!fromMemberId || !toMember || fromMemberId === toMember) {
      return toastError(tr('trustSharing.pickTwoDifferentPeople'));
    }
    setLoading(true);
    const res = await createSharingPresetAction({ presetKey: preset.key, fromMemberId, toMemberId: toMember });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? tr('trustSharing.couldNotShareAccess'));
    success(tr('trustSharing.accessSharedItExpires'));
    onClose();
    router.refresh();
  }

  return (
    <Modal open title={tr(preset.labelKey)} description={tr(preset.descriptionKey)} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('trustSharing.handingOver')}>
            {(id) => (
              <Select id={id} value={fromMemberId} onChange={(e) => setFrom(e.target.value)}>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={tr('trustSharing.sharingWith')}>
            {(id) => (
              <Select id={id} value={toMember} onChange={(e) => setTo(e.target.value)}>
                {recipients.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <div className="rounded-xl border border-border bg-surface/40 p-3 text-xs">
          <p className="font-semibold">{tr('trustSharing.theyWillBeAbleToActIn')}</p>
          <p className="mt-1 text-muted">
            {preset.domains.map((d) => tr(`trustDomain.${camel(d)}`)).join(' · ')}
          </p>
          <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-amber-400">
            <Clock className="h-3 w-3" /> {tr('trustSharing.expiresOn', { when: fmtWhen(preview.expiresAt, locale.code) })}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('trustSharing.cancel')}</Button>
          <Button type="button" onClick={share} disabled={loading || !toMember}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {tr('trustSharing.shareAccess')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function durationLabel(tr: (key: string, params?: Record<string, string | number>) => string, preset: SharingPreset): string {
  return preset.durationHours < 24
    ? tr('trustSharing.lastsHours', { hours: preset.durationHours })
    : tr('trustSharing.lastsDays', { days: Math.round(preset.durationHours / 24) });
}

/** The reader's own locale formats the expiry — an expiry a person misreads is
 *  worse than no expiry shown at all. */
function fmtWhen(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
