'use client';

// Onboarding — a guided, six-step journey that sets up the whole family space in
// ONE atomic write at the very end (finalizeOnboardingAction). Nothing is written
// to Supabase until "Finish", so abandoning midway leaves no half-created account.
//   1) Profile   — avatar, name, age, colour
//   2) Family    — name your shared space (timezone auto-detected)
//   3) About     — household makeup, goals, how they found us
//   4) Members   — add people or invite by email (skippable)
//   5) PIN       — optional App Lock (skippable)
//   6) Done      — a celebratory summary → straight to the dashboard
// All flow logic (steps, progress, validation, draft→payload) lives in the pure,
// tested lib/onboarding/flow.ts; this file is the renderer.

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck, Users, Sparkles, ArrowRight, ArrowLeft, Eye, EyeOff, Check, Loader2,
  Lock, Home, Plus, X, Mail, UserPlus, Minus, PartyPopper, KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AvatarPicker } from '@/components/ui/avatar-picker';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { trackOnboarding } from '@/lib/analytics/onboarding-track';
import { MEMBER_COLORS, LOCAL_MEMBER_ROLES, INVITE_ROLES, makeLocalMember, makeInviteMember, addMember, removeMember, hasInviteEmail, draftMemberLabel, kidsNeedingLogin, type DraftMember } from '@/lib/onboarding/draft';
import { FAMILY_GOALS, REFERRAL_SOURCES, householdSummary } from '@/lib/onboarding/family';
import { normalizePin, isValidPin, isWeakPin } from '@/lib/onboarding/pin';
import { ROLE_LABELS, type MemberRole } from '@/lib/constants/roles';
import {
  STEP_META, progressPct, stepCounter, nextStep, prevStep, isFirstStep,
  isLastFormStep, canAdvance, suggestFamilyName, emptyDraft, buildFinalizePayload,
  serializeDraftState, parseDraftState, DRAFT_STORAGE_KEY,
  type OnboardingStep, type OnboardingDraft,
} from '@/lib/onboarding/flow';
import { finalizeOnboardingAction, previewCalendarImportAction } from '@/app/onboarding/actions';
import { buildFirstBrief, type FirstBrief } from '@/lib/onboarding/first-brief';
import { CalendarDays, Clipboard, AlertTriangle, ListChecks, Clock, Wand2, Utensils } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';

const inputCls = 'h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring';
/** Pragmatic "looks like an email" check for the invite field. */
const isLikelyEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s ?? '').trim());

export function OnboardingWizard({ initialName = '', initialLastName = '' }: { initialName?: string; initialLastName?: string }) {
  const tr = useTranslations();
  const router = useRouter();
  const { error: toastError } = useToast();

  const [step, setStep] = useState<OnboardingStep>('profile');
  const [draft, setDraft] = useState<OnboardingDraft>(() =>
    emptyDraft({ name: initialName, lastName: initialLastName, color: MEMBER_COLORS[0], familyName: suggestFamilyName(initialName) }));
  const [familyNameTouched, setFamilyNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // The server-computed first brief (timeline · clashes · dinner ideas · time
  // saved), returned by finalize and shown on the celebration screen.
  const [doneBrief, setDoneBrief] = useState<FirstBrief | null>(null);

  const update = useCallback((patch: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const firstName = draft.name.trim().split(' ')[0] || 'there';
  // Becomes true once we've attempted a sessionStorage restore, so we never
  // persist over (or race with) the restore on first paint.
  const [hydrated, setHydrated] = useState(false);

  // Resume an in-progress wizard after a refresh/navigation (nothing is written
  // to the DB until Finish, so the draft lives only in sessionStorage — minus
  // the PIN). Runs once, before the sync effects below matter.
  useEffect(() => {
    const restored = parseDraftState(typeof window !== 'undefined' ? sessionStorage.getItem(DRAFT_STORAGE_KEY) : null);
    if (restored) {
      setStep(restored.step);
      setDraft(restored.draft);
      setFamilyNameTouched(restored.familyNameTouched);
    }
    setHydrated(true);
  }, []);

  // Persist the resumable state whenever it changes (after the restore attempt).
  useEffect(() => {
    if (!hydrated || step === 'done') return;
    try { sessionStorage.setItem(DRAFT_STORAGE_KEY, serializeDraftState(step, draft, familyNameTouched)); } catch { /* ignore quota */ }
  }, [hydrated, step, draft, familyNameTouched]);

  // Detect the browser timezone once so the family calendar is right from day one.
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setDraft((d) => ({ ...d, timezone: tz }));
    } catch { /* keep UTC */ }
  }, []);

  // Keep the family name synced to the suggestion until the user edits it. Gated
  // on `hydrated` so a sessionStorage restore isn't overwritten by the suggestion
  // during the same commit (the restore sets familyNameTouched a beat later).
  useEffect(() => {
    if (!hydrated) return;
    if (!familyNameTouched) setDraft((d) => ({ ...d, familyName: suggestFamilyName(d.name) }));
  }, [hydrated, draft.name, familyNameTouched]);

  useEffect(() => { trackOnboarding('profile', 'started'); }, []);

  const canGo = canAdvance(step, draft);
  const { current, total } = stepCounter(step);

  // Accessibility: announce each step change to screen readers, and move focus
  // into the new step's heading for steps that have no auto-focused input (about
  // /members/pin) so keyboard + SR users land in the content instead of being
  // stranded on the "Continue" button. Profile/Family keep their input autofocus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [liveMsg, setLiveMsg] = useState('');
  const firstStepRun = useRef(true);
  useEffect(() => {
    if (step === 'done') return;
    setLiveMsg(`Step ${current} of ${total}: ${STEP_META[step].title}`);
    if (!firstStepRun.current && (step === 'value' || step === 'about' || step === 'members' || step === 'pin')) {
      headingRef.current?.focus();
    }
    firstStepRun.current = false;
  }, [step, current, total]);

  async function finish() {
    setSaving(true);
    const res = await finalizeOnboardingAction(buildFinalizePayload(draft));
    setSaving(false);
    if (!res.ok) { toastError(res.error ?? 'Something went wrong finishing setup'); return; }
    setDoneBrief(res.data?.brief ?? null);
    trackOnboarding('done', 'completed');
    try { sessionStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* ignore */ }
    setStep('done');
  }

  function advance() {
    if (!canGo) return;
    if (isLastFormStep(step)) { void finish(); return; }
    const next = nextStep(step);
    trackOnboarding(next, 'step');
    setStep(next);
  }

  return (
    <div className="rounded-3xl border border-border bg-surface/40 p-6 shadow-sm sm:p-8">
      {/* Screen-reader-only live region: announces navigation between steps. */}
      <p className="sr-only" role="status" aria-live="polite">{liveMsg}</p>
      {step !== 'done' && (
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted">
            <span>{tr('onboardingWizard.step')} {current} of {total}</span>
            <span>{progressPct(step)}%</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-valuenow={progressPct(step)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Setup progress: step ${current} of ${total}`}
          >
            <div className="h-full rounded-full bg-brand transition-all duration-500 ease-out" style={{ width: `${progressPct(step)}%` }} />
          </div>
        </div>
      )}

      <div key={step} className="animate-in fade-in slide-in-from-bottom-2 duration-300"
        role="group" aria-labelledby={step !== 'done' ? 'onboarding-step-title' : undefined}>
        {step !== 'done' && (
          <div className="mb-6 text-center">
            <h1 id="onboarding-step-title" ref={headingRef} tabIndex={-1}
              className="text-2xl font-bold tracking-tight outline-none">{STEP_META[step].title}</h1>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{STEP_META[step].subtitle}</p>
          </div>
        )}

        {step === 'profile' && <ProfilePanel draft={draft} update={update} onEnter={advance} />}
        {step === 'family' && (
          <FamilyPanel draft={draft} firstName={firstName} onEnter={advance}
            onChange={(v) => { setFamilyNameTouched(true); update({ familyName: v }); }} />
        )}
        {step === 'value' && <ValuePanel draft={draft} update={update} />}
        {step === 'about' && <AboutPanel draft={draft} update={update} />}
        {step === 'members' && <MembersPanel draft={draft} update={update} />}
        {step === 'pin' && <PinPanel draft={draft} update={update} firstName={firstName} />}
        {step === 'done' && <DonePanel draft={draft} firstName={firstName} brief={doneBrief} onGo={() => { router.push('/dashboard'); router.refresh(); }} />}
      </div>

      {step !== 'done' && (
        <div className="mt-8">
          <div className="flex gap-2">
            {!isFirstStep(step) && (
              <Button variant="secondary" onClick={() => setStep(prevStep(step))} disabled={saving}>
                <ArrowLeft className="h-4 w-4" /> {tr('onboardingWizard.back')}
              </Button>
            )}
            <Button className="flex-1" onClick={advance} disabled={!canGo || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isLastFormStep(step) ? 'Finish setup' : 'Continue'}
              {!saving && !isLastFormStep(step) && <ArrowRight className="h-4 w-4" />}
            </Button>
          </div>
          {(step === 'value' || step === 'about' || step === 'members' || step === 'pin') && (
            <button type="button" disabled={saving}
              onClick={() => {
                // Skip bypasses the step's advance gate. On PIN, finish directly —
                // buildFinalizePayload already drops any partial/invalid PIN.
                if (step === 'pin') { void finish(); return; }
                const next = nextStep(step); trackOnboarding(next, 'step'); setStep(next);
              }}
              className="mt-3 w-full text-center text-sm font-medium text-muted transition hover:text-fg disabled:opacity-50">
              {step === 'pin' ? 'Skip — I’ll add a PIN later'
                : step === 'value' ? 'Skip — I’ll connect my calendar later'
                : 'Skip for now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 1: Profile ──────────────────────────────────────────────────────────
function ProfilePanel({ draft, update, onEnter }: { draft: OnboardingDraft; update: (p: Partial<OnboardingDraft>) => void; onEnter: () => void }) {
  const tr = useTranslations();
  return (
    <div>
      <div className="flex justify-center">
        <AvatarPicker displayName={draft.name || 'You'} defaultValue={draft.avatarUrl} onChange={(v) => update({ avatarUrl: v })} />
      </div>
      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.yourName')} <span className="text-brand-text">*</span></span>
          <input value={draft.name} onChange={(e) => update({ name: e.target.value })} autoFocus placeholder={tr('onboardingWizard.jordan')}
            aria-required="true" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.howOldAreYou')} <span className="font-normal text-muted">(optional)</span></span>
          <select value={draft.age} onChange={(e) => update({ age: e.target.value })} className={inputCls}>
            <option value="">{tr('onboardingWizard.preferNotToSay')}</option>
            {Array.from({ length: 99 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div>
          <span className="mb-2 block text-sm font-medium">{tr('onboardingWizard.chooseYourColour')}</span>
          <div className="flex flex-wrap gap-2.5">
            {MEMBER_COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={draft.color === c} onClick={() => update({ color: c })}
                className={cn('grid h-9 w-9 place-items-center rounded-full transition', draft.color === c && 'ring-2 ring-white/70')}
                style={{ backgroundColor: c }}>
                {draft.color === c && <Check className="h-4 w-4 text-white" />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step 2: Family ───────────────────────────────────────────────────────────
function FamilyPanel({ draft, firstName, onChange, onEnter }: { draft: OnboardingDraft; firstName: string; onChange: (v: string) => void; onEnter: () => void }) {
  const tr = useTranslations();
  const tzLabel = draft.timezone && draft.timezone !== 'UTC' ? draft.timezone.replace(/_/g, ' ') : 'your local time';
  return (
    <div>
      <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl text-white" aria-hidden="true" style={{ backgroundColor: draft.color || MEMBER_COLORS[0] }}>
        <Home className="h-8 w-8" />
      </div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.familyName')} <span className="text-brand-text">*</span></span>
        <input value={draft.familyName} onChange={(e) => onChange(e.target.value)} autoFocus placeholder={suggestFamilyName(firstName) || 'The Smith Family'}
          aria-required="true" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} className={inputCls} />
      </label>
      <p className="mt-2 text-xs text-muted">{tr('onboardingWizard.thisIsYourSharedSpaceEveryone')}</p>
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border bg-bg/40 px-3 py-2.5 text-xs text-muted">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-text" />
        <span>{tr('onboardingWizard.calendarsAmpRemindersWillUse')} <span className="font-medium text-fg">{tzLabel}</span>{tr('onboardingWizard.detectedAutomatically')}</span>
      </div>
    </div>
  );
}

// ─── Step 3: About your family ────────────────────────────────────────────────
function Stepper({ label, value, onChange, min = 0, max = 20 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-bg/40 px-3 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <button type="button" aria-label={`Fewer ${label}`} onClick={() => onChange(Math.max(min, value - 1))}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated disabled:opacity-40" disabled={value <= min}>
          <Minus className="h-4 w-4" />
        </button>
        <span className="w-5 text-center text-sm font-semibold tabular-nums">{value}</span>
        <button type="button" aria-label={`More ${label}`} onClick={() => onChange(Math.min(max, value + 1))}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated disabled:opacity-40" disabled={value >= max}>
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Value — import a calendar, see the instant payoff ─────────────────
function ValuePanel({ draft, update }: { draft: OnboardingDraft; update: (p: Partial<OnboardingDraft>) => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [ics, setIcs] = useState('');
  const [loading, setLoading] = useState<null | 'paste' | 'demo'>(null);
  // Recompute the brief locally when returning to the step (events live in the draft).
  const [brief, setBrief] = useState<FirstBrief | null>(() =>
    draft.importedEvents.length ? buildFirstBrief(draft.importedEvents, new Date()) : null);

  async function run(source: 'paste' | 'demo') {
    setLoading(source);
    const res = await previewCalendarImportAction({ source, icsText: source === 'paste' ? ics : undefined });
    setLoading(null);
    if (!res.ok) { toastError(res.error); return; }
    if (!res.data) { toastError(tr('onboardingWizard.couldNotReadThatCalendar')); return; }
    setBrief(res.data.brief);
    update({ importedEvents: res.data.events, importSource: res.data.source });
    trackOnboarding('value', 'step');
  }

  function reset() {
    setBrief(null); setIcs('');
    update({ importedEvents: [], importSource: '' });
  }

  if (brief) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4 text-center">
          <div className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-brand/15 text-brand-text">
            <Sparkles className="h-5 w-5" />
          </div>
          <p className="text-base font-semibold">{brief.headline}</p>
          {brief.timeSavedMinutes > 0 && (
            <p className="mt-1 text-sm text-muted">
              {tr('onboardingWizard.bubalyJustSavedYouAbout')} <span className="font-semibold text-fg">{brief.timeSavedMinutes} minutes</span> {tr('onboardingWizard.ofPlanning')}
            </p>
          )}
        </div>

        {brief.timeline.length > 0 && (
          <section className="rounded-2xl border border-border p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.today')}</h2>
            <ul className="space-y-1.5">
              {brief.timeline.slice(0, 6).map((t, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate"><span className="font-medium">{t.title}</span>{t.location ? <span className="text-muted"> · {t.location}</span> : null}</span>
                  <span className="shrink-0 tabular-nums text-muted">{t.timeLabel}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {brief.conflicts.length > 0 && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" /> {brief.conflicts.length} clash{brief.conflicts.length === 1 ? '' : 'es'} {tr('onboardingWizard.toResolve')}</h2>
            <ul className="space-y-1 text-sm text-muted">
              {brief.conflicts.slice(0, 3).map((c, i) => (
                <li key={i}><span className="font-medium text-fg">{c.aTitle}</span> overlaps <span className="font-medium text-fg">{c.bTitle}</span> · {c.dayLabel} {c.overlapLabel}</li>
              ))}
            </ul>
          </section>
        )}

        {brief.actions.length > 0 && (
          <section className="rounded-2xl border border-border p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.firstThingsToHandle')}</h2>
            <ul className="space-y-1.5 text-sm">
              {brief.actions.slice(0, 4).map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-text" />
                  <span><span className="font-medium">{a.label}</span> — <span className="text-muted">{a.detail}</span></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {brief.opportunities.length > 0 && (
          <section className="rounded-2xl border border-border p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.workingForYouAlready')}</h2>
            <ul className="space-y-1.5 text-sm">
              {brief.opportunities.map((o) => (
                <li key={o.id}><span className="font-medium">{o.label}</span> <span className="text-muted">· {o.detail}</span></li>
              ))}
            </ul>
          </section>
        )}

        {brief.dinnerIdeas.length > 0 && (
          <section className="rounded-2xl border border-border p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Utensils className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.dinnerIdeasForTonight')}</h2>
            <ul className="space-y-1.5 text-sm">
              {brief.dinnerIdeas.map((d) => (
                <li key={d.title} className="flex items-baseline justify-between gap-3">
                  <span className="truncate"><span className="font-medium">{d.title}</span> <span className="text-muted">· {d.cuisine}</span></span>
                  <span className="shrink-0 text-xs text-muted">{d.prepMinutes} min</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <button type="button" onClick={reset} className="w-full text-center text-xs font-medium text-muted underline-offset-2 hover:text-fg hover:underline">
          {tr('onboardingWizard.importADifferentCalendar')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border p-4">
        <label htmlFor="ics-paste" className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Clipboard className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.pasteYourCalendarExportIcs')}
        </label>
        <p className="mb-2 text-xs text-muted">
          {tr('onboardingWizard.inGoogleAppleOutlookCalendarExport')} <code className="rounded bg-surface px-1">.ics</code> {tr('onboardingWizard.fileAndPasteItsContentsHere')}
        </p>
        <textarea
          id="ics-paste" value={ics} onChange={(e) => setIcs(e.target.value)}
          placeholder="BEGIN:VCALENDAR …" rows={4}
          className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs focus-ring" />
        <Button className="mt-3 w-full" onClick={() => run('paste')} disabled={loading !== null || ics.trim().length === 0}>
          {loading === 'paste' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
          {tr('onboardingWizard.buildMyDay')}
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>

      <button type="button" onClick={() => run('demo')} disabled={loading !== null}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-4 text-sm font-medium transition hover:border-brand/50 hover:bg-brand/5 disabled:opacity-50">
        {loading === 'demo' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4 text-brand-text" />}
        {tr('onboardingWizard.seeItWithASampleFamily')}
      </button>
    </div>
  );
}

function AboutPanel({ draft, update }: { draft: OnboardingDraft; update: (p: Partial<OnboardingDraft>) => void }) {
  const tr = useTranslations();
  const setChildren = (n: number) => {
    const childAges = Array.from({ length: n }, (_, i) => draft.childAges[i] ?? 0);
    update({ children: n, childAges });
  };
  const toggleGoal = (v: string) =>
    update({ goals: draft.goals.includes(v) ? draft.goals.filter((g) => g !== v) : [...draft.goals, v] });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Stepper label={tr('onboardingWizard.adults')} value={draft.adults} onChange={(n) => update({ adults: n })} min={1} />
        <Stepper label={tr('onboardingWizard.kids')} value={draft.children} onChange={setChildren} />
      </div>
      <p className="-mt-2 text-center text-xs text-muted">{householdSummary(draft.adults, draft.children)}</p>

      {draft.children > 0 && (
        <div>
          <span className="mb-2 block text-sm font-medium">{tr('onboardingWizard.kidsAges')} <span className="font-normal text-muted">(optional)</span></span>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: draft.children }, (_, i) => (
              <input key={i} inputMode="numeric" placeholder="Age" aria-label={`Child ${i + 1} age`}
                value={draft.childAges[i] ? String(draft.childAges[i]) : ''}
                onChange={(e) => {
                  const n = Math.min(21, Math.max(0, parseInt(e.target.value.replace(/\D/g, ''), 10) || 0));
                  const childAges = [...draft.childAges]; childAges[i] = n; update({ childAges });
                }}
                className="h-10 w-14 rounded-xl border border-border bg-bg text-center text-sm focus-ring" />
            ))}
          </div>
        </div>
      )}

      <div>
        <span className="mb-2 block text-sm font-medium">{tr('onboardingWizard.whatDoYouWantHelpWith')} <span className="font-normal text-muted">{tr('onboardingWizard.pickAny')}</span></span>
        <div className="grid grid-cols-2 gap-2">
          {FAMILY_GOALS.map((g) => {
            const on = draft.goals.includes(g.value);
            return (
              <button key={g.value} type="button" onClick={() => toggleGoal(g.value)}
                className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition',
                  on ? 'border-brand bg-brand/10 text-fg' : 'border-border bg-bg/40 text-muted hover:border-brand/40')}>
                <span className="text-base">{g.icon}</span>
                <span className="flex-1 truncate font-medium">{g.label}</span>
                {on && <Check className="h-4 w-4 text-brand-text" />}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.howDidYouHearAboutUs')} <span className="font-normal text-muted">(optional)</span></span>
        <select value={draft.referralSource} onChange={(e) => update({ referralSource: e.target.value })} className={inputCls}>
          <option value="">{tr('onboardingWizard.selectOne')}</option>
          {REFERRAL_SOURCES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>
    </div>
  );
}

// ─── Step 4: Members ──────────────────────────────────────────────────────────
function MembersPanel({ draft, update }: { draft: OnboardingDraft; update: (p: Partial<OnboardingDraft>) => void }) {
  const tr = useTranslations();
  const [mode, setMode] = useState<'person' | 'invite'>('person');
  const [name, setName] = useState('');
  const [role, setRole] = useState<MemberRole>('child');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('adult');

  const addPerson = () => {
    if (!name.trim()) return;
    update({ members: addMember(draft.members, makeLocalMember({ name, role }, draft.members)) });
    setName(''); setRole('child');
  };
  const addInvite = () => {
    const e = email.trim().toLowerCase();
    if (!isLikelyEmail(e) || hasInviteEmail(draft.members, e)) return;
    update({ members: addMember(draft.members, makeInviteMember({ email: e, role: inviteRole })) });
    setEmail(''); setInviteRole('adult');
  };

  return (
    <div className="space-y-4">
      {draft.members.length > 0 && (
        <ul className="space-y-2">
          {draft.members.map((m: DraftMember) => (
            <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-bg/40 px-3 py-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: m.color ?? '#7c6dff' }}>
                {m.kind === 'invite' ? <Mail className="h-4 w-4" /> : (m.name.slice(0, 1).toUpperCase() || '?')}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{draftMemberLabel(m)}</p>
                <p className="text-xs text-muted">{m.kind === 'invite' ? 'Invite' : ROLE_LABELS[m.role]}{m.kind === 'invite' ? ` · ${ROLE_LABELS[m.role]}` : ''}</p>
              </div>
              <button type="button" aria-label={tr('onboardingWizard.remove')} onClick={() => update({ members: removeMember(draft.members, m.id) })}
                className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-danger">
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-2xl border border-border bg-bg/30 p-3">
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-border/50 p-1 text-sm">
          <button type="button" onClick={() => setMode('person')} className={cn('flex items-center justify-center gap-1.5 rounded-md py-1.5 font-medium transition', mode === 'person' ? 'bg-surface text-fg shadow-sm' : 'text-muted')}>
            <UserPlus className="h-4 w-4" /> {tr('onboardingWizard.addAPerson')}
          </button>
          <button type="button" onClick={() => setMode('invite')} className={cn('flex items-center justify-center gap-1.5 rounded-md py-1.5 font-medium transition', mode === 'invite' ? 'bg-surface text-fg shadow-sm' : 'text-muted')}>
            <Mail className="h-4 w-4" /> {tr('onboardingWizard.inviteByEmail')}
          </button>
        </div>

        {mode === 'person' ? (
          <div className="space-y-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('onboardingWizard.nameEGLeo')} className={inputCls}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} />
            <div className="flex gap-2">
              <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)} className={cn(inputCls, 'flex-1')}>
                {LOCAL_MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <Button type="button" variant="secondary" onClick={addPerson} disabled={!name.trim()}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="name@email.com" className={inputCls}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInvite(); } }} />
            <div className="flex gap-2">
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as MemberRole)} className={cn(inputCls, 'flex-1')}>
                {INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <Button type="button" variant="secondary" onClick={addInvite} disabled={!isLikelyEmail(email.trim())}><Plus className="h-4 w-4" /> {tr('onboardingWizard.invite')}</Button>
            </div>
            <p className="text-xs text-muted">{tr('onboardingWizard.theyllGetAnEmailWithA')} {draft.familyName || 'your family'}.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 5: PIN ──────────────────────────────────────────────────────────────
function PinPanel({ draft, update, firstName }: { draft: OnboardingDraft; update: (p: Partial<OnboardingDraft>) => void; firstName: string }) {
  const tr = useTranslations();
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand-text"><Lock className="h-7 w-7" /></div>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.createA4DigitPin')}</span>
          <div className="relative">
            <input value={draft.pin} onChange={(e) => update({ pin: normalizePin(e.target.value) })} inputMode="numeric" type={show ? 'text' : 'password'} placeholder="••••"
              className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide PIN' : 'Show PIN'} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{tr('onboardingWizard.confirmPin')}</span>
          <input value={draft.confirmPin} onChange={(e) => update({ confirmPin: normalizePin(e.target.value) })} inputMode="numeric" type={show ? 'text' : 'password'} placeholder="••••"
            className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
        </label>

        {draft.confirmPin.length === 4 && draft.pin !== draft.confirmPin && <p className="text-xs text-danger">{tr('onboardingWizard.pinsDontMatch')}</p>}
        {isValidPin(draft.pin) && isWeakPin(draft.pin) && <p className="text-xs text-amber-500">{tr('onboardingWizard.thatPinIsEasyToGuess')}</p>}

        <div className="rounded-xl border border-border bg-bg/50 p-3">
          <p className="mb-1.5 text-xs font-semibold text-muted">{tr('onboardingWizard.whyAPin')}</p>
          <ul className="space-y-1 text-xs text-muted">
            <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand-text" /> {tr('onboardingWizard.keeps')} {firstName}{tr('onboardingWizard.sProfilePrivateOnSharedDevices')}</li>
            <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand-text" /> {tr('onboardingWizard.storedSecurelyAppLockStaysOff')}</li>
            <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand-text" /> {tr('onboardingWizard.totallyOptionalYouCanAddOne')}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─── Step 6: Done ─────────────────────────────────────────────────────────────
function DonePanel({ draft, firstName, brief, onGo }: { draft: OnboardingDraft; firstName: string; brief: FirstBrief | null; onGo: () => void }) {
  const tr = useTranslations();
  const hasBrief = !!brief && (brief.todayCount > 0 || brief.dinnerIdeas.length > 0 || brief.timeSavedMinutes > 0 || brief.conflicts.length > 0);
  const memberCount = draft.members.length;
  const goalCount = draft.goals.length;
  // Local (no-email) kids can't sign in with an email — nudge the parent to give
  // them a username + PIN login (the feature lives at /dashboard/family-access).
  const kids = kidsNeedingLogin(draft.members);
  const kidNames = kids.map((k) => k.name.trim().split(' ')[0]).filter(Boolean);
  const kidLabel = kidNames.length === 0 ? 'the kids'
    : kidNames.length === 1 ? kidNames[0]
    : kidNames.length === 2 ? `${kidNames[0]} & ${kidNames[1]}`
    : 'the kids';
  return (
    <div className="text-center">
      <div className="relative mx-auto h-24 w-24">
        <span className="grid h-24 w-24 place-items-center rounded-full text-3xl font-bold text-white" style={{ backgroundColor: draft.color || MEMBER_COLORS[0] }}>
          {firstName.slice(0, 1).toUpperCase()}
        </span>
        <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-emerald-500 text-white ring-4 ring-surface">
          <Check className="h-4 w-4" />
        </span>
      </div>
      <h1 className="mt-4 flex items-center justify-center gap-2 text-2xl font-bold">{tr('onboardingWizard.youreAllSet')} {firstName}! <PartyPopper className="h-6 w-6 text-brand-text" /></h1>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{draft.familyName || 'Your family'} {tr('onboardingWizard.isReadyWelcomeToBubaly')}</p>

      {hasBrief && brief && (
        <div className="mt-6 space-y-3 text-left">
          <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {brief.headline}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {brief.timeSavedMinutes > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2.5 py-1 text-xs font-medium text-brand-text"><Clock className="h-3 w-3" /> ~{brief.timeSavedMinutes} {tr('onboardingWizard.minSaved')}</span>
              )}
              {brief.todayCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-medium"><CalendarDays className="h-3 w-3 text-brand-text" /> {brief.todayCount} today</span>
              )}
              {brief.conflicts.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600"><AlertTriangle className="h-3 w-3" /> {brief.conflicts.length} clash{brief.conflicts.length === 1 ? '' : 'es'}</span>
              )}
            </div>
          </div>

          {brief.dinnerIdeas.length > 0 && (
            <div className="rounded-2xl border border-border p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Utensils className="h-4 w-4 text-brand-text" /> {tr('onboardingWizard.dinnerIdeasForThisWeek')}</p>
              <ul className="space-y-1.5 text-sm">
                {brief.dinnerIdeas.map((d) => (
                  <li key={d.title} className="flex items-baseline justify-between gap-3">
                    <span className="truncate"><span className="font-medium">{d.title}</span> <span className="text-muted">· {d.cuisine}</span></span>
                    <span className="shrink-0 text-xs text-muted">{d.prepMinutes} min</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 space-y-3 text-left">
        {[
          { icon: Home, title: draft.familyName || 'Your family', body: `Your shared space is live${goalCount ? ` — set up for ${goalCount} focus area${goalCount === 1 ? '' : 's'}` : ''}.` },
          { icon: Users, title: memberCount ? `${memberCount} ${memberCount === 1 ? 'person' : 'people'} added` : 'Invite your family', body: memberCount ? 'They’re in your space (invites are on their way).' : 'Add family members anytime from Settings.' },
          { icon: Sparkles, title: 'Let’s begin', body: 'Your dashboard is personalized and ready to explore.' },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex items-start gap-3 rounded-xl border border-border bg-bg/40 p-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand-text"><Icon className="h-4 w-4" /></div>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{title}</p><p className="text-xs text-muted">{body}</p></div>
          </div>
        ))}
      </div>

      <Button className="mt-7 w-full" onClick={onGo}>{tr('onboardingWizard.startExploring')} <ArrowRight className="ml-1 h-4 w-4" /></Button>

      {kids.length > 0 && (
        <Link
          href="/dashboard/family-access"
          className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm font-semibold text-brand-text transition hover:bg-brand/15"
        >
          <KeyRound className="h-4 w-4 shrink-0" />
          {tr('onboardingWizard.give')} {kidLabel} {tr('onboardingWizard.aLoginUsernameAmpPinNo')}
        </Link>
      )}

      <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted"><ShieldCheck className="h-3.5 w-3.5" /> {tr('onboardingWizard.yourInformationIsProtectedWithTop')}</p>
    </div>
  );
}
