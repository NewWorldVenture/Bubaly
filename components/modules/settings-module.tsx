'use client';

import { useEffect, useState } from 'react';
import { Users, Mail, Trash2, Plus, Check, Pencil, User, Lock, RefreshCw, Compass, Bot } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { AISettingsPanel } from '@/components/settings/ai-settings';
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
import { AppLockSettings } from '@/components/settings/app-lock-settings';
import { NavigationChoices } from '@/components/settings/navigation-choices';
import type { Tables } from '@/lib/database.types';
import type { MemberRole } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

const SETTINGS_TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'family', label: 'Family', icon: Users },
  { id: 'ai', label: 'Bubaly AI', icon: Bot },
  { id: 'navigation', label: 'Navigation Choices', icon: Compass },
  { id: 'calendar', label: 'Calendar', icon: RefreshCw },
  { id: 'security', label: 'Security', icon: Lock },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

// Map legacy/deep-link hashes (#members, #app-lock, #families, #sync) onto tabs
// so existing links keep working, and round-trip the active tab through the URL
// hash so it survives the window.location.reload() that some save actions do.
const TAB_BY_HASH: Record<string, SettingsTab> = {
  profile: 'profile', dashboard: 'profile',
  family: 'family', members: 'family', families: 'family',
  ai: 'ai', bubaly: 'ai', autonomy: 'ai',
  navigation: 'navigation', 'navigation-choices': 'navigation', sidebar: 'navigation',
  calendar: 'calendar', sync: 'calendar',
  security: 'security', 'app-lock': 'security',
};
const HASH_BY_TAB: Record<SettingsTab, string> = {
  profile: 'profile', family: 'members', ai: 'ai', navigation: 'navigation', calendar: 'calendar', security: 'app-lock',
};

export function SettingsModule() {
  const t = useTranslations();
  const { family, members, role, userId, userEmail, defaultDashboard } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editMember, setEditMember] = useState<Tables<'family_members'> | null>(null);
  const [savingFamily, setSavingFamily] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [dashboardView, setDashboardView] = useState<DashboardView>(defaultDashboard);
  const [savingDashboard, setSavingDashboard] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('profile');

  // Seed the active tab from the URL hash on mount (deep links + reload survival).
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, '').toLowerCase();
    if (h && TAB_BY_HASH[h]) setTab(TAB_BY_HASH[h]);
  }, []);

  function changeTab(next: SettingsTab) {
    setTab(next);
    // replaceState (not a navigation) keeps the tab in the URL without scrolling
    // or adding history entries, and persists it across save-triggered reloads.
    window.history.replaceState(null, '', `#${HASH_BY_TAB[next]}`);
  }

  const selfMember = members.find((m) => m.user_id === userId);

  // Account profile (name + phone) live in `profiles`, not in useApp() — load it
  // once so the form prefills the values captured during onboarding.
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [profileForm, setProfileForm] = useState({ firstName: '', lastName: '', phone: '', avatarUrl: '' });
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.from('profiles').select('full_name, phone, avatar_url').eq('id', userId).maybeSingle();
      if (!active) return;
      // A dropped read error here is destructive: the form would prefill a BLANK
      // phone/avatar, and saveUserProfile writes `phone`/`avatar_url` unconditionally
      // — so a Save after a transient read failure silently WIPES the user's real
      // phone number and avatar. On error, keep the form disabled (Save gated on
      // profileLoaded) and surface a retry instead of presenting blanks as truth.
      if (error) {
        setProfileError(true);
        setProfileLoaded(false);
        return;
      }
      const { firstName, lastName } = splitFullName(data?.full_name ?? selfMember?.display_name ?? '');
      setProfileForm({ firstName, lastName, phone: data?.phone ?? '', avatarUrl: data?.avatar_url ?? '' });
      setProfileError(false);
      setProfileLoaded(true);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, profileReloadKey]);

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
    // Never write when the profile never loaded — the form holds blanks, not the
    // user's saved values, so a submit here would wipe phone/avatar (see load effect).
    if (!profileLoaded) return;
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
      <PageHeader title={t('settings.settings')} description="Manage your profile, family, and members." action={<AiInsight kind="settings" />} />

      {/* Tab switcher */}
      <div className="tab-bar" role="tablist" aria-label={t('settings.settingsSections')}>
        {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => changeTab(id)}
            className={cn('tab-item inline-flex items-center gap-1.5', tab === id ? 'tab-item-active' : 'tab-item-inactive')}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {tab === 'profile' && (<>
      {/* Profile */}
      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('settings.yourProfile')}</h2>
        {profileError && (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            <span className="min-w-0 flex-1">{t('settings.couldntLoadYourProfileEditingIs')}</span>
            <button
              type="button"
              onClick={() => { setProfileError(false); setProfileReloadKey((k) => k + 1); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-3 py-1.5 font-medium hover:bg-danger/10"
            >
              <RefreshCw className="h-3.5 w-3.5" /> {t('settings.tryAgain')}
            </button>
          </div>
        )}
        <form onSubmit={saveProfile} className="space-y-4">
          {profileLoaded && (
            <AvatarPicker
              defaultValue={profileForm.avatarUrl}
              displayName={`${profileForm.firstName} ${profileForm.lastName}`.trim()}
              onChange={(url) => setProfileForm((f) => ({ ...f, avatarUrl: url }))}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.firstName')} required>
              {(id) => (
                <Input id={id} value={profileForm.firstName}
                  onChange={(e) => setProfileForm((f) => ({ ...f, firstName: e.target.value }))}
                  placeholder={t('settings.jordan')} disabled={!profileLoaded} />
              )}
            </Field>
            <Field label={t('settings.lastName')} required>
              {(id) => (
                <Input id={id} value={profileForm.lastName}
                  onChange={(e) => setProfileForm((f) => ({ ...f, lastName: e.target.value }))}
                  placeholder={t('settings.rivera')} disabled={!profileLoaded} />
              )}
            </Field>
            <Field label={t('settings.contactPhone')} hint="Optional">
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
            <Field label={t('settings.email')} hint="Managed by your sign-in">
              {(id) => <Input id={id} value={userEmail ?? ''} readOnly className="opacity-60" />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={savingProfile} disabled={!profileLoaded}>{t('settings.saveProfile')}</Button>
          </div>
        </form>
      </Card>

      {/* Default dashboard */}
      <Card>
        <h2 className="mb-1 text-base font-semibold">{t('settings.defaultDashboard')}</h2>
        <p className="mb-4 text-sm text-muted">
          {t('settings.chooseWhichDashboardOpensByDefault')}
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
                    {selected && <Check className="h-4 w-4 text-brand-text" />}
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-muted">{DASHBOARD_DESCRIPTIONS[view]}</p>
                </div>
              </button>
            );
          })}
        </div>
      </Card>
      </>)}

      {/* Family tab */}
      {tab === 'family' && (<>
      {/* Family */}
      {admin && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">{t('settings.familySettings')}</h2>
          <form onSubmit={saveFamilyName} className="space-y-4">
            <Field label={t('settings.familyName')} required>
              {(id) => <Input id={id} name="name" defaultValue={family.name} />}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={savingFamily}>{t('settings.save')}</Button>
            </div>
          </form>
        </Card>
      )}

      {/* Members */}
      <Card id="members">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Users className="h-4 w-4 text-brand-text" /> {t('settings.familyMembers')}
          </h2>
          {admin && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" /> {t('settings.invite')}
            </Button>
          )}
        </div>
        <ul className="max-h-[36rem] space-y-2 overflow-y-auto">
          {activeMembers.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
              <Avatar name={m.display_name} color={m.color} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.display_name}</p>
                <Badge tone="neutral">{ROLE_LABELS[m.role]}</Badge>
              </div>
              {admin && (
                <button onClick={() => setEditMember(m)} className="rounded-lg p-2 text-muted hover:text-fg" aria-label={t('settings.editMember')}>
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              {admin && m.user_id !== userId && (
                <button onClick={() => removeMember(m.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label={t('settings.removeMember')}>
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              {m.user_id === userId && <Badge tone="brand">You</Badge>}
            </li>
          ))}
        </ul>
      </Card>
      </>)}

      {/* Bubaly AI tab */}
      {tab === 'ai' && <AISettingsPanel role={role} />}

      {/* Navigation Choices tab */}
      {tab === 'navigation' && <NavigationChoices />}

      {/* Calendar tab */}
      {tab === 'calendar' && (
        <Card>
          <CalendarSyncPanel />
        </Card>
      )}

      {/* Security tab — opt-in App Lock */}
      {tab === 'security' && <AppLockSettings />}

      {inviteOpen && (
        <InviteModal
          familyId={family.id}
          userId={userId}
          onClose={() => setInviteOpen(false)}
          onSent={() => { setInviteOpen(false); success('Invite sent!'); }}
        />
      )}

      {editMember && (
        <EditMemberModal
          member={editMember}
          isSelf={editMember.user_id === userId}
          onClose={() => setEditMember(null)}
        />
      )}
    </div>
  );
}

function EditMemberModal({ member, isSelf, onClose }: {
  member: Tables<'family_members'>; isSelf: boolean; onClose: () => void;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const display_name = String(form.get('display_name') ?? '').trim();
    const role = String(form.get('role') ?? member.role) as MemberRole;
    const birthday = String(form.get('birthday') ?? '').trim();
    if (!display_name) { toastError('Name is required'); return; }
    setSaving(true);
    const { error } = await createClient().from('family_members')
      .update({ display_name, role, birthday: birthday || null }).eq('id', member.id);
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Member updated');
    onClose();
    window.location.reload();
  }

  return (
    <Modal open onClose={onClose} title={t('settings.editFamilyMember')} description={isSelf ? 'Changing your own role can affect your admin access.' : undefined}>
      <form onSubmit={save} className="space-y-4">
        <Field label={t('settings.name')} required>
          {(id) => <Input id={id} name="display_name" defaultValue={member.display_name} autoFocus />}
        </Field>
        <Field label={t('settings.role')}>
          {(id) => (
            <Select id={id} name="role" defaultValue={member.role}>
              {(Object.keys(ROLE_LABELS) as MemberRole[]).map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('settings.birthday')} hint="Powers birthday reminders, gift ideas, and celebrations.">
          {(id) => <Input id={id} name="birthday" type="date" defaultValue={member.birthday ?? ''} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function InviteModal({ familyId, userId, onClose, onSent }: {
  familyId: string; userId: string;
  onClose: () => void; onSent: () => void;
}) {
  const t = useTranslations();
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
    <Modal open onClose={onClose} title={t('settings.inviteFamilyMember')} description="They'll receive an email with a link to join your family.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('settings.emailAddress')} required>
          {(id) => <Input id={id} name="email" type="email" placeholder="person@example.com" autoFocus />}
        </Field>
        <Field label={t('settings.role')}>
          {(id) => (
            <Select id={id} name="role" defaultValue="adult">
              {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button type="submit" loading={loading}><Mail className="h-4 w-4" /> {t('settings.sendInvite')}</Button>
        </div>
      </form>
    </Modal>
  );
}
