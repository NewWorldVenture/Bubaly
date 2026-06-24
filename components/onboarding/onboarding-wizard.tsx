'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Home, UserPlus, Mail, Check, ArrowRight, ArrowLeft,
  User, Users, Trash2, Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '@/lib/constants/roles';
import type { MemberRole } from '@/lib/constants/roles';
import { FAMILY_GOALS, REFERRAL_SOURCES, parseChildAges } from '@/lib/onboarding/family';
import {
  MEMBER_COLORS, LOCAL_MEMBER_ROLES, INVITE_ROLES,
  nextMemberColor, makeLocalMember, makeInviteMember,
  addMember, removeMember, draftMemberLabel,
  type DraftMember,
} from '@/lib/onboarding/draft';
import { finalizeOnboardingAction } from '@/app/onboarding/actions';

const TOTAL_STEPS = 5;
const STORAGE_KEY = 'onboarding-draft';

export type InitialProfile = { firstName: string; lastName: string; phone: string; email: string };

function timezones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf?.('timeZone');
    if (all?.length) return all;
  } catch { /* fall through */ }
  return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London'];
}

interface DraftState {
  profile: { firstName: string; lastName: string; phone: string; email: string };
  family: { name: string; timezone: string };
  details: {
    householdAdults: number; householdChildren: number; childAges: string;
    region: string; postalCode: string; goals: string[];
    referralSource: string; referralDetail: string;
  };
  members: DraftMember[];
  step: number;
}

function defaultDraft(initial?: InitialProfile): DraftState {
  const guessTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/New_York'; }
  })();
  return {
    profile: {
      firstName: initial?.firstName ?? '',
      lastName: initial?.lastName ?? '',
      phone: initial?.phone ?? '',
      email: initial?.email ?? '',
    },
    family: { name: '', timezone: guessTz },
    details: {
      householdAdults: 2, householdChildren: 0, childAges: '',
      region: '', postalCode: '', goals: [],
      referralSource: '', referralDetail: '',
    },
    members: [],
    step: 1,
  };
}

function loadDraft(initial?: InitialProfile): DraftState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as DraftState;
      if (saved.step >= 1 && saved.step <= TOTAL_STEPS) return saved;
    }
  } catch { /* ignore corrupt data */ }
  return defaultDraft(initial);
}

function saveDraft(draft: DraftState) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* quota */ }
}

function clearDraft() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}

export function OnboardingWizard(
  { initialProfile, emailLocked = false }: { initialProfile?: InitialProfile; emailLocked?: boolean },
) {
  const router = useRouter();
  const { success, error: showError } = useToast();
  const tz = useMemo(timezones, []);

  const [draft, setDraft] = useState<DraftState>(() => loadDraft(initialProfile));
  const [loading, setLoading] = useState(false);

  const step = draft.step;

  const updateDraft = useCallback((updater: (prev: DraftState) => DraftState) => {
    setDraft((prev) => {
      const next = updater(prev);
      saveDraft(next);
      return next;
    });
  }, []);

  const goTo = useCallback((s: number) => {
    updateDraft((d) => ({ ...d, step: s }));
  }, [updateDraft]);

  // Step 1 — Profile
  function captureProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    updateDraft((d) => ({
      ...d,
      profile: {
        firstName: String(form.get('firstName') ?? '').trim(),
        lastName: String(form.get('lastName') ?? '').trim(),
        phone: String(form.get('phone') ?? '').trim(),
        email: String(form.get('email') ?? '').trim(),
      },
      step: 2,
    }));
  }

  // Step 2 — Family name
  function captureFamily(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    updateDraft((d) => ({
      ...d,
      family: {
        name: String(form.get('name') ?? '').trim(),
        timezone: String(form.get('timezone') ?? 'America/New_York'),
      },
      step: 3,
    }));
  }

  // Step 3 — Family details
  const toggleGoal = useCallback((value: string) => {
    updateDraft((d) => {
      const goals = d.details.goals.includes(value)
        ? d.details.goals.filter((x) => x !== value)
        : [...d.details.goals, value];
      return { ...d, details: { ...d.details, goals } };
    });
  }, [updateDraft]);

  function captureDetails(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    updateDraft((d) => ({
      ...d,
      details: {
        ...d.details,
        householdAdults: Number(form.get('householdAdults') ?? 2),
        householdChildren: Number(form.get('householdChildren') ?? 0),
        childAges: String(form.get('childAges') ?? ''),
        region: String(form.get('region') ?? ''),
        postalCode: String(form.get('postalCode') ?? ''),
        referralSource: String(form.get('referralSource') ?? ''),
        referralDetail: String(form.get('referralDetail') ?? ''),
      },
      step: 4,
    }));
  }

  // Step 4 — Members
  const localFormRef = useRef<HTMLFormElement>(null);
  const inviteFormRef = useRef<HTMLFormElement>(null);

  function onAddLocal(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('memberName') ?? '').trim();
    const role = String(form.get('memberRole') ?? 'child') as MemberRole;
    const birthday = String(form.get('memberBirthday') ?? '').trim();
    if (!name) return;
    const member = makeLocalMember({ name, role, birthday: birthday || undefined }, draft.members);
    updateDraft((d) => ({ ...d, members: addMember(d.members, member) }));
    success(`${name} added`);
    e.currentTarget.reset();
  }

  function onAddInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('inviteEmail') ?? '').trim();
    const role = String(form.get('inviteRole') ?? 'adult') as MemberRole;
    if (!email) return;
    const member = makeInviteMember({ email, role });
    updateDraft((d) => ({ ...d, members: addMember(d.members, member) }));
    success(`${email} added`);
    e.currentTarget.reset();
  }

  function onRemoveMember(id: string) {
    updateDraft((d) => ({ ...d, members: removeMember(d.members, id) }));
  }

  // Step 5 — Review & finalize
  async function onFinalize() {
    setLoading(true);
    const res = await finalizeOnboardingAction({
      profile: draft.profile,
      family: draft.family,
      details: {
        householdAdults: draft.details.householdAdults,
        householdChildren: draft.details.householdChildren,
        childAges: parseChildAges(draft.details.childAges),
        region: draft.details.region,
        postalCode: draft.details.postalCode,
        goals: draft.details.goals,
        referralSource: draft.details.referralSource,
        referralDetail: draft.details.referralDetail,
      },
      members: draft.members.map((m) =>
        m.kind === 'invite'
          ? { kind: 'invite' as const, email: m.email, role: m.role }
          : { kind: 'local' as const, name: m.name, role: m.role, birthday: m.birthday, color: m.color },
      ),
    });
    setLoading(false);
    if (!res.ok) return showError(res.error);
    clearDraft();
    success('Welcome to Bubaly!');
    router.push('/dashboard');
    router.refresh();
  }

  // Back button helper
  function BackButton({ to }: { to: number }) {
    return (
      <button
        type="button"
        onClick={() => goTo(to)}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg transition"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Progress */}
      <div className="mb-6 flex items-center gap-3">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => (
          <div key={n} className="flex flex-1 items-center gap-3">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                step >= n ? 'bg-brand text-brand-fg' : 'bg-elevated text-muted'
              }`}
            >
              {step > n ? <Check className="h-4 w-4" /> : n}
            </div>
            {n < TOTAL_STEPS && <div className={`h-px flex-1 ${step > n ? 'bg-brand' : 'bg-border'}`} />}
          </div>
        ))}
      </div>

      {/* Step 1: Profile */}
      {step === 1 && (
        <div className="glass-card p-7">
          <div className="mb-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <User className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Tell us about you</h1>
          <p className="mt-1 text-sm text-muted">This is your account profile — your family will see your name.</p>
          <form onSubmit={captureProfile} className="mt-6 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="First name" required>
                {(id) => <Input id={id} name="firstName" defaultValue={draft.profile.firstName} placeholder="Jordan" autoFocus required />}
              </Field>
              <Field label="Last name" required>
                {(id) => <Input id={id} name="lastName" defaultValue={draft.profile.lastName} placeholder="Rivera" required />}
              </Field>
            </div>
            <Field label="Contact phone" hint="For account security and important family alerts" required>
              {(id) => <Input id={id} name="phone" type="tel" inputMode="tel" defaultValue={draft.profile.phone} placeholder="(555) 123-4567" required />}
            </Field>
            <Field
              label="Email"
              hint={emailLocked ? 'Managed by your Google sign-in' : 'Where we send invites and notifications'}
              required
            >
              {(id) => (
                <Input
                  id={id}
                  name="email"
                  type="email"
                  defaultValue={draft.profile.email}
                  placeholder="you@example.com"
                  required
                  readOnly={emailLocked}
                  aria-disabled={emailLocked || undefined}
                  tabIndex={emailLocked ? -1 : undefined}
                  className={emailLocked ? 'cursor-not-allowed opacity-60' : undefined}
                />
              )}
            </Field>
            <Button type="submit" className="w-full">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      {/* Step 2: Family name */}
      {step === 2 && (
        <div className="glass-card p-7">
          <BackButton to={1} />
          <div className="mb-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Home className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Name your family</h1>
          <p className="mt-1 text-sm text-muted">You can change this anytime in settings.</p>
          <form onSubmit={captureFamily} className="mt-6 space-y-4">
            <Field label="Family name" required>
              {(id) => <Input id={id} name="name" defaultValue={draft.family.name} placeholder="The Rivera Family" autoFocus required />}
            </Field>
            <Field label="Time zone" hint="Used for reminders and your calendar">
              {(id) => (
                <Select id={id} name="timezone" defaultValue={draft.family.timezone}>
                  {tz.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              )}
            </Field>
            <Button type="submit" className="w-full">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      {/* Step 3: Family details */}
      {step === 3 && (
        <div className="glass-card p-7">
          <BackButton to={2} />
          <div className="mb-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Users className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">About your family</h1>
          <p className="mt-1 text-sm text-muted">This helps us tailor Bubaly to you. You can skip anything.</p>
          <form onSubmit={captureDetails} className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Adults">
                {(id) => <Input id={id} name="householdAdults" type="number" inputMode="numeric" min={0} max={20} defaultValue={draft.details.householdAdults} />}
              </Field>
              <Field label="Children">
                {(id) => <Input id={id} name="householdChildren" type="number" inputMode="numeric" min={0} max={20} defaultValue={draft.details.householdChildren} />}
              </Field>
            </div>
            <Field label="Kids' ages" hint="Optional — e.g. 8, 11, 14. Helps age-appropriate chores.">
              {(id) => <Input id={id} name="childAges" defaultValue={draft.details.childAges} placeholder="8, 11, 14" />}
            </Field>

            <div>
              <p className="mb-2 text-sm font-medium">What do you want to use Bubaly for?</p>
              <div className="flex flex-wrap gap-2">
                {FAMILY_GOALS.map((g) => {
                  const on = draft.details.goals.includes(g.value);
                  return (
                    <button
                      key={g.value}
                      type="button"
                      onClick={() => toggleGoal(g.value)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
                        on ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:text-fg'
                      }`}
                    >
                      <span aria-hidden>{g.icon}</span> {g.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="State / region" hint="Optional">
                {(id) => <Input id={id} name="region" defaultValue={draft.details.region} placeholder="California" />}
              </Field>
              <Field label="ZIP / postal code" hint="Optional">
                {(id) => <Input id={id} name="postalCode" defaultValue={draft.details.postalCode} placeholder="94016" />}
              </Field>
            </div>

            <Field label="How did you hear about us?">
              {(id) => (
                <Select id={id} name="referralSource" defaultValue={draft.details.referralSource}>
                  <option value="">Select one…</option>
                  {REFERRAL_SOURCES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Anything else?" hint="Optional">
              {(id) => <Input id={id} name="referralDetail" defaultValue={draft.details.referralDetail} placeholder="A friend's name, the podcast, etc." />}
            </Field>

            <Button type="submit" className="w-full">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}

      {/* Step 4: Add family members */}
      {step === 4 && (
        <div className="space-y-5">
          <div className="glass-card p-7">
            <BackButton to={3} />
            <h1 className="text-2xl font-semibold tracking-tight">Add your family</h1>
            <p className="mt-1 text-sm text-muted">
              Add people who live with you — they don&apos;t need an email. Or invite someone by email. You can do this later too.
            </p>

            {draft.members.length > 0 && (
              <ul className="mt-5 space-y-2">
                {draft.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 px-3 py-2">
                    {m.kind === 'local' ? (
                      <Avatar name={m.name} color={m.color} size={32} />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-brand">
                        <Mail className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{draftMemberLabel(m)}</p>
                      <p className="text-xs text-muted">
                        {m.kind === 'invite' ? `Invite · ${ROLE_LABELS[m.role]}` : ROLE_LABELS[m.role]}
                      </p>
                    </div>
                    {m.kind === 'invite' && <Badge tone="brand">Pending</Badge>}
                    <button
                      type="button"
                      onClick={() => onRemoveMember(m.id)}
                      className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg transition"
                      aria-label={`Remove ${draftMemberLabel(m)}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add managed member (no login) */}
          <form ref={localFormRef} onSubmit={onAddLocal} className="glass-card space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plus className="h-4 w-4 text-brand" /> Add a family member (no login needed)
            </div>
            <p className="text-xs text-muted">
              For anyone who won&apos;t sign in — kids, grandparents, caregivers, etc.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input name="memberName" placeholder="Name" className="flex-1" required />
              <Select name="memberRole" defaultValue="child" className="sm:w-44">
                {LOCAL_MEMBER_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </Select>
            </div>
            <Field label="Birthday" hint="Optional — helps with age-appropriate features">
              {(id) => <Input id={id} name="memberBirthday" type="date" />}
            </Field>
            <Button type="submit" variant="secondary">
              <Plus className="h-4 w-4" /> Add member
            </Button>
          </form>

          {/* Invite by email */}
          <form ref={inviteFormRef} onSubmit={onAddInvite} className="glass-card space-y-3 p-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <UserPlus className="h-4 w-4 text-brand" /> Invite by email
            </div>
            <p className="text-xs text-muted">
              They&apos;ll get an email to create their own account and join your family.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input name="inviteEmail" type="email" placeholder="spouse@example.com" className="flex-1" required />
              <Select name="inviteRole" defaultValue="adult" className="sm:w-44">
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              <UserPlus className="h-4 w-4" /> Add invite
            </Button>
          </form>

          <Button onClick={() => goTo(5)} className="w-full" size="lg">
            Review &amp; finish <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      )}

      {/* Step 5: Review & finalize */}
      {step === 5 && (
        <div className="glass-card p-7">
          <BackButton to={4} />
          <div className="mb-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Check className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Everything look good?</h1>
          <p className="mt-1 text-sm text-muted">Review your info, then we&apos;ll set up your family.</p>

          <div className="mt-6 space-y-4">
            {/* Profile summary */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Your profile</h3>
                <button type="button" onClick={() => goTo(1)} className="text-xs text-brand hover:underline">Edit</button>
              </div>
              <p className="mt-1 text-sm text-muted">
                {draft.profile.firstName} {draft.profile.lastName} · {draft.profile.email}
              </p>
              {draft.profile.phone && <p className="text-sm text-muted">{draft.profile.phone}</p>}
            </div>

            {/* Family summary */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Family</h3>
                <button type="button" onClick={() => goTo(2)} className="text-xs text-brand hover:underline">Edit</button>
              </div>
              <p className="mt-1 text-sm text-muted">{draft.family.name}</p>
              <p className="text-xs text-muted">{draft.family.timezone}</p>
            </div>

            {/* Details summary */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Household</h3>
                <button type="button" onClick={() => goTo(3)} className="text-xs text-brand hover:underline">Edit</button>
              </div>
              <p className="mt-1 text-sm text-muted">
                {draft.details.householdAdults} adult{draft.details.householdAdults !== 1 ? 's' : ''},
                {' '}{draft.details.householdChildren} child{draft.details.householdChildren !== 1 ? 'ren' : ''}
              </p>
              {draft.details.goals.length > 0 && (
                <p className="text-xs text-muted">Goals: {draft.details.goals.join(', ')}</p>
              )}
            </div>

            {/* Members summary */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Members</h3>
                <button type="button" onClick={() => goTo(4)} className="text-xs text-brand hover:underline">Edit</button>
              </div>
              {draft.members.length === 0 ? (
                <p className="mt-1 text-sm text-muted">No members added — you can add them later from settings.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {draft.members.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      {m.kind === 'local' ? (
                        <Avatar name={m.name} color={m.color} size={20} />
                      ) : (
                        <Mail className="h-4 w-4 text-muted" />
                      )}
                      <span>{draftMemberLabel(m)}</span>
                      <span className="text-xs text-muted">({ROLE_LABELS[m.role]})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <Button onClick={onFinalize} loading={loading} className="mt-6 w-full" size="lg">
            Create my family <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      )}
    </div>
  );
}
