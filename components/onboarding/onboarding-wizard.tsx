'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Home, UserPlus, Mail, Check, ArrowRight, Baby } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ROLE_LABELS } from '@/lib/constants/roles';
import {
  createFamilyAction, addLocalMemberAction, inviteMemberAction,
} from '@/app/onboarding/actions';

const COLORS = ['#7c6dff', '#f4996e', '#4ac99b', '#f0bf5f', '#f57171', '#6aa9ff'];

function timezones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf?.('timeZone');
    if (all?.length) return all;
  } catch { /* fall through */ }
  return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London'];
}

type Added = { kind: 'local' | 'invite'; label: string; sub: string; color?: string };

export function OnboardingWizard() {
  const router = useRouter();
  const { success, error } = useToast();
  const tz = useMemo(timezones, []);
  const guessTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/New_York'; }
  }, []);

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [members, setMembers] = useState<Added[]>([]);

  async function onCreateFamily(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    const res = await createFamilyAction({
      name: String(form.get('name') ?? ''),
      timezone: String(form.get('timezone') ?? 'America/New_York'),
    });
    setLoading(false);
    if (!res.ok) return error(res.error);
    setFamilyId(res.data!.familyId);
    setStep(2);
  }

  async function onAddChild(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!familyId) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('childName') ?? '');
    const role = String(data.get('childRole') ?? 'child') as 'child' | 'teen';
    const color = COLORS[members.length % COLORS.length];
    setLoading(true);
    const res = await addLocalMemberAction({ familyId, displayName: name, role, color });
    setLoading(false);
    if (!res.ok) return error(res.error);
    setMembers((m) => [...m, { kind: 'local', label: name, sub: ROLE_LABELS[role], color }]);
    success(`${name} added`);
    form.reset();
  }

  async function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!familyId) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('inviteEmail') ?? '');
    const role = String(data.get('inviteRole') ?? 'adult') as 'adult' | 'teen' | 'caregiver' | 'guest';
    setLoading(true);
    const res = await inviteMemberAction({ familyId, email, role });
    setLoading(false);
    if (!res.ok) return error(res.error);
    setMembers((m) => [...m, { kind: 'invite', label: email, sub: `Invited · ${ROLE_LABELS[role]}` }]);
    success(`Invite sent to ${email}`);
    form.reset();
  }

  function finish() {
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <div className="animate-fade-in">
      {/* Progress */}
      <div className="mb-6 flex items-center gap-3">
        {[1, 2].map((n) => (
          <div key={n} className="flex flex-1 items-center gap-3">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                step >= n ? 'bg-brand text-brand-fg' : 'bg-elevated text-muted'
              }`}
            >
              {step > n ? <Check className="h-4 w-4" /> : n}
            </div>
            {n === 1 && <div className={`h-px flex-1 ${step > 1 ? 'bg-brand' : 'bg-border'}`} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="glass-card p-7">
          <div className="mb-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Home className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Name your family</h1>
          <p className="mt-1 text-sm text-muted">You can change this anytime in settings.</p>
          <form onSubmit={onCreateFamily} className="mt-6 space-y-4">
            <Field label="Family name" required>
              {(id) => <Input id={id} name="name" placeholder="The Rivera Family" autoFocus required />}
            </Field>
            <Field label="Time zone" hint="Used for reminders and your calendar">
              {(id) => (
                <Select id={id} name="timezone" defaultValue={guessTz}>
                  {tz.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              )}
            </Field>
            <Button type="submit" loading={loading} className="w-full">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <div className="glass-card p-7">
            <h1 className="text-2xl font-semibold tracking-tight">Add your family</h1>
            <p className="mt-1 text-sm text-muted">
              Invite people who’ll log in, and add young kids as managed profiles. You can do this later too.
            </p>

            {members.length > 0 && (
              <ul className="mt-5 space-y-2">
                {members.map((m, i) => (
                  <li key={i} className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 px-3 py-2">
                    {m.kind === 'local' ? (
                      <Avatar name={m.label} color={m.color} size={32} />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-brand">
                        <Mail className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.label}</p>
                      <p className="text-xs text-muted">{m.sub}</p>
                    </div>
                    {m.kind === 'invite' && <Badge tone="brand">Pending</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Invite adults/teens/caregivers */}
          <form onSubmit={onInvite} className="glass-card space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <UserPlus className="h-4 w-4 text-brand" /> Invite by email
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input name="inviteEmail" type="email" placeholder="spouse@example.com" className="flex-1" required />
              <Select name="inviteRole" defaultValue="adult" className="sm:w-44">
                <option value="adult">Adult</option>
                <option value="teen">Teen</option>
                <option value="caregiver">Caregiver</option>
                <option value="guest">Guest</option>
              </Select>
              <Button type="submit" variant="secondary" loading={loading}>Send</Button>
            </div>
          </form>

          {/* Add young child */}
          <form onSubmit={onAddChild} className="glass-card space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Baby className="h-4 w-4 text-brand" /> Add a child (no login)
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input name="childName" placeholder="Ava" className="flex-1" required />
              <Select name="childRole" defaultValue="child" className="sm:w-44">
                <option value="child">Child</option>
                <option value="teen">Teen</option>
              </Select>
              <Button type="submit" variant="secondary" loading={loading}>Add</Button>
            </div>
          </form>

          <Button onClick={finish} className="w-full" size="lg">
            Go to dashboard <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      )}
    </div>
  );
}
