// lib/onboarding/flow.ts — pure, unit-tested logic for the world-class onboarding
// wizard. Owns the step model (order, metadata, navigation, progress), the
// per-step "can advance" gate, the family-name suggestion, and the mapping from
// the in-memory draft to the single atomic finalize payload. DB-free and
// deterministic so the whole flow is tested without React or Supabase; the wizard
// is a thin renderer over this, and the server action does the one write.

import type { MemberRole } from '@/lib/constants/roles';
import type { DraftMember } from './draft';
import type { BriefEvent } from './first-brief';
import { normalizeAge } from './pin';

export type OnboardingStep = 'profile' | 'family' | 'value' | 'about' | 'members' | 'pin' | 'done';

/**
 * Every step, in order. `done` is the terminal celebration (not a form).
 *
 * VALUE-FIRST (T1): after the two things we truly need (your name + a family
 * name), the `value` step imports the family's existing calendar and shows an
 * instant "here's your day/week" payoff — BEFORE we ask them to configure
 * household details, add members, or set a PIN. Everything after `value` is
 * optional/deferrable, so a new family feels the product working on day one.
 */
export const ONBOARDING_FLOW: OnboardingStep[] = ['profile', 'family', 'value', 'about', 'members', 'pin', 'done'];

/** Steps that count toward the progress bar (everything before the celebration). */
export const PROGRESS_STEPS: OnboardingStep[] = ONBOARDING_FLOW.filter((s) => s !== 'done');

export const STEP_META: Record<OnboardingStep, { title: string; subtitle: string }> = {
  profile: { title: 'Create your profile', subtitle: 'A name and a look — this is you inside Bubaly.' },
  family: { title: 'Name your family', subtitle: 'Your shared space where everything comes together.' },
  value: { title: 'See your week come together', subtitle: 'Bring in your calendar and Bubaly builds your first day instantly.' },
  about: { title: 'About your family', subtitle: 'A few details so Bubaly fits how your family runs.' },
  members: { title: 'Add your family', subtitle: 'Add people now or invite them by email — you can always do this later.' },
  pin: { title: 'Protect your profile', subtitle: 'An optional PIN keeps your profile private on shared devices.' },
  done: { title: "You're all set", subtitle: 'Welcome to Bubaly.' },
};

export function stepIndex(step: OnboardingStep): number {
  const i = ONBOARDING_FLOW.indexOf(step);
  return i < 0 ? 0 : i;
}

export function isFirstStep(step: OnboardingStep): boolean {
  return step === ONBOARDING_FLOW[0];
}

export function isLastFormStep(step: OnboardingStep): boolean {
  return step === 'pin';
}

/** Advance one step, clamping at the terminal `done`. */
export function nextStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_FLOW[Math.min(stepIndex(step) + 1, ONBOARDING_FLOW.length - 1)];
}

/** Go back one step, clamping at the first step. */
export function prevStep(step: OnboardingStep): OnboardingStep {
  return ONBOARDING_FLOW[Math.max(stepIndex(step) - 1, 0)];
}

/** Progress across the form steps as a 1..100 percentage (for the top bar). */
export function progressPct(step: OnboardingStep): number {
  const i = PROGRESS_STEPS.indexOf(step);
  if (i < 0) return 100; // done
  return Math.round(((i + 1) / PROGRESS_STEPS.length) * 100);
}

/** "Step 2 of 5" label for the current form step (done → the last index). */
export function stepCounter(step: OnboardingStep): { current: number; total: number } {
  const total = PROGRESS_STEPS.length;
  const i = PROGRESS_STEPS.indexOf(step);
  return { current: i < 0 ? total : i + 1, total };
}

/** Suggest a family name from the account holder's first name ("Jordan" → "The Jordan Family"). */
export function suggestFamilyName(firstName: string): string {
  const name = (firstName ?? '').trim().split(/\s+/)[0] ?? '';
  if (!name) return '';
  return `The ${name} Family`;
}

/** The full in-memory draft the wizard collects before the single atomic write. */
export interface OnboardingDraft {
  name: string;
  /** Last name carried from signup metadata (no UI field; preserved, not asked again). */
  lastName: string;
  age: string;
  avatarUrl: string;
  color: string;
  familyName: string;
  timezone: string;
  adults: number;
  children: number;
  childAges: number[];
  goals: string[];
  referralSource: string;
  referralDetail: string;
  members: DraftMember[];
  pin: string;
  confirmPin: string;
  /** Events imported in the `value` step (paste .ics or the sample week). */
  importedEvents: BriefEvent[];
  /** How the events were brought in: 'ics' | 'paste' | 'url' | 'demo' | '' (skipped). */
  importSource: string;
}

/** A blank draft (the wizard seeds `name`/`color` on top of this). */
export function emptyDraft(overrides: Partial<OnboardingDraft> = {}): OnboardingDraft {
  return {
    name: '', lastName: '', age: '', avatarUrl: '', color: '',
    familyName: '', timezone: 'UTC',
    adults: 1, children: 0, childAges: [],
    goals: [], referralSource: '', referralDetail: '',
    members: [], pin: '', confirmPin: '',
    importedEvents: [], importSource: '',
    ...overrides,
  };
}

/**
 * Whether the user may leave `step` given the current draft. Only the two steps
 * with a hard requirement gate: `profile` needs a name, `family` needs a family
 * name (≥2 chars). `about`/`members` are always skippable, and `pin` is optional
 * (an empty PIN is fine; a partial/mismatched one is not).
 */
export function canAdvance(step: OnboardingStep, draft: OnboardingDraft): boolean {
  switch (step) {
    case 'profile': return draft.name.trim().length >= 1;
    case 'family': return draft.familyName.trim().length >= 2;
    case 'value': return true;   // importing is optional — you can always skip
    case 'about': return true;
    case 'members': return true;
    case 'pin': {
      const pin = draft.pin.trim();
      if (pin.length === 0) return true;                    // skipping is fine
      return /^\d{4}$/.test(pin) && pin === draft.confirmPin.trim();
    }
    case 'done': return true;
  }
}

/** sessionStorage key for the resumable wizard draft (versioned). */
export const DRAFT_STORAGE_KEY = 'bubaly.onboarding.draft.v1';

export interface PersistedDraftState {
  step: OnboardingStep;
  draft: OnboardingDraft;
  familyNameTouched: boolean;
}

/**
 * Serialize the resumable wizard state for sessionStorage. The PIN is
 * deliberately NOT persisted — a refresh keeps your family details but never
 * stashes the (soon-to-be-hashed) App Lock PIN in web storage.
 */
export function serializeDraftState(step: OnboardingStep, draft: OnboardingDraft, familyNameTouched: boolean): string {
  // Never stash the PIN in web storage; and drop imported events (they can be
  // large — a full calendar — and are trivially re-imported, so persisting them
  // would risk the sessionStorage quota for no real benefit).
  const safeDraft: OnboardingDraft = { ...draft, pin: '', confirmPin: '', importedEvents: [], importSource: '' };
  return JSON.stringify({ v: 1, step, familyNameTouched, draft: safeDraft });
}

/**
 * Parse persisted wizard state. Returns null for anything unexpected (bad JSON,
 * old version, unknown/terminal step) so a corrupt value never breaks the wizard
 * — it just starts fresh. Missing fields fall back to an empty draft's defaults.
 */
export function parseDraftState(raw: string | null | undefined): PersistedDraftState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || o.v !== 1 || typeof o.draft !== 'object' || o.draft === null) return null;
    const step = o.step as OnboardingStep;
    if (!ONBOARDING_FLOW.includes(step) || step === 'done') return null; // never resume onto the celebration
    const d = o.draft as Partial<OnboardingDraft>;
    const draft: OnboardingDraft = {
      ...emptyDraft(),
      ...d,
      members: Array.isArray(d.members) ? d.members : [],
      childAges: Array.isArray(d.childAges) ? d.childAges : [],
      goals: Array.isArray(d.goals) ? d.goals : [],
      importedEvents: [], importSource: '',
      pin: '', confirmPin: '',
    };
    return { step, draft, familyNameTouched: !!o.familyNameTouched };
  } catch {
    return null;
  }
}

/** The payload for `finalizeOnboardingAction`, built purely from the draft. */
export interface FinalizePayload {
  profile: { firstName: string; lastName: string; phone: string; email: string; avatarUrl?: string };
  family: { name: string; timezone: string };
  details: {
    householdAdults: number; householdChildren: number; childAges: number[];
    region?: string; postalCode?: string; country?: string;
    goals: string[]; referralSource?: string; referralDetail?: string;
  };
  members: Array<
    | { kind: 'local'; name: string; role: MemberRole; birthday?: string; color?: string }
    | { kind: 'invite'; email: string; role: MemberRole }
  >;
  appearance: { color?: string; age?: number | null; avatarUrl?: string; pin?: string };
  /** Calendar imported in the value step — persisted to calendar_events at finalize. */
  calendarImport: { source: string; events: BriefEvent[] };
}

/**
 * Map the collected draft to the single finalize action's input. Child ages are
 * normalized/clamped; the PIN is only included when valid; empty optionals are
 * passed through as '' so the schema's fallbacks kick in.
 *
 * Ages of 0 are treated as "not provided" and dropped: the wizard's age inputs
 * render 0 as an empty field (a real 0 can't be expressed), and the Kids stepper
 * pre-fills unanswered slots with 0 — persisting those would record phantom
 * infants in family_onboarding.
 */
export function buildFinalizePayload(draft: OnboardingDraft): FinalizePayload {
  const firstName = draft.name.trim();
  const validPin = /^\d{4}$/.test(draft.pin.trim()) && draft.pin.trim() === draft.confirmPin.trim();
  const childAges = draft.childAges
    .slice(0, 20)
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 21);
  return {
    profile: { firstName, lastName: draft.lastName.trim(), phone: '', email: '', avatarUrl: draft.avatarUrl || undefined },
    family: { name: draft.familyName.trim() || suggestFamilyName(firstName), timezone: draft.timezone || 'UTC' },
    details: {
      householdAdults: Math.max(0, draft.adults),
      householdChildren: Math.max(0, draft.children),
      childAges,
      goals: draft.goals,
      referralSource: draft.referralSource || undefined,
      referralDetail: draft.referralDetail || undefined,
    },
    members: draft.members.map((m) =>
      m.kind === 'invite'
        ? { kind: 'invite' as const, email: m.email, role: m.role }
        : { kind: 'local' as const, name: m.name, role: m.role, birthday: m.birthday, color: m.color }),
    appearance: {
      color: draft.color || undefined,
      age: normalizeAge(draft.age),
      avatarUrl: draft.avatarUrl || undefined,
      pin: validPin ? draft.pin.trim() : undefined,
    },
    calendarImport: {
      source: draft.importSource || '',
      // Cap what we ship to finalize so a giant paste can't bloat the request.
      events: (draft.importedEvents ?? []).slice(0, 1000),
    },
  };
}
