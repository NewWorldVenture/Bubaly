'use client';

import { useEffect, useState } from 'react';
import { Settings, Users, Mail, Trash2, Plus, Check } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { AvatarPicker } from '@/components/ui/avatar-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { guessDialCodeFromPhone, extractLocalNumber, COUNTRY_DIAL_CODES } from '@/lib/utils/phone';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { ROLE_LABELS, INVITABLE_ROLES, isAdmin } from '@/lib/constants/roles';
import {
  DASHBOARD_VIEWS, dashboardLabel, dashboardIcon, DASHBOARD_DESCRIPTIONS, type DashboardView,
} from '@/lib/constants/dashboards';
import { setDefaultDashboardAction, updateMyProfileAction } from '@/app/(app)/actions';
import { splitFullName } from '@/lib/onboarding/profile';
import { cn } from '@/lib/utils/cn';
import { CalendarSyncPanel } from '@/components/dashboard/calendar-sync-panel';
import type { Tables } from '@/lib/database.types';
import type { MemberRole } from '@/lib/database.types';

export function SettingsModule() {
  const { family, members, role, userId, userEmail, defaultDashboard } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [savingFamily, setSavingFamily] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [dashboardView, setDashboardView] = useState<DashboardView>(defaultDashboard);
  const [savingDashboard, setSavingDashboard] = useState(false);

  const selfMember = members.find((m) => m.user_id === userId);

  // Account profile (name + phone) live in `profiles`, not in useApp() — load it
  // once so the form prefills the values captured during onboarding.
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileForm, setProfileForm] = useState({ firstName: '', lastName: '', phone: '', avatarUrl: '' });
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from('profiles').select('full_name, phone, avatar_url').eq('id', userId).maybeSingle();
      if (!active) return;
      const { firstName, lastName } = splitFullName(data?.full_name ?? selfMember?.display_name ?? '');
      setProfileForm({ firstName, lastName, phone: data?.phone ?? '', avatarUrl: data?.avatar_url ?? '' });
      setProfileLoaded(true);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Pre-select the country dial code from the stored E.164 number (PhoneInput
  // falls back to its own locale guess when there's no saved number).
  const savedDialCode = guessDialCodeFromPhone(profileForm.phone);
  const savedCountryCode = COUNTRY_DIAL_CODES.find((c) => c.dialCode === savedDialCode)?.code;

  async function chooseDashboard(view: DashboardView) {
    if (view === dashboardView || savingDashboard) return;
    const previous = dashboardView;
    setDashboardView(view);
    setSavingDashboard(true);
    const res = await setDefaultDashboardAction(view);
    setSavingDashboard(false);
    if (!res.ok) {
      setDashboardView(previous);
      return toastError(res.error ?? 'Could not update dashboard');
    }
    success('Default dashboard updated');
  }

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSavingProfile(true);
    const res = await updateMyProfileAction(profileForm);
    setSavingProfile(false);
    if (!res.ok) return toastError(res.error ?? 'Could not update profile');
    success('Profile updated');
  }

  async function saveFamilyName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    setSavingFamily(true);
    const supabase = createClient();
    const { error } = await supabase.from('families').update({ name }).eq('id', family.id);
    setSavingFamily(false);
    if (error) return toastError(describeDbError(error));
    success('Family name updated');
  }

  async function removeMember(memberId: string) {
    if (!confirm('Remove this member from the family?')) return;
    const supabase = createClient();
    const { error } = await supabase.from('family_members').update({ is_active: false }).eq('id', memberId);
    if (error) return toastError(describeDbError(error));
    success('Member removed');
    window.location.reload();
  }

  const activeMembers = members.filter((m) => m.is_active);

  return (
    <div className="module-page">
      <PageHeader title="Settings" description="Manage your profile, family, and members." action={<AiInsight kind="settings" />} />

      {/* Profile */}
      <Card>
        <h2 className="mb-4 text-base font-semibold">Your profile</h2>
        <form onSubmit={saveProfile} className="space-y-4">
          {profileLoaded && (
            <AvatarPicker
              defaultValue={profileForm.avatarUrl}
              displayName={`${profileForm.firstName} ${profileForm.lastName}`.trim()}
              onChange={(url) => setProfileForm((f) => ({ ...f, avatarUrl: url }))}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required>
              {(id) => (
                <Input id={id} value={profileForm.firstName}
                  onChange={(e) => setProfileForm((f) => ({ ...f, firstName: e.target.value }))}
                  placeholder="Jordan" disabled={!profileLoaded} />
              )}
            </Field>
            <Field label="Last name" required>
              {(id) => (
                <Input id={id} value={profileForm.lastName}
                  onChange={(e) => setProfileForm((f) => ({ ...f, lastName: e.target.value }))}
                  placeholder="Rivera" disabled={!profileLoaded} />
              )}
            </Field>
            <Field label="Contact phone" hint="Optional">
              {() => (
                profileLoaded ? (
                  <PhoneInput
                    defaultDialCode={savedDialCode}
                    defaultCountryCode={savedCountryCode}
                    defaultLocalNumber={extractLocalNumber(profileForm.phone, savedDialCode)}
                    onChange={(e164) => setProfileForm((f) => ({ ...f, phone: e164 }))}
                  />
                ) : (
                  <Input type="tel" inputMode="tel" value={profileForm.phone}
                    placeholder="(555) 123-4567" disabled />
                )
              )}
            </Field>
            <Field label="Email" hint="Managed by your sign-in">
              {(id) => <Input id={id} value={userEmail ?? ''} readOnly className="opacity-60" />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={savingProfile} disabled={!profileLoaded}>Save profile</Button>
          </div>
        </form>
      </Card>

      {/* Default dashboard */}
      <Card>
        <h2 className="mb-1 text-base font-semibold">Default dashboard</h2>
        <p className="mb-4 text-sm text-muted">
          Choose which dashboard opens by default. You can always switch from the account menu.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {DASHBOARD_VIEWS.map((view) => {
            const Icon = dashboardIcon[view];
            const selected = dashboardView === view;
            return (
              <button
                key={view}
                type="button"
                onClick={() => chooseDashboard(view)}
                disabled={savingDashboard}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 text-left transition disabled:opacity-60',
                  selected ? 'border-brand bg-brand/10' : 'border-border bg-surface/40 hover:bg-elevated',
                )}
              >
                <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', selected ? 'bg-brand text-brand-fg' : 'bg-elevated text-muted')}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">{dashboardLabel(view, role)}</p>
                    {selected && <Check className="h-4 w-4 text-brand" />}
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-muted">{DASHBOARD_DESCRIPTIONS[view]}</p>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Family */}
      {admin && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">Family settings</h2>
          <form onSubmit={saveFamilyName} className="space-y-4">
            <Field label="Family name" required>
              {(id) => <Input id={id} name="name" defaultValue={family.name} />}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={savingFamily}>Save</Button>
            </div>
          </form>
        </Card>
      )}

      {/* Members */}
      <Card id="members">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Users className="h-4 w-4 text-brand" /> Family members
          </h2>
          {admin && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" /> Invite
            </Button>
          )}
        </div>
        <ul className="space-y-2">
          {activeMembers.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
              <Avatar name={m.display_name} color={m.color} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.display_name}</p>
                <Badge tone="neutral">{ROLE_LABELS[m.role]}</Badge>
              </div>
              {admin && m.user_id !== userId && (
                <button onClick={() => removeMember(m.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Remove member">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              {m.user_id === userId && <Badge tone="brand">You</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      {/* Calendar Sync */}
      <Card>
        <CalendarSyncPanel />
      </Card>

      {inviteOpen && (
        <InviteModal
          familyId={family.id}
          userId={userId}
          onClose={() => setInviteOpen(false)}
          onSent={() => { setInviteOpen(false); success('Invite sent!'); }}
        />
      )}
    </div>
  );
}

function InviteModal({ familyId, userId, onClose, onSent }: {
  familyId: string; userId: string;
  onClose: () => void; onSent: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const role = String(form.get('role') ?? 'adult') as MemberRole;
    if (!email) return toastError('Email is required');
    setLoading(true);
    const supabase = createClient();
    const { data: invite, error } = await supabase.from('invites').insert({
      family_id: familyId,
      email,
      role,
      invited_by: userId,
    }).select('id').single();
    if (error || !invite) { setLoading(false); return toastError(describeDbError(error, 'Failed')); }

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
    <Modal open onClose={onClose} title="Invite family member" description="They'll receive an email with a link to join your family.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email address" required>
          {(id) => <Input id={id} name="email" type="email" placeholder="person@example.com" autoFocus />}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select id={id} name="role" defaultValue="adult">
              {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Mail className="h-4 w-4" /> Send invite</Button>
        </div>
      </form>
    </Modal>
  );
}
