'use client';

import { useState } from 'react';
import { Settings, Users, Mail, Trash2, Plus, Check } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { ROLE_LABELS, INVITABLE_ROLES, isAdmin } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';
import type { MemberRole } from '@/lib/database.types';

export function SettingsModule() {
  const { family, members, role, userId, userEmail } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [savingFamily, setSavingFamily] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const selfMember = members.find((m) => m.user_id === userId);

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const display_name = String(form.get('display_name') ?? '').trim();
    if (!display_name) return toastError('Display name is required');
    setSavingProfile(true);
    const supabase = createClient();
    const { error } = await supabase.from('profiles').update({ display_name }).eq('id', userId);
    setSavingProfile(false);
    if (error) return toastError(error.message);
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
    if (error) return toastError(error.message);
    success('Family name updated');
  }

  async function removeMember(memberId: string) {
    if (!confirm('Remove this member from the family?')) return;
    const supabase = createClient();
    const { error } = await supabase.from('family_members').update({ is_active: false }).eq('id', memberId);
    if (error) return toastError(error.message);
    success('Member removed');
    window.location.reload();
  }

  const activeMembers = members.filter((m) => m.is_active);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your profile, family, and members." />

      {/* Profile */}
      <Card>
        <h2 className="mb-4 text-base font-semibold">Your profile</h2>
        <form onSubmit={saveProfile} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" required>
              {(id) => (
                <Input id={id} name="display_name" defaultValue={selfMember?.display_name ?? ''} placeholder="Your name" />
              )}
            </Field>
            <Field label="Email">
              {(id) => <Input id={id} value={userEmail ?? ''} readOnly className="opacity-60" />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={savingProfile}>Save profile</Button>
          </div>
        </form>
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
    const { error } = await supabase.from('invites').insert({
      family_id: familyId,
      email,
      role,
      invited_by: userId,
    });
    setLoading(false);
    if (error) return toastError(error.message);
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
