'use client';

// The Bubaly welcome journey — six focused moments, one atomic commit:
//   1. You            — avatar, name, colour (the only required field is a name)
//   2. Your family    — name it (smart suggestion) + household makeup
//   3. Your people    — add no-login profiles and/or email invites
//   4. What matters   — goals (drives the personalized launchpad) + referral
//   5. App lock       — optional PIN (seeds App Lock, always skippable)
//   6. Done           — THEIR family, THEIR people, THEIR first actions
//
// Design principles: never block first value (3 of 5 steps are skippable and
// clearly say so), never lose work (draft autosaves to sessionStorage — minus
// the PIN, which is never persisted), never write half a family (nothing hits
// the database until finalizeOnboardingAction commits everything atomically),
// and always pay off the questions we asked (goals become the launchpad).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ArrowRight, Check, Eye, EyeOff, Home, Loader2, Lock, Mail,
  Minus, PartyPopper, Plus, ShieldCheck, Sparkles, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AvatarPicker } from '@/components/ui/avatar-picker';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  FLOW_STEPS, STEP_LABELS, isSkippable, nextStep, prevStep, progressPct,
  emptyDraft, serializeDraft, hydrateDraft, DRAFT_KEY, canContinue,
  suggestFamilyName, goalQuickstart, detectTimezone,
  type FlowStep, type OnboardingDraft,
} from '@/lib/onboarding/flow';
import {
  MEMBER_COLORS, LOCAL_MEMBER_ROLES, INVITE_ROLES,
  makeLocalMember, makeInviteMember, addMember, removeMember, hasInviteEmail,
  summarizeMembers, type DraftMember,
} from '@/lib/onboarding/draft';
import { FAMILY_GOALS, REFERRAL_SOURCES, parseChildAges, householdSummary } from '@/lib/onboarding/family';
import { splitFullName } from '@/lib/onboarding/profile';
import { normalizePin, isValidPin, isWeakPin } from '@/lib/onboarding/pin';
import { ROLE_LABELS, type MemberRole } from '@/lib/constants/roles';
import { trackOnboarding } from '@/lib/analytics/onboarding-track';
import { finalizeOnboardingAction } from '@/app/onboarding/actions';

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

export function OnboardingWizard({ initialName = '' }: { initialName?: string }) {
  const router = useRouter();
  const { error: toastError } = useToast();

  const [draft, setDraft] = useState<OnboardingDraft>(() => ({ ...emptyDraft(), fullName: initialName }));
  const [hydrated, setHydrated] = useState(false);

  // PIN lives ONLY in memory — deliberately outside the persisted draft.
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [saving, setSaving] = useState(false);

  // "Add a person" mini-form state (people step).
  const [addMode, setAddMode] = useState<'profile' | 'invite'>('profile');
  const [mName, setMName] = useState('');
  const [mRole, setMRole] = useState<MemberRole>('child');
  const [iEmail, setIEmail] = useState('');
  const [iRole, setIRole] = useState<MemberRole>('adult');
  const [agesText, setAgesText] = useState('');

  const step = draft.step;
  const firstName = splitFullName(draft.fullName).firstName || 'there';

  // ── Resume a saved draft, then autosave every change ────────────────────────
  useEffect(() => {
    const saved = hydrateDraft(sessionStorage.getItem(DRAFT_KEY));
    if (saved) {
      setDraft(saved.fullName ? saved : { ...saved, fullName: initialName });
      setAgesText(saved.childAges.join(', '));
    }
    setHydrated(true);
    trackOnboarding('you', 'started');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<OnboardingDraft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      try { sessionStorage.setItem(DRAFT_KEY, serializeDraft(next)); } catch { /* storage full/blocked — keep going */ }
      return next;
    });
  };

  // ── Navigation ──────────────────────────────────────────────────────────────
  const goTo = (s: FlowStep) => {
    // Entering "family" with no name yet → offer the smart suggestion.
    if (s === 'family' && !draft.familyName.trim()) {
      update({ step: s, familyName: suggestFamilyName(draft.fullName) });
    } else {
      update({ step: s });
    }
    if (s !== 'done') trackOnboarding(s, 'step');
  };
  const advance = () => { if (canContinue(step, draft)) goTo(nextStep(step)); };
  const back = () => goTo(prevStep(step));

  // ── The one atomic commit ───────────────────────────────────────────────────
  async function commit(usePin: boolean) {
    setSaving(true);
    const { firstName: fn, lastName: ln } = splitFullName(draft.fullName);
    const res = await finalizeOnboardingAction({
      profile: { firstName: fn, lastName: ln, phone: '', email: '', avatarUrl: draft.avatarUrl || undefined },
      family: { name: draft.familyName.trim() || suggestFamilyName(draft.fullName), timezone: detectTimezone() },
      details: {
        householdAdults: draft.householdAdults,
        householdChildren: draft.householdChildren,
        childAges: draft.childAges,
        goals: draft.goals,
        referralSource: draft.referralSource || undefined,
      },
      members: draft.members.map((m) => m.kind === 'local'
        ? { kind: 'local' as const, name: m.name, role: m.role, birthday: m.birthday, color: m.color }
        : { kind: 'invite' as const, email: m.email, role: m.role as 'adult' | 'teen' | 'caregiver' | 'guest' }),
      appearance: {
        color: draft.color || undefined,
        age: draft.age || undefined,
        pin: usePin && isValidPin(pin) ? pin : undefined,
      },
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Something went wrong — please try again.');
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    trackOnboarding('done', 'completed');
    update({ step: 'done' });
  }

  // ── People step helpers ─────────────────────────────────────────────────────
  const addProfile = () => {
    const name = mName.trim();
    if (!name) return;
    update({ members: addMember(draft.members, makeLocalMember({ name, role: mRole }, draft.members)) });
    setMName('');
  };
  const addInvite = () => {
    const email = iEmail.trim().toLowerCase();
    if (!emailOk(email)) return toastError('Enter a valid email address.');
    if (hasInviteEmail(draft.members, email)) return toastError('That email is already on the list.');
    update({ members: addMember(draft.members, makeInviteMember({ email, role: iRole })) });
    setIEmail('');
  };

  const pinMatches = isValidPin(pin) && pin === confirm;
  const summary = summarizeMembers(draft.members);
  const quickstart = goalQuickstart(draft.goals);

  if (!hydrated) {
    return (
      <div className="grid min-h-[420px] place-items-center rounded-3xl border border-border bg-surface/40">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-border bg-surface/40 p-6 shadow-xl shadow-black/5 sm:p-8">
      {/* ── Labeled journey progress ── */}
      {step !== 'done' && (
        <div className="mb-7">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-brand">
              Step {FLOW_STEPS.indexOf(step) + 1} of {FLOW_STEPS.length - 1} · {STEP_LABELS[step]}
            </p>
            <p className="text-xs tabular-nums text-muted">{progressPct(step)}%</p>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
            <div className="h-full rounded-full bg-brand transition-all duration-500 ease-out" style={{ width: `${progressPct(step)}%` }} />
          </div>
          <div className="mt-2 hidden justify-between sm:flex">
            {FLOW_STEPS.filter((s) => s !== 'done').map((s) => (
              <span key={s} className={cn('text-[11px] transition-colors',
                s === step ? 'font-semibold text-fg' : FLOW_STEPS.indexOf(s) < FLOW_STEPS.indexOf(step) ? 'text-brand' : 'text-muted')}>
                {STEP_LABELS[s]}
              </span>
            ))}
          </div>
        </div>
      )}

      <div key={step} className="[animation:assistant-message-enter_.28s_ease]">
        {/* ═══ 1 · YOU ═══ */}
        {step === 'you' && (
          <form onSubmit={(e) => { e.preventDefault(); advance(); }}>
            <h1 className="text-center text-2xl font-bold sm:text-[1.7rem]">Welcome to Bubaly 👋</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-center text-sm text-muted">
              Let&rsquo;s set up your family&rsquo;s home base. First — you.
            </p>

            <div className="mt-6 flex justify-center">
              <AvatarPicker displayName={draft.fullName || 'You'} defaultValue={draft.avatarUrl} onChange={(url) => update({ avatarUrl: url })} />
            </div>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Your name <span className="text-brand">*</span></span>
                <input value={draft.fullName} onChange={(e) => update({ fullName: e.target.value })} autoFocus
                  placeholder="Jordan Lee" autoComplete="name"
                  className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring" />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <span className="mb-2 block text-sm font-medium">Your colour</span>
                  <div className="flex flex-wrap gap-2.5">
                    {MEMBER_COLORS.map((c) => (
                      <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => update({ color: c })}
                        className={cn('grid h-9 w-9 place-items-center rounded-full transition-transform hover:scale-110',
                          draft.color === c && 'scale-110 ring-2 ring-white/70 ring-offset-2 ring-offset-surface')}
                        style={{ backgroundColor: c }}>
                        {draft.color === c && <Check className="h-4 w-4 text-white" />}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="block sm:w-36">
                  <span className="mb-1 block text-sm font-medium">Age <span className="font-normal text-muted">(optional)</span></span>
                  <select value={draft.age} onChange={(e) => update({ age: e.target.value })}
                    className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
                    <option value="">Skip</option>
                    {Array.from({ length: 99 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>
            </div>

            <Button type="submit" className="mt-7 w-full" disabled={!canContinue('you', draft)}>
              Continue <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
            <p className="mt-3 text-center text-xs text-muted">Takes about a minute · you can change everything later</p>
          </form>
        )}

        {/* ═══ 2 · YOUR FAMILY ═══ */}
        {step === 'family' && (
          <form onSubmit={(e) => { e.preventDefault(); advance(); }}>
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand"><Home className="h-7 w-7" /></div>
            <h1 className="text-center text-2xl font-bold">Name your family space</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-center text-sm text-muted">
              This is what everyone sees when they join, {firstName}.
            </p>

            <div className="mt-6 space-y-5">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Family name <span className="text-brand">*</span></span>
                <input value={draft.familyName} onChange={(e) => update({ familyName: e.target.value })} autoFocus
                  placeholder="The Lee Family"
                  className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring" />
              </label>

              <div>
                <span className="mb-2 block text-sm font-medium">Who lives in your household?</span>
                <div className="grid grid-cols-2 gap-3">
                  {([['Adults', 'householdAdults', 1], ['Kids', 'householdChildren', 0]] as const).map(([label, key, min]) => (
                    <div key={key} className="rounded-xl border border-border bg-bg/50 p-3">
                      <p className="text-xs font-medium text-muted">{label}</p>
                      <div className="mt-1.5 flex items-center justify-between">
                        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`}
                          onClick={() => update({ [key]: Math.max(min, draft[key] - 1) } as Partial<OnboardingDraft>)}
                          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated hover:text-fg">
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="text-xl font-bold tabular-nums">{draft[key]}</span>
                        <button type="button" aria-label={`More ${label.toLowerCase()}`}
                          onClick={() => update({ [key]: Math.min(20, draft[key] + 1) } as Partial<OnboardingDraft>)}
                          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated hover:text-fg">
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">{householdSummary(draft.householdAdults, draft.householdChildren)}</p>
              </div>

              {draft.householdChildren > 0 && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Kids&rsquo; ages <span className="font-normal text-muted">(optional — helps us tailor things)</span></span>
                  <input value={agesText}
                    onChange={(e) => { setAgesText(e.target.value); update({ childAges: parseChildAges(e.target.value) }); }}
                    placeholder="e.g. 6, 9 and 13" inputMode="numeric"
                    className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring" />
                  {draft.childAges.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      {draft.childAges.map((a, i) => (
                        <span key={`${a}-${i}`} className="rounded-full bg-brand/12 px-2.5 py-0.5 text-xs font-medium text-brand">{a} yrs</span>
                      ))}
                    </span>
                  )}
                </label>
              )}
            </div>

            <div className="mt-7 flex gap-2">
              <Button type="button" variant="secondary" onClick={back}><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
              <Button type="submit" className="flex-1" disabled={!canContinue('family', draft)}>
                Continue <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </form>
        )}

        {/* ═══ 3 · YOUR PEOPLE ═══ */}
        {step === 'people' && (
          <div>
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand"><Users className="h-7 w-7" /></div>
            <h1 className="text-center text-2xl font-bold">Bring in your people</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-center text-sm text-muted">
              Add profiles for kids or grandparents (no email needed), or invite adults by email.
              You can always do this later.
            </p>

            {draft.members.length > 0 && (
              <ul className="mt-5 space-y-2">
                {draft.members.map((m: DraftMember) => (
                  <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg/50 p-2.5 [animation:assistant-message-enter_.2s_ease]">
                    {m.kind === 'local' ? (
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white"
                        style={{ backgroundColor: m.color ?? MEMBER_COLORS[0] }}>
                        {m.name.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/15 text-brand"><Mail className="h-4 w-4" /></span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{m.kind === 'local' ? m.name : m.email}</span>
                      <span className="block text-xs text-muted">{ROLE_LABELS[m.role]}{m.kind === 'invite' ? ' · email invite' : ''}</span>
                    </span>
                    <button type="button" aria-label="Remove" onClick={() => update({ members: removeMember(draft.members, m.id) })}
                      className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-danger">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 rounded-2xl border border-border bg-bg/40 p-4">
              <div className="mb-3 inline-flex rounded-lg border border-border bg-surface/70 p-0.5 text-sm">
                {([['profile', 'Add a profile', UserPlus], ['invite', 'Invite by email', Mail]] as const).map(([mode, label, Icon]) => (
                  <button key={mode} type="button" onClick={() => setAddMode(mode)}
                    className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition',
                      addMode === mode ? 'bg-brand text-white' : 'text-muted hover:text-fg')}>
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>

              {addMode === 'profile' ? (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); addProfile(); }}>
                  <input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="Name (e.g. Maya)"
                    className="h-10 flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
                  <select value={mRole} onChange={(e) => setMRole(e.target.value as MemberRole)}
                    className="h-10 rounded-lg border border-border bg-bg px-2.5 text-sm focus-ring">
                    {LOCAL_MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <Button type="submit" size="sm" className="h-10" disabled={!mName.trim()}><Plus className="mr-1 h-4 w-4" /> Add</Button>
                </form>
              ) : (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); addInvite(); }}>
                  <input value={iEmail} onChange={(e) => setIEmail(e.target.value)} placeholder="their@email.com" type="email"
                    className="h-10 flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
                  <select value={iRole} onChange={(e) => setIRole(e.target.value as MemberRole)}
                    className="h-10 rounded-lg border border-border bg-bg px-2.5 text-sm focus-ring">
                    {INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <Button type="submit" size="sm" className="h-10" disabled={!emailOk(iEmail)}><Plus className="mr-1 h-4 w-4" /> Invite</Button>
                </form>
              )}
              <p className="mt-2 text-xs text-muted">
                Profiles work without an email — perfect for young kids. Invites get a join link when you finish.
              </p>
            </div>

            <div className="mt-6 flex gap-2">
              <Button type="button" variant="secondary" onClick={back}><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
              <Button type="button" className="flex-1" onClick={advance}>
                {draft.members.length > 0 ? <>Continue with {summary.text} <ArrowRight className="ml-1 h-4 w-4" /></> : <>Continue <ArrowRight className="ml-1 h-4 w-4" /></>}
              </Button>
            </div>
            {draft.members.length === 0 && (
              <button type="button" onClick={advance} className="mt-3 w-full text-center text-sm font-medium text-muted transition hover:text-fg">
                Skip — it&rsquo;s just me for now
              </button>
            )}
          </div>
        )}

        {/* ═══ 4 · WHAT MATTERS ═══ */}
        {step === 'goals' && (
          <div>
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand"><Sparkles className="h-7 w-7" /></div>
            <h1 className="text-center text-2xl font-bold">What should Bubaly take off your plate?</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-center text-sm text-muted">
              Pick anything — we&rsquo;ll build your personalized starting point around it.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-2.5">
              {FAMILY_GOALS.map((g) => {
                const on = draft.goals.includes(g.value);
                return (
                  <button key={g.value} type="button" aria-pressed={on}
                    onClick={() => update({ goals: on ? draft.goals.filter((x) => x !== g.value) : [...draft.goals, g.value] })}
                    className={cn('flex items-center gap-2.5 rounded-xl border p-3 text-left text-sm font-medium transition',
                      on ? 'border-brand bg-brand/10 text-fg shadow-sm' : 'border-border bg-bg/50 text-muted hover:border-brand/40 hover:text-fg')}>
                    <span className="text-lg">{g.icon}</span>
                    <span className="min-w-0 flex-1">{g.label}</span>
                    {on && <Check className="h-4 w-4 shrink-0 text-brand" />}
                  </button>
                );
              })}
            </div>

            <label className="mt-5 block">
              <span className="mb-1 block text-sm font-medium">How did you hear about us? <span className="font-normal text-muted">(optional)</span></span>
              <select value={draft.referralSource} onChange={(e) => update({ referralSource: e.target.value })}
                className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
                <option value="">Choose…</option>
                {REFERRAL_SOURCES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>

            <div className="mt-7 flex gap-2">
              <Button type="button" variant="secondary" onClick={back}><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
              <Button type="button" className="flex-1" onClick={advance}>
                {draft.goals.length > 0 ? `Continue with ${draft.goals.length} pick${draft.goals.length === 1 ? '' : 's'}` : 'Continue'}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
            {draft.goals.length === 0 && (
              <button type="button" onClick={advance} className="mt-3 w-full text-center text-sm font-medium text-muted transition hover:text-fg">
                Skip for now
              </button>
            )}
          </div>
        )}

        {/* ═══ 5 · APP LOCK ═══ */}
        {step === 'pin' && (
          <form onSubmit={(e) => { e.preventDefault(); if (pinMatches && !saving) void commit(true); }}>
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand"><Lock className="h-7 w-7" /></div>
            <h1 className="text-center text-2xl font-bold">Add a PIN, {firstName}?</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-center text-sm text-muted">
              Optional — it seeds App Lock so your profile stays private on shared devices.
              Skip it and add one anytime in Settings.
            </p>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Create 4-digit PIN</span>
                <div className="relative">
                  <input value={pin} onChange={(e) => setPin(normalizePin(e.target.value))} inputMode="numeric"
                    type={showPin ? 'text' : 'password'} placeholder="••••" autoComplete="off"
                    className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
                  <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
                    {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Confirm PIN</span>
                <input value={confirm} onChange={(e) => setConfirm(normalizePin(e.target.value))} inputMode="numeric"
                  type={showPin ? 'text' : 'password'} placeholder="••••" autoComplete="off"
                  className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
              </label>

              {confirm.length === 4 && pin !== confirm && <p className="text-xs text-danger">PINs don&rsquo;t match.</p>}
              {isValidPin(pin) && isWeakPin(pin) && (
                <p className="text-xs text-amber-500">That PIN is easy to guess — consider a less obvious one.</p>
              )}
            </div>

            <div className="mt-7 flex gap-2">
              <Button type="button" variant="secondary" onClick={back} disabled={saving}><ArrowLeft className="mr-1 h-4 w-4" /> Back</Button>
              <Button type="submit" className="flex-1" disabled={!pinMatches || saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}
                Finish with PIN
              </Button>
            </div>
            <button type="button" onClick={() => void commit(false)} disabled={saving}
              className="mt-3 w-full text-center text-sm font-medium text-muted transition hover:text-fg disabled:opacity-50">
              {saving ? 'Setting up your family…' : 'Skip and finish'}
            </button>
          </form>
        )}

        {/* ═══ 6 · DONE — the personalized launchpad ═══ */}
        {step === 'done' && (
          <div className="text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-500/15 text-emerald-500">
              <PartyPopper className="h-8 w-8" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">{draft.familyName || 'Your family'} is ready! 🎉</h1>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
              Nice work, {firstName}. Here&rsquo;s your home base — built around what you told us.
            </p>

            {/* the family, at a glance */}
            <div className="mt-6 flex items-center justify-center">
              <div className="flex -space-x-2.5">
                <span className="grid h-12 w-12 place-items-center rounded-full text-lg font-bold text-white ring-4 ring-surface"
                  style={{ backgroundColor: draft.color || MEMBER_COLORS[0] }}>
                  {firstName.slice(0, 1).toUpperCase()}
                </span>
                {draft.members.filter((m) => m.kind === 'local').slice(0, 4).map((m) => (
                  <span key={m.id} className="grid h-12 w-12 place-items-center rounded-full text-lg font-bold text-white ring-4 ring-surface"
                    style={{ backgroundColor: m.color ?? MEMBER_COLORS[1] }}>
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
                {summary.invites > 0 && (
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-brand/15 text-sm font-semibold text-brand ring-4 ring-surface">
                    +{summary.invites}
                  </span>
                )}
              </div>
            </div>
            {summary.invites > 0 && (
              <p className="mt-2 text-xs text-muted">
                <Mail className="mr-1 inline h-3 w-3" /> {summary.invites} join {summary.invites === 1 ? 'invite' : 'invites'} sent by email
              </p>
            )}

            {/* their goals → their first actions */}
            <div className="mt-6 text-left">
              <p className="mb-2 text-sm font-semibold">
                {draft.goals.length > 0 ? 'Built around what matters to you' : 'Great places to start'}
              </p>
              <div className="space-y-2">
                {quickstart.map((q) => (
                  <a key={q.goal} href={q.href}
                    className="group flex items-center gap-3 rounded-xl border border-border bg-bg/50 p-3 transition hover:border-brand/50 hover:bg-elevated">
                    <span className="text-xl">{q.icon}</span>
                    <span className="flex-1 text-sm font-medium">{q.label}</span>
                    <ArrowRight className="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
                  </a>
                ))}
              </div>
            </div>

            <Button className="mt-7 w-full" onClick={() => { router.push('/dashboard'); router.refresh(); }}>
              Open your dashboard <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
