'use client';

// Settings card to turn the App Lock on/off and set or change the 4-digit PIN.
// The PIN is hashed on the client (buildAppLockConfig); only { enabled, salt, hash }
// is sent to the server action — the plaintext PIN never leaves the device.
import { useEffect, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from '@/components/app/app-context';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { buildAppLockConfig, isValidPin, isAppLockConfig, unlockKey, type AppLockConfig } from '@/lib/security/app-lock';
import { saveAppLockConfig } from '@/app/(app)/settings/app-lock-actions';
import { cn } from '@/lib/utils/cn';

export function AppLockSettings() {
  const { userId } = useApp();
  const { success, error: toastError } = useToast();
  // undefined = loading, null = no PIN ever set, otherwise the stored config.
  const [config, setConfig] = useState<AppLockConfig | null | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasPin = !!config;            // a PIN exists (may be on or off)
  const enabled = config?.enabled ?? false;

  // Load current config directly from the user's own preferences. The PIN may have
  // been seeded (disabled) during onboarding, so we keep the full config — flipping
  // it on later must not require re-entering the PIN.
  useEffect(() => {
    let active = true;
    void createClient()
      .from('user_preferences').select('notification_prefs').eq('user_id', userId).maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        const cfg = (data?.notification_prefs as Record<string, unknown> | null)?.appLock;
        setConfig(isAppLockConfig(cfg) ? cfg : null);
      });
    return () => { active = false; };
  }, [userId]);

  // Flip an EXISTING config on/off without re-hashing. Turning off keeps the salt +
  // hash so the user can turn it back on with one tap (the seed-and-opt-in model).
  async function setEnabled(value: boolean) {
    if (!config) return;
    const next = { ...config, enabled: value };
    setSaving(true);
    const res = await saveAppLockConfig(next);
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    try {
      // This device is already authenticated — never lock yourself out on toggle.
      if (value) sessionStorage.setItem(unlockKey(userId), '1');
      else sessionStorage.removeItem(unlockKey(userId));
    } catch { /* ignore */ }
    setConfig(next);
    success(value ? 'App Lock is on' : 'App Lock turned off');
  }

  // Re-lock immediately on this device: drop the session unlock flag and reload so
  // the gate renders the PIN screen again.
  function lockNow() {
    try { sessionStorage.removeItem(unlockKey(userId)); } catch { /* ignore */ }
    window.location.reload();
  }

  async function onSet(pin: string) {
    setSaving(true);
    const cfg = await buildAppLockConfig(pin); // enabled: true
    const res = await saveAppLockConfig(cfg);
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    // This device is already authenticated — count it as unlocked for this session.
    try { sessionStorage.setItem(unlockKey(userId), '1'); } catch { /* ignore */ }
    setConfig(cfg);
    setModalOpen(false);
    success('App Lock is on');
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">App Lock</h3>
            <p className="mt-0.5 max-w-md text-xs text-muted">
              Require a 4-digit PIN to open Bubaly on this browser. Handy when you share a device.
              You can always sign out from the lock screen if you forget it.
            </p>
            {enabled ? (
              <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" /> On
              </p>
            ) : hasPin ? (
              <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted">
                <ShieldCheck className="h-3.5 w-3.5" /> PIN ready — App Lock is off
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {config === undefined ? (
            <span className="text-xs text-muted">…</span>
          ) : enabled ? (
            <>
              <Button size="sm" variant="outline" onClick={lockNow} disabled={saving}>Lock now</Button>
              <Button size="sm" variant="outline" onClick={() => setModalOpen(true)} disabled={saving}>Change PIN</Button>
              <button onClick={() => setEnabled(false)} disabled={saving} className="text-xs font-medium text-muted hover:text-rose-400 disabled:opacity-50">Turn off</button>
            </>
          ) : hasPin ? (
            <>
              <Button size="sm" onClick={() => setEnabled(true)} disabled={saving}>Turn on</Button>
              <button onClick={() => setModalOpen(true)} disabled={saving} className="text-xs font-medium text-muted hover:text-fg disabled:opacity-50">Change PIN</button>
            </>
          ) : (
            <Button size="sm" onClick={() => setModalOpen(true)} disabled={saving}>Set up PIN</Button>
          )}
        </div>
      </div>

      {modalOpen && <SetPinModal onClose={() => setModalOpen(false)} onConfirm={onSet} saving={saving} />}
    </div>
  );
}

function SetPinModal({ onClose, onConfirm, saving }: { onClose: () => void; onConfirm: (pin: string) => void; saving: boolean }) {
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [first, setFirst] = useState('');
  const [val, setVal] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function next(pin: string) {
    if (!isValidPin(pin)) { setErr('Enter exactly 4 digits'); return; }
    if (step === 'enter') { setFirst(pin); setVal(''); setErr(null); setStep('confirm'); return; }
    if (pin !== first) { setErr('PINs didn’t match — try again'); setVal(''); setStep('enter'); return; }
    onConfirm(pin);
  }

  return (
    <Modal open title={step === 'enter' ? 'Set a 4-digit PIN' : 'Confirm your PIN'} onClose={onClose}>
      <div className="flex flex-col items-center gap-5 py-2">
        <p className="text-sm text-muted">{step === 'enter' ? 'Choose a PIN to lock the app.' : 'Enter it again to confirm.'}</p>
        <input
          autoFocus inputMode="numeric" pattern="\d*" maxLength={4} value={val}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setVal(v); setErr(null); if (v.length === 4) next(v); }}
          className="w-40 rounded-xl border border-border bg-surface/60 py-3 text-center text-3xl tracking-[0.6em] outline-none focus:border-brand/50"
          placeholder="••••"
        />
        {err && <p className={cn('text-xs font-medium', 'text-rose-400')}>{err}</p>}
        <div className="flex w-full justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" loading={saving} disabled={saving || val.length !== 4} onClick={() => next(val)}>
            {step === 'enter' ? 'Next' : 'Turn on'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
