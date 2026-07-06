'use client';

// Onboarding journey — mirrors the product mockups (post sign-in):
//   1) Create your profile  — avatar, name, age, colour
//   2) Create a PIN         — 4-digit, confirm, tips
//   3) You're all set       — summary → straight to the dashboard
// One atomic write at the end (completeProfileOnboardingAction) provisions the
// family space too, so there is no separate setup wizard and no redirect loop.
import { useState, useEffect } from 'react';
import { trackOnboarding } from '@/lib/analytics/onboarding-track';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck, Users, Sparkles, ArrowRight, Eye, EyeOff, Check, Loader2, Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AvatarPicker } from '@/components/ui/avatar-picker';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { MEMBER_COLORS } from '@/lib/onboarding/draft';
import { normalizePin, isValidPin, isWeakPin } from '@/lib/onboarding/pin';
import { completeProfileOnboardingAction } from '@/app/onboarding/actions';

type Step = 'profile' | 'pin' | 'done';
const STEPS: Step[] = ['profile', 'pin', 'done'];

export function OnboardingWizard({ initialName = '' }: { initialName?: string }) {
  const router = useRouter();
  const { error: toastError } = useToast();

  const [step, setStep] = useState<Step>('profile');
  const [name, setName] = useState(initialName);
  const [age, setAge] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [color, setColor] = useState(MEMBER_COLORS[0]);

  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [saving, setSaving] = useState(false);

  const firstName = name.trim().split(' ')[0] || 'there';
  const pinMatches = isValidPin(pin) && pin === confirm;

  // Pre-family funnel telemetry (onboarding has no family_id yet).
  useEffect(() => { trackOnboarding('profile', 'started'); }, []);

  // `usePin` lets the user reach first value now and add a PIN later — the
  // server action already treats an absent PIN as valid (defer, don't block).
  async function finish(usePin: boolean) {
    setSaving(true);
    const res = await completeProfileOnboardingAction({
      firstName: name.trim(),
      age: age || null,
      avatarUrl: avatarUrl || undefined,
      color,
      pin: usePin && isValidPin(pin) ? pin : undefined,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Something went wrong');
    trackOnboarding('done', 'completed');
    setStep('done');
  }

  return (
    <div className="rounded-3xl border border-border bg-surface/40 p-6 sm:p-8">
      {/* progress dots */}
      <div className="mb-6 flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <span key={s}
            className={cn('h-1.5 rounded-full transition-all',
              step === s ? 'w-8 bg-brand' : i < STEPS.indexOf(step) ? 'w-4 bg-brand/50' : 'w-4 bg-border')} />
        ))}
      </div>

      {step === 'profile' && (
        <div>
          <h1 className="text-center text-2xl font-bold">Create your profile</h1>
          <p className="mx-auto mt-1 max-w-sm text-center text-sm text-muted">
            Tell us a little about yourself so we can personalize your experience.
          </p>

          <div className="mt-6 flex justify-center">
            <AvatarPicker displayName={name || 'You'} defaultValue={avatarUrl} onChange={setAvatarUrl} />
          </div>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Your name <span className="text-brand">*</span></span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Jordan"
                className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring" />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium">How old are you?</span>
              <select value={age} onChange={(e) => setAge(e.target.value)}
                className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
                <option value="">Prefer not to say</option>
                {Array.from({ length: 99 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>

            <div>
              <span className="mb-2 block text-sm font-medium">Choose a color</span>
              <div className="flex flex-wrap gap-2.5">
                {MEMBER_COLORS.map((c) => (
                  <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => setColor(c)}
                    className={cn('grid h-9 w-9 place-items-center rounded-full transition', color === c && 'ring-2 ring-white/70')}
                    style={{ backgroundColor: c }}>
                    {color === c && <Check className="h-4 w-4 text-white" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Button className="mt-7 w-full" disabled={!name.trim()} onClick={() => { trackOnboarding('pin', 'step'); setStep('pin'); }}>
            Continue
          </Button>
        </div>
      )}

      {step === 'pin' && (
        <div>
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand"><Lock className="h-7 w-7" /></div>
          <h1 className="text-center text-2xl font-bold">Add a PIN for {firstName}?</h1>
          <p className="mx-auto mt-1 max-w-sm text-center text-sm text-muted">
            Optional — a PIN keeps {firstName}&rsquo;s profile private. You can skip this and add one
            anytime in Settings.
          </p>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Create 4-digit PIN <span className="text-brand">*</span></span>
              <div className="relative">
                <input value={pin} onChange={(e) => setPin(normalizePin(e.target.value))} inputMode="numeric"
                  type={showPin ? 'text' : 'password'} placeholder="••••"
                  className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
                <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg">
                  {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Confirm PIN <span className="text-brand">*</span></span>
              <input value={confirm} onChange={(e) => setConfirm(normalizePin(e.target.value))} inputMode="numeric"
                type={showPin ? 'text' : 'password'} placeholder="••••"
                className="h-12 w-full rounded-xl border border-border bg-bg px-3 text-center text-lg tracking-[0.5em] focus-ring" />
            </label>

            {confirm.length === 4 && pin !== confirm && (
              <p className="text-xs text-danger">PINs don&rsquo;t match.</p>
            )}
            {isValidPin(pin) && isWeakPin(pin) && (
              <p className="text-xs text-amber-500">That PIN is easy to guess — consider a less obvious one.</p>
            )}

            <div className="rounded-xl border border-border bg-bg/50 p-3">
              <p className="mb-1.5 text-xs font-semibold text-muted">PIN tips</p>
              <ul className="space-y-1 text-xs text-muted">
                <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand" /> Use 4 different numbers</li>
                <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand" /> Avoid birthdays or repeating numbers</li>
                <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-brand" /> Easy for you, hard for others to guess</li>
              </ul>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <Button variant="secondary" onClick={() => setStep('profile')}>Back</Button>
            <Button className="flex-1" disabled={!pinMatches || saving} onClick={() => finish(true)}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Continue
            </Button>
          </div>
          <button type="button" onClick={() => finish(false)} disabled={saving}
            className="mt-3 w-full text-center text-sm font-medium text-muted transition hover:text-fg disabled:opacity-50">
            Skip for now
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className="text-center">
          <div className="relative mx-auto h-24 w-24">
            <span className="grid h-24 w-24 place-items-center rounded-full text-3xl font-bold text-white" style={{ backgroundColor: color }}>
              {firstName.slice(0, 1).toUpperCase()}
            </span>
            <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full bg-emerald-500 text-white ring-4 ring-surface">
              <Check className="h-4 w-4" />
            </span>
          </div>
          <h1 className="mt-4 text-2xl font-bold">You&rsquo;re all set, {firstName}!</h1>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Your profile has been created successfully. Welcome to the Bubaly family!
          </p>

          <div className="mt-6 space-y-3 text-left">
            {[
              { icon: ShieldCheck, title: 'Safe & secure', body: 'Your information is protected with top-level security.' },
              { icon: Users, title: 'Family connected', body: 'You can now connect, share and explore together.' },
              { icon: Sparkles, title: 'Let the fun begin!', body: 'Explore Bubaly and create amazing memories.' },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3 rounded-xl border border-border bg-bg/40 p-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand"><Icon className="h-4 w-4" /></div>
                <div><p className="text-sm font-semibold">{title}</p><p className="text-xs text-muted">{body}</p></div>
              </div>
            ))}
          </div>

          <Button className="mt-7 w-full" onClick={() => { router.push('/dashboard'); router.refresh(); }}>
            Start exploring <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
