'use client';

// components/family/invite-form.tsx — the family invite form, with presets for
// the people a household actually invites (M28).
//
// Inviting a grandparent used to mean knowing that "guest" is the role that
// gives them the simplified portal, and inviting a babysitter meant knowing
// that "caregiver" exists. A preset names the PERSON and picks the role.
//
// What a preset deliberately does NOT do: promise a delegation. Time-limited
// authority lives in trust_delegations, which needs a member row — and the
// person invited has none until they accept. Rather than claim a share that
// nothing would create, each preset says where the share is granted once they
// are in (Trust → Access & Sharing). Carrying the intent through the invite
// itself would need a column on `invites` (M23's migration), which is not
// shipped; see the TODO below.

import { useState } from 'react';
import Link from 'next/link';
import { Mail, ArrowRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { INVITABLE_ROLES } from '@/lib/constants/roles';
import type { MemberRole } from '@/lib/constants/roles';
import { useTranslations } from '@/components/i18n/locale-provider';

// TODO(M23 RLS migration): a caregiver preset that also pre-authorises a
// time-limited delegation needs somewhere to park that intent until the invite
// is accepted (a column on `invites`, or an invite_delegations table), plus the
// member-scoped RLS that would make "only the school run" true for reads as
// well as actions. TODO(M16): care circles are the wider version of the same
// idea — one carer across several households.

export type InvitePreset = {
  key: string;
  /** English label beside the key, so non-UI readers of this array see prose. */
  label: string;
  labelKey: string;
  descriptionKey: string;
  role: MemberRole;
  /** What actually happens when they accept. No promises beyond this. */
  noteKey: string;
};

export const INVITE_PRESETS: InvitePreset[] = [
  {
    key: 'grandparent',
    label: 'A grandparent',
    labelKey: 'inviteForm.presetGrandparent',
    descriptionKey: 'inviteForm.presetGrandparentWhat',
    role: 'guest',
    noteKey: 'inviteForm.presetGrandparentNote',
  },
  {
    key: 'caregiver',
    label: 'A caregiver or babysitter',
    labelKey: 'inviteForm.presetCaregiver',
    descriptionKey: 'inviteForm.presetCaregiverWhat',
    role: 'caregiver',
    noteKey: 'inviteForm.presetCaregiverNote',
  },
  {
    key: 'adult',
    label: 'Another parent or adult',
    labelKey: 'inviteForm.presetAdult',
    descriptionKey: 'inviteForm.presetAdultWhat',
    role: 'adult',
    noteKey: 'inviteForm.presetAdultNote',
  },
  {
    key: 'teen',
    label: 'A teen in the family',
    labelKey: 'inviteForm.presetTeen',
    descriptionKey: 'inviteForm.presetTeenWhat',
    role: 'teen',
    noteKey: 'inviteForm.presetTeenNote',
  },
];

export function InviteForm({ familyId, userId, onSent, onCancel }: {
  familyId: string; userId: string; onSent: () => void; onCancel: () => void;
}) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  // The ROLE is the only state: it is what gets written. A preset is just a
  // name for one, so the highlighted tile and the note below can never disagree
  // with the role in the box — including when the box is changed by hand.
  const [role, setRole] = useState<MemberRole>('adult');
  const preset = INVITE_PRESETS.find((p) => p.role === role) ?? null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    if (!email) return toastError(t('settingsModule.emailIsRequired'));
    setLoading(true);
    const supabase = createClient();
    const { data: invite, error } = await supabase.from('invites').insert({
      family_id: familyId,
      email,
      role,
      invited_by: userId,
    }).select('id').single();
    if (error || !invite) { setLoading(false); return toastError(describeDbError(error, t('settingsModule.failed'))); }

    // Fire invite email (non-blocking — don't fail UI if email fails)
    void fetch('/api/email/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteId: invite.id }),
    });

    setLoading(false);
    onSent();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <p className="mb-1.5 text-sm font-medium">{t('inviteForm.whoAreYouInviting')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {INVITE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRole(p.role)}
              aria-pressed={p.role === role}
              className={cn('rounded-xl border p-3 text-left transition',
                p.role === role
                  ? 'border-brand/50 bg-brand/10'
                  : 'border-border bg-surface/40 hover:border-brand/40')}
            >
              <p className="text-sm font-semibold">{t(p.labelKey)}</p>
              <p className="mt-0.5 text-[11px] text-muted">{t(p.descriptionKey)}</p>
            </button>
          ))}
        </div>
      </div>

      <Field label={t('settings.emailAddress')} required>
        {(id) => <Input id={id} name="email" type="email" placeholder="person@example.com" autoFocus />}
      </Field>

      <Field label={t('settings.role')} hint={preset ? t(preset.noteKey) : undefined}>
        {(id) => (
          <Select id={id} name="role" value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
            {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{t(`trustRole.${r}`)}</option>)}
          </Select>
        )}
      </Field>

      {/* Where the time-limited half actually happens. A link, not a claim. */}
      <p className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-surface/20 p-3 text-[11px] text-muted">
        {t('inviteForm.timeLimitedAccessIsGranted')}
        <Link href="/dashboard/trust" className="inline-flex items-center gap-0.5 font-semibold text-brand-text hover:underline">
          {t('inviteForm.accessSharing')} <ArrowRight className="h-3 w-3" />
        </Link>
      </p>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>{t('settings.cancel')}</Button>
        <Button type="submit" loading={loading}><Mail className="h-4 w-4" /> {t('settings.sendInvite')}</Button>
      </div>
    </form>
  );
}
