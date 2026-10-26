'use client';

// Settings card to turn the App Lock on/off and set or change the 4-digit PIN.
// The PIN is sent only to the server action over the authenticated connection.
// Its verifier stays in private server storage; this card reads only status.
// Whether this browser is unlocked is an httpOnly cookie the server actions set
// and clear; this card cannot touch it, and does not need to.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { isValidPin } from '@/lib/security/app-lock';
import { getAppLockSettings, saveAppLockConfig } from '@/app/(app)/settings/app-lock-actions';
import { notifyAppLockSettingsChanged, requestAppLock } from '@/lib/security/app-lock-browser';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export function AppLockSettings() {
  const t = useTranslations();
  const { userId } = useApp();
  const { success, error: toastError } = useToast();
  const [config, setConfig] = useState<{ enabled: boolean; hasPin: boolean } | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);
  const owner = useRef(userId);
  owner.current = userId;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const hasPin = config?.hasPin ?? false;
  const enabled = config?.enabled ?? false;

  useEffect(() => {
    let active = true;
    setConfig(undefined);
    setLoadError(null);
    void (async () => {
      try {
        const result = await getAppLockSettings();
        if (!active) return;
        if (!result.ok) { setLoadError(result.error); return; }
        setConfig({ enabled: result.enabled, hasPin: result.hasPin });
      } catch {
        if (active) setLoadError(t('appLockSettings.couldNotLoad'));
      }
    })();
    return () => { active = false; };
  }, [userId, t]);

  async function save(cfg: { enabled: boolean; pin?: string }) {
    try {
      return await saveAppLockConfig(cfg);
    } catch (error: unknown) {
      console.error('[app-lock] save did not complete', error);
      return { ok: false as const, error: t('appLockActions.couldNotSaveAppLockSettings') };
    }
  }

  async function setEnabled(value: boolean) {
    if (!config?.hasPin || busy.current || !mounted.current) return;
    busy.current = true;
    const savedFor = userId;
    setSaving(true);
    const res = await save({ enabled: value });
    if (!mounted.current || owner.current !== savedFor) return;
    busy.current = false;
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    setConfig({ enabled: value, hasPin: true });
    success(value ? t('appLockSettings.appLockIsOn') : t('appLockSettings.appLockTurnedOff'));
    notifyAppLockSettingsChanged(savedFor);
  }

  function lockNow() {
    if (busy.current || !mounted.current) return;
    busy.current = true;
    // This synchronously retires every mounted private subtree before the
    // network request. A failed request stays on the gate and offers retry.
    void requestAppLock(userId);
  }

  async function onSet(pin: string) {
    if (busy.current || !mounted.current) return;
    busy.current = true;
    const savedFor = userId;
    setSaving(true);
    const nextEnabled = hasPin ? enabled : true;
    const res = await save({ enabled: nextEnabled, pin });
    if (!mounted.current || owner.current !== savedFor) return;
    busy.current = false;
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    setConfig({ enabled: nextEnabled, hasPin: true });
    setModalOpen(false);
    success(nextEnabled ? t('appLockSettings.appLockIsOn') : t('appLockSettings.pinUpdated'));
    notifyAppLockSettingsChanged(savedFor);
  }

  return (
    <div id="app-lock" className="scroll-mt-20 rounded-2xl border border-border bg-surface/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t('appLockSettings.appLock')}</h3>
            <p className="mt-0.5 max-w-md text-xs text-muted">{t('appLockSettings.requireA4DigitPin')}</p>
            {enabled ? (
              <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" /> {t('appLockSettings.on')}
              </p>
            ) : hasPin ? (
              <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted">
                <ShieldCheck className="h-3.5 w-3.5" /> {t('appLockSettings.pinReadyAppLockIsOff')}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {loadError ? (
            // The family reads what happened in their language; the raw error
            // ("TypeError: Failed to fetch") stays on hover and in the log.
            <span role="alert" title={loadError} className="max-w-[16rem] text-right text-xs text-danger">{t('appLockSettings.couldNotLoad')}</span>
          ) : config === undefined ? (
            <span className="text-xs text-muted">…</span>
          ) : enabled ? (
            <>
              <Button size="sm" variant="outline" onClick={lockNow} disabled={saving}>{t('appLockSettings.lockNow')}</Button>
              <Button size="sm" variant="outline" onClick={() => setModalOpen(true)} disabled={saving}>{t('appLockSettings.changePin')}</Button>
              <button onClick={() => setEnabled(false)} disabled={saving} className="text-xs font-medium text-muted hover:text-rose-400 disabled:opacity-50">{t('appLockSettings.turnOff')}</button>
            </>
          ) : hasPin ? (
            <>
              <Button size="sm" onClick={() => setEnabled(true)} disabled={saving}>{t('appLockSettings.turnOn')}</Button>
              <button onClick={() => setModalOpen(true)} disabled={saving} className="text-xs font-medium text-muted hover:text-fg disabled:opacity-50">{t('appLockSettings.changePin')}</button>
            </>
          ) : (
            <Button size="sm" onClick={() => setModalOpen(true)} disabled={saving}>{t('appLockSettings.setUpPin')}</Button>
          )}
        </div>
      </div>

      {modalOpen && (
        <SetPinModal
          onClose={() => { if (!saving) setModalOpen(false); }}
          onConfirm={onSet}
          saving={saving}
          confirmLabel={hasPin && !enabled ? t('appLockSettings.savePin') : t('appLockSettings.turnOn')}
        />
      )}
    </div>
  );
}

function SetPinModal({ onClose, onConfirm, saving, confirmLabel }: { onClose: () => void; onConfirm: (pin: string) => void; saving: boolean; confirmLabel: string }) {
  const t = useTranslations();
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [first, setFirst] = useState('');
  const [val, setVal] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function next(pin: string) {
    if (saving) return;
    if (!isValidPin(pin)) { setErr(t('appLockSettings.enterExactly4Digits')); return; }
    if (step === 'enter') { setFirst(pin); setVal(''); setErr(null); setStep('confirm'); return; }
    if (pin !== first) { setErr(t('appLockSettings.pinsDidNotMatch')); setVal(''); setStep('enter'); return; }
    setFirst(''); setVal(''); setStep('enter');
    onConfirm(pin);
  }

  return (
    <Modal open title={step === 'enter' ? t('appLockSettings.setA4DigitPin') : t('appLockSettings.confirmYourPin')} onClose={onClose}>
      <div className="flex flex-col items-center gap-5 py-2">
        <p className="text-sm text-muted">{step === 'enter' ? t('appLockSettings.chooseAPinToLock') : t('appLockSettings.enterItAgainToConfirm')}</p>
        <input
          autoFocus type="password" autoComplete="new-password" inputMode="numeric" pattern="\d*" maxLength={4} value={val} disabled={saving}
          aria-label={step === 'enter' ? t('appLockSettings.setA4DigitPin') : t('appLockSettings.confirmYourPin')}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setVal(v); setErr(null); if (v.length === 4) next(v); }}
          className="w-40 rounded-xl border border-border bg-surface/60 py-3 text-center text-3xl tracking-[0.6em] outline-none focus:border-brand"
          placeholder="••••"
        />
        {err && <p className={cn('text-xs font-medium', 'text-rose-400')}>{err}</p>}
        <div className="flex w-full justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>{t('appLockSettings.cancel')}</Button>
          <Button type="button" size="sm" loading={saving} disabled={saving || val.length !== 4} onClick={() => next(val)}>
            {step === 'enter' ? t('appLockSettings.next') : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
